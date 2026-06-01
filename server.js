const express    = require("express");
const mongoose   = require("mongoose");
const multer     = require("multer");
const fs         = require("fs");
const cors       = require("cors");
const bcrypt     = require("bcrypt");
const jwt        = require("jsonwebtoken");
const crypto     = require("crypto");
const nodemailer = require("nodemailer");
require("dotenv").config();

/* ═══════════════════════════════════════════════════════════
   VENATRIX SERVER v3.1  —  MongoDB Atlas Edition
   Users are embedded inside Institute documents.
   OTP / notif / key-cooldown stay in-memory (ephemeral).
═══════════════════════════════════════════════════════════ */

const SECRET       = process.env.JWT_SECRET || "venatrix_supersecret_2025";
const OTP_TTL      = 10 * 60 * 1000;
const KEY_COOLDOWN = 24 * 60 * 60 * 1000;

// ─── IN-MEMORY STORES ─────────────────────────────────────
const otpStore         = new Map();
const notifStore       = new Map();
const keyGenTimestamps = new Map();

function pushNotif(username, msg) {
  if (!username) return;
  if (!notifStore.has(username)) notifStore.set(username, []);
  const list = notifStore.get(username);
  list.unshift({ msg, time: Date.now(), read: false });
  if (list.length > 50) list.pop();
}

// ─── EMAIL ────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true",
  auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendEmail(to, subject, html) {
  try {
    const info = await transporter.sendMail({
      from: `"Venatrix" <${process.env.SMTP_USER}>`,
      to, subject, html
    });
    console.log("📧 Email sent:", info.messageId);
    return { ok: true };
  } catch(e) {
    console.error("📧 Email failed:", e.message);
    return { ok: false };
  }
}

// ─── EXPRESS ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));
const upload = multer({ dest: "uploads/" });

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send("No token");
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { return res.status(401).send("Invalid or expired token"); }
}

/* ═══════════════════════════════════════════════════════════
   SCHEMAS
═══════════════════════════════════════════════════════════ */
const UserSubSchema = new mongoose.Schema({
  username:       { type: String, required: true },
  password:       { type: String, required: true },
  role:           { type: String, required: true },
  email:          { type: String, default: "" },
  signingKey:     { type: String, default: null },
  keyFingerprint: { type: String, default: null },
  keyGeneratedAt: { type: String, default: null }
}, { _id: false });

const InstituteSchema = new mongoose.Schema({
  name:   { type: String, required: true, unique: true },
  domain: { type: String, default: "" },
  roles:  { type: [String], default: ["ADMIN"] },
  users:  { type: [UserSubSchema], default: [] }
});
const Institute = mongoose.model("Institute", InstituteSchema);

const DocumentSchema = new mongoose.Schema({
  id:               { type: Number, required: true, unique: true },
  name:             String,
  type:             { type: String, default: "general" },
  flow:             [String],
  currentStep:      { type: Number, default: 0 },
  status:           { type: String, default: "Pending" },
  uploadedBy:       { type: String, default: "" },
  uploadedAt:       { type: String, default: "" },
  rejected:         { type: Boolean, default: false },
  rejectionComment: { type: String, default: "" },
  signedBy:         { type: [String], default: [] },
  signatures:       { type: mongoose.Schema.Types.Mixed, default: {} },
  file:             { type: String, default: "" },
  assignedTo:       { type: String, default: "" }
});
const Document = mongoose.model("Document", DocumentSchema);

const WorkflowSchema = new mongoose.Schema({
  type: { type: String, required: true, unique: true },
  flow: [String]
});
const Workflow = mongoose.model("Workflow", WorkflowSchema);

/* ═══════════════════════════════════════════════════════════
   DB CONNECT + SEED
   Safely parses institutes.json even if it has the broken
   "[...][...]" double-array format from the old codebase.
═══════════════════════════════════════════════════════════ */
async function connectDB() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ MongoDB Atlas connected");
  await seed();
}

function parseInstituteFile() {
  if (!fs.existsSync("institutes.json")) return null;
  try {
    const raw = fs.readFileSync("institutes.json", "utf8").trim();
    // Handle broken "[...][...]" format — take only the first valid JSON array
    const firstArrayEnd = raw.indexOf("]");
    const clean = firstArrayEnd !== -1 ? raw.substring(0, firstArrayEnd + 1) : raw;
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch(e) {
    console.error("⚠️  Could not parse institutes.json:", e.message);
    return null;
  }
}

async function seed() {
  // ── Institutes / users ──
  const instCount = await Institute.countDocuments();
  if (instCount === 0) {
    const data = parseInstituteFile();
    if (data && data.length) {
      // Filter out any entries that are plain user arrays (not institute objects)
      const validInsts = data.filter(i => i && i.name && i.domain !== undefined);
      if (validInsts.length) {
        await Institute.insertMany(validInsts);
        const totalUsers = validInsts.reduce((sum, i) => sum + (i.users||[]).length, 0);
        console.log(`🌱 Seeded ${validInsts.length} institute(s) with ${totalUsers} users from institutes.json`);
      }
    } else {
      console.log("ℹ️  No institutes.json to seed from");
    }
  } else {
    console.log(`ℹ️  Institutes already in DB (${instCount}) — skipping seed`);
  }

  // ── Documents ──
  if ((await Document.countDocuments()) === 0 && fs.existsSync("data.json")) {
    try {
      const data = JSON.parse(fs.readFileSync("data.json", "utf8"));
      if (data.length) {
        await Document.insertMany(data);
        console.log(`🌱 Seeded ${data.length} document(s) from data.json`);
      }
    } catch(e) { console.error("Seed documents failed:", e.message); }
  }

  // ── Workflows ──
  if ((await Workflow.countDocuments()) === 0 && fs.existsSync("workflows.json")) {
    try {
      const data = JSON.parse(fs.readFileSync("workflows.json", "utf8"));
      if (data.length) {
        await Workflow.insertMany(data);
        console.log(`🌱 Seeded ${data.length} workflow(s) from workflows.json`);
      }
    } catch(e) { console.error("Seed workflows failed:", e.message); }
  }

  console.log("✅ Seed check complete");
}

/* ═══════════════════════════════════════════════════════════
   HELPER — notify all users with a given role
═══════════════════════════════════════════════════════════ */
async function notifyRole(docName, role, msg) {
  try {
    const institutes = await Institute.find({});
    institutes.forEach(inst =>
      inst.users.filter(u => u.role === role).forEach(u => pushNotif(u.username, msg))
    );
  } catch(e) {}
}

/* ═══════════════════════════════════════════════════════════
   AUTH ROUTES
═══════════════════════════════════════════════════════════ */

// ── SEND OTP ──────────────────────────────────────────────
app.post("/send-otp", async (req, res) => {
  const { username, password, email, institute } = req.body;
  if (!username || !password || !email || !institute)
    return res.status(400).send("All fields required");

  try {
    const inst = await Institute.findOne({ name: institute });
    if (!inst) return res.status(400).send("Invalid institute");

    const domain = inst.domain || "rvce.edu.in";
    if (!email.endsWith("@" + domain))
      return res.status(400).send(`Only @${domain} emails are allowed`);

    if (inst.users.find(u => u.username === username))
      return res.status(400).send("Username already taken");
    if (inst.users.find(u => u.email === email))
      return res.status(400).send("Email already registered");

    const otp       = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = Date.now() + OTP_TTL;
    otpStore.set(email, { otp, expiresAt, data: { username, password, email, institute } });

    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#04050f;color:#e8eeff;border-radius:16px;">
        <div style="font-family:monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:#00e5c8;margin-bottom:8px;">VENATRIX</div>
        <div style="font-size:14px;color:#8899bb;margin-bottom:32px;">Intelligent Information Flow</div>
        <div style="font-size:16px;margin-bottom:16px;">Hi <strong>${username}</strong>, here is your verification code:</div>
        <div style="background:#0d1225;border:1px solid rgba(0,229,200,0.2);border-radius:12px;padding:20px 32px;text-align:center;margin:24px 0;">
          <div style="font-family:monospace;font-size:40px;font-weight:700;letter-spacing:12px;color:#00e5c8;">${otp}</div>
        </div>
        <div style="font-size:13px;color:#4a5880;">Expires in <strong style="color:#e8eeff">10 minutes</strong>.</div>
      </div>`;

    console.log(`🔑 OTP for ${email}: ${otp}`);
    await sendEmail(email, "Your Venatrix Verification Code", html);
    res.send("OTP sent");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

// ── VERIFY OTP ────────────────────────────────────────────
app.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).send("Email and OTP required");

  const record = otpStore.get(email);
  if (!record) return res.status(400).send("OTP not found or expired. Request a new one.");
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.status(400).send("OTP expired. Request a new one.");
  }
  if (record.otp !== String(otp).trim()) return res.status(400).send("Incorrect OTP. Try again.");
  otpStore.delete(email);

  const { username, password, institute } = record.data;
  try {
    const inst = await Institute.findOne({ name: institute });
    if (!inst) return res.status(400).send("Institute not found");
    if (inst.users.find(u => u.username === username))
      return res.status(400).send("Username already taken");

    const hashed = await bcrypt.hash(password, 10);
    inst.users.push({ username, password: hashed, role: "PENDING", email });
    await inst.save();

    // Notify admins
    inst.users.filter(u => u.role === "ADMIN")
      .forEach(a => pushNotif(a.username, `🆕 New signup awaiting approval: "${username}"`));

    console.log(`📝 New pending user: ${username} @ ${institute}`);
    res.send("Signup complete. Awaiting admin approval.");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

// ── LOGIN ─────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { username, password, institute } = req.body;
  if (!username || !password) return res.status(400).send("Username and password required");

  try {
    const inst = await Institute.findOne({ name: institute });
    if (!inst) return res.status(400).send("Invalid institute");

    const user = inst.users.find(u => u.username === username);
    if (!user) return res.status(401).send("User not found");
    if (user.role === "PENDING") return res.status(403).send("Account pending admin approval");

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).send("Incorrect password");

    const token = jwt.sign(
      { username: user.username, role: user.role, institute: inst.name },
      SECRET,
      { expiresIn: "8h" }
    );
    pushNotif(username, `You logged in as ${user.role}`);
    res.json({ token });
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

/* ═══════════════════════════════════════════════════════════
   NOTIFICATIONS
═══════════════════════════════════════════════════════════ */
app.get("/notifications/stream", auth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const { username } = req.user;
  let lastCount = 0;
  const interval = setInterval(() => {
    const notifs = notifStore.get(username) || [];
    const unread = notifs.filter(n => !n.read).length;
    if (unread !== lastCount) {
      lastCount = unread;
      res.write(`data: ${JSON.stringify({ unread, notifs })}\n\n`);
    }
  }, 2000);
  req.on("close", () => clearInterval(interval));
});

app.get("/notifications", auth, (req, res) => {
  res.json(notifStore.get(req.user.username) || []);
});

app.post("/notifications/read", auth, (req, res) => {
  (notifStore.get(req.user.username) || []).forEach(n => (n.read = true));
  res.send("OK");
});

/* ═══════════════════════════════════════════════════════════
   ROLES
═══════════════════════════════════════════════════════════ */
app.post("/create-role", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");
  const { role, institute } = req.body;
  if (!role) return res.status(400).send("Role required");
  const r = role.trim().toUpperCase();
  if (r === "ADMIN") return res.status(400).send("ADMIN role is reserved");
  try {
    const inst = await Institute.findOne({ name: institute || req.user.institute });
    if (!inst) return res.status(400).send("Institute not found");
    if (!inst.roles.includes(r)) { inst.roles.push(r); await inst.save(); }
    res.send("Role created");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

app.get("/roles/:institute", auth, async (req, res) => {
  try {
    const inst = await Institute.findOne({ name: req.params.institute });
    if (!inst) return res.status(404).send("Institute not found");
    res.json(inst.roles);
  } catch(e) { res.status(500).send("Server error"); }
});

/* ═══════════════════════════════════════════════════════════
   USERS
═══════════════════════════════════════════════════════════ */

// GET /users/:institute  — used by dashboard
app.get("/users/:institute", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");
  try {
    const inst = await Institute.findOne({ name: req.params.institute });
    if (!inst) return res.status(404).send("Institute not found");
    res.json(inst.users.map(u => ({
      username:  u.username,
      role:      u.role,
      email:     u.email || ""
    })));
  } catch(e) { res.status(500).send("Server error"); }
});

// POST /create-user — admin manually adds a user
app.post("/create-user", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");
  const { username, password, role, institute } = req.body;
  if (!username || !password || !role) return res.status(400).send("All fields required");
  if (role.toUpperCase() === "ADMIN") return res.status(400).send("Cannot create ADMIN via this form");
  try {
    const inst = await Institute.findOne({ name: institute || req.user.institute });
    if (!inst) return res.status(400).send("Invalid institute");
    if (inst.users.find(u => u.username === username))
      return res.status(400).send("User already exists");
    if (!inst.roles.includes(role.toUpperCase()))
      return res.status(400).send(`Role "${role.toUpperCase()}" does not exist — create it first`);
    const hashed = await bcrypt.hash(password, 10);
    inst.users.push({ username, password: hashed, role: role.toUpperCase(), email: req.body.email || "" });
    await inst.save();
    pushNotif(username, `Your account was created with role: ${role.toUpperCase()}`);
    res.send("User created");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

// POST /approve-user — promote PENDING → role
app.post("/approve-user", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");
  const { username, institute, role } = req.body;
  if (!username || !role) return res.status(400).send("Username and role required");
  try {
    const inst = await Institute.findOne({ name: institute || req.user.institute });
    if (!inst) return res.status(400).send("Institute not found");

    const user = inst.users.find(u => u.username === username);
    if (!user) return res.status(404).send("User not found");
    if (user.role !== "PENDING") return res.status(400).send("User is not pending");

    const normalizedRole = role.trim().toUpperCase();
    // Allow any role that exists, plus allow assigning to any custom role
    if (normalizedRole === "ADMIN") return res.status(400).send("Cannot assign ADMIN role");

    user.role = normalizedRole;

    // Auto-add the role to the institute's role list if it doesn't exist yet
    if (!inst.roles.includes(normalizedRole)) {
      inst.roles.push(normalizedRole);
    }

    inst.markModified("users");
    await inst.save();

    pushNotif(username, `✅ Your account was approved with role: ${normalizedRole}`);
    pushNotif(req.user.username, `Approved "${username}" → ${normalizedRole}`);
    console.log(`✅ Approved: ${username} → ${normalizedRole}`);
    res.send("User approved");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

// POST /reject-user — remove pending user
app.post("/reject-user", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");
  const { username, institute } = req.body;
  if (!username) return res.status(400).send("Username required");
  try {
    const inst = await Institute.findOne({ name: institute || req.user.institute });
    if (!inst) return res.status(400).send("Institute not found");
    const idx = inst.users.findIndex(u => u.username === username && u.role === "PENDING");
    if (idx === -1) return res.status(404).send("Pending user not found");
    inst.users.splice(idx, 1);
    inst.markModified("users");
    await inst.save();
    for (const [email, rec] of otpStore.entries()) {
      if (rec.data?.username === username) otpStore.delete(email);
    }
    console.log(`🗑️  Rejected: ${username}`);
    res.send("Rejected");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

// POST /delete-user — remove approved user
app.post("/delete-user", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");
  const { username, institute } = req.body;
  if (!username) return res.status(400).send("Username required");
  if (username === req.user.username) return res.status(400).send("Cannot delete your own account");
  try {
    const instName = institute || req.user.institute;
    const inst = await Institute.findOne({ name: instName });
    if (!inst) return res.status(400).send("Institute not found");
    const idx = inst.users.findIndex(u => u.username === username);
    if (idx === -1) return res.status(404).send("User not found");
    if (inst.users[idx].role === "ADMIN") return res.status(403).send("Cannot delete an ADMIN");
    inst.users.splice(idx, 1);
    inst.markModified("users");
    await inst.save();
    // Clean up stores
    for (const [email, rec] of otpStore.entries()) {
      if (rec.data?.username === username) otpStore.delete(email);
    }
    notifStore.delete(username);
    keyGenTimestamps.delete(`${username}:${instName}`);
    // Preserve audit trail
    await Document.updateMany(
      { uploadedBy: username },
      { $set: { uploadedBy: `${username} [deleted]` } }
    );
    console.log(`🗑️  Deleted: ${username}`);
    res.send("Deleted");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

// GET /users-by-role/:institute/:role
app.get("/users-by-role/:institute/:role", auth, async (req, res) => {
  try {
    const inst = await Institute.findOne({ name: req.params.institute });
    if (!inst) return res.json([]);
    res.json(
      inst.users
        .filter(u => u.role === req.params.role)
        .map(u => ({ username: u.username, role: u.role, email: u.email || "" }))
    );
  } catch(e) { res.json([]); }
});

/* ═══════════════════════════════════════════════════════════
   DOCUMENTS
═══════════════════════════════════════════════════════════ */
app.post("/upload", auth, upload.single("file"), async (req, res) => {
  const name      = req.file.originalname;
  const nameLower = name.toLowerCase();
  try {
    const allWorkflows     = await Workflow.find({});
    const workflowOverride = req.body.workflow;
    const targetRole       = req.body.targetRole;

    let type = "general";
    if (workflowOverride) {
      type = workflowOverride;
    } else {
      allWorkflows.forEach(w => {
        if (nameLower.includes(w.type.toLowerCase())) type = w.type;
      });
    }

    const wf = allWorkflows.find(w => w.type === type);
    let flowToUse = ["ADMIN"];
    if (targetRole) {
      flowToUse = wf ? [targetRole, ...wf.flow.filter(r => r !== targetRole)] : [targetRole, "ADMIN"];
    } else if (wf) {
      flowToUse = wf.flow;
    }

    const doc = new Document({
      id:               Date.now(),
      name,
      type,
      flow:             flowToUse,
      currentStep:      0,
      status:           `Pending — ${flowToUse[0]}`,
      uploadedBy:       req.user.username,
      uploadedAt:       new Date().toISOString(),
      rejected:         false,
      rejectionComment: "",
      signedBy:         [],
      signatures:       {},
      file:             req.file.filename
    });
    await doc.save();
    await notifyRole(name, flowToUse[0], `📄 New document "${name}" requires your approval`);
    pushNotif(req.user.username, `You uploaded "${name}" — waiting on ${flowToUse[0]}`);
    res.json(doc.toObject());
  } catch(e) { console.error(e); res.status(500).send("Upload failed"); }
});

app.get("/documents", auth, async (req, res) => {
  try {
    let docs;
    if (req.user.role === "ADMIN") {
      docs = await Document.find({}).lean();
    } else {
      docs = await Document.find({
        $or: [{ uploadedBy: req.user.username }, { flow: req.user.role }]
      }).lean();
    }
    res.json(docs);
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

/* ═══════════════════════════════════════════════════════════
   APPROVE / REJECT
═══════════════════════════════════════════════════════════ */
app.post("/approve", auth, async (req, res) => {
  const { id, role, signature } = req.body;
  try {
    const doc = await Document.findOne({ id });
    if (!doc) return res.status(404).send("Document not found");
    if (doc.flow[doc.currentStep] !== role) return res.status(400).send("Not your turn");

    const sigHash = crypto
      .createHmac("sha256", SECRET)
      .update(`${req.user.username}:${role}:${id}:${signature || ""}`)
      .digest("hex");

    doc.signatures = {
      ...doc.signatures,
      [role]: { signer: req.user.username, role, hash: sigHash, timestamp: new Date().toISOString() }
    };
    doc.markModified("signatures");
    doc.signedBy.push(role);
    doc.currentStep++;

    let nextRole = null;
    if (doc.currentStep >= doc.flow.length) {
      doc.status = "Fully Approved";
    } else {
      nextRole   = doc.flow[doc.currentStep];
      doc.status = `Pending — ${nextRole}`;
    }
    await doc.save();

    if (nextRole) await notifyRole(doc.name, nextRole, `📄 Document "${doc.name}" needs your approval`);
    if (doc.uploadedBy) {
      if (!nextRole) pushNotif(doc.uploadedBy, `✅ Your document "${doc.name}" was fully approved!`);
      pushNotif(doc.uploadedBy, `🔏 "${doc.name}" was signed by ${role}`);
    }
    res.send("Approved");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

app.post("/reject", auth, async (req, res) => {
  const { id, role, comment } = req.body;
  try {
    const doc = await Document.findOne({ id });
    if (!doc) return res.status(404).send("Document not found");
    if (doc.flow[doc.currentStep] !== role) return res.status(400).send("Not your turn");
    doc.status           = "Rejected";
    doc.rejected         = true;
    doc.rejectionComment = comment || "No comment provided";
    await doc.save();
    if (doc.uploadedBy)
      pushNotif(doc.uploadedBy, `❌ "${doc.name}" was rejected by ${role}: "${(comment||"").slice(0,60)}"`);
    res.send("Rejected");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

/* ═══════════════════════════════════════════════════════════
   SIGNING KEY
═══════════════════════════════════════════════════════════ */
app.post("/generate-key", auth, async (req, res) => {
  const userKey = `${req.user.username}:${req.user.institute}`;
  const lastGen = keyGenTimestamps.get(userKey);
  if (lastGen) {
    const remaining = KEY_COOLDOWN - (Date.now() - lastGen);
    if (remaining > 0) {
      const hrs  = Math.floor(remaining / 3600000);
      const mins = Math.floor((remaining % 3600000) / 60000);
      return res.status(429).json({ error: `Key regeneration available in ${hrs}h ${mins}m`, remainingMs: remaining });
    }
  }
  const salt        = Date.now().toString(36);
  const rawKey      = crypto.createHmac("sha256", SECRET + "_KEY_SALT_" + salt)
                            .update(req.user.username + ":" + req.user.institute).digest("hex");
  const fingerprint = rawKey.match(/.{2}/g).join(":").substring(0, 47);
  const publicKey   = "VNX-" + rawKey.substring(0, 16).toUpperCase();
  try {
    const inst = await Institute.findOne({ name: req.user.institute });
    if (inst) {
      const u = inst.users.find(u => u.username === req.user.username);
      if (u) {
        u.signingKey = publicKey; u.keyFingerprint = fingerprint;
        u.keyGeneratedAt = new Date().toISOString();
        inst.markModified("users");
        await inst.save();
      }
    }
  } catch(e) { console.error("Key persist failed:", e); }
  keyGenTimestamps.set(userKey, Date.now());
  pushNotif(req.user.username, `🔑 Signing key generated: ${publicKey}`);
  res.json({ publicKey, fingerprint });
});

app.get("/my-key", auth, async (req, res) => {
  try {
    const userKey           = `${req.user.username}:${req.user.institute}`;
    const lastGen           = keyGenTimestamps.get(userKey);
    const cooldownRemaining = lastGen ? Math.max(0, KEY_COOLDOWN - (Date.now() - lastGen)) : 0;
    const inst = await Institute.findOne({ name: req.user.institute });
    if (!inst) return res.json({ publicKey: null });
    const u = inst.users.find(u => u.username === req.user.username);
    if (!u) return res.json({ publicKey: null });
    res.json({ publicKey: u.signingKey || null, fingerprint: u.keyFingerprint || null,
               generatedAt: u.keyGeneratedAt || null, cooldownRemainingMs: cooldownRemaining });
  } catch(e) { res.json({ publicKey: null }); }
});

/* ═══════════════════════════════════════════════════════════
   ASSIGN / WORKFLOWS / AUDIT
═══════════════════════════════════════════════════════════ */
app.post("/assign-document", auth, async (req, res) => {
  const { docId, assignTo } = req.body;
  if (!docId || !assignTo) return res.status(400).send("docId and assignTo required");
  try {
    const doc = await Document.findOne({ id: docId });
    if (!doc) return res.status(404).send("Document not found");
    if (doc.uploadedBy !== req.user.username && req.user.role !== "ADMIN")
      return res.status(403).send("Not authorized");
    doc.assignedTo = assignTo;
    await doc.save();
    pushNotif(assignTo,          `📄 Document "${doc.name}" was assigned to you`);
    pushNotif(req.user.username, `You assigned "${doc.name}" to ${assignTo}`);
    res.send("Assigned");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

app.post("/create-workflow", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");
  const { type, flow } = req.body;
  if (!type || !flow?.length) return res.status(400).send("Invalid workflow");
  const normalizedFlow = flow.map(r => r.trim().toUpperCase()).filter(Boolean);
  try {
    await Workflow.findOneAndUpdate(
      { type: type.toLowerCase() },
      { type: type.toLowerCase(), flow: normalizedFlow },
      { upsert: true }
    );
    res.send("Workflow saved");
  } catch(e) { console.error(e); res.status(500).send("Server error"); }
});

app.get("/workflows", auth, async (req, res) => {
  try { res.json(await Workflow.find({}).lean()); }
  catch(e) { res.status(500).send("Server error"); }
});

app.get("/audit/:docId", auth, async (req, res) => {
  try {
    const doc = await Document.findOne({ id: parseInt(req.params.docId) }).lean();
    if (!doc) return res.status(404).send("Not found");
    res.json({ id: doc.id, name: doc.name, status: doc.status, signedBy: doc.signedBy,
               signatures: doc.signatures || {}, uploadedBy: doc.uploadedBy,
               uploadedAt: doc.uploadedAt, flow: doc.flow });
  } catch(e) { res.status(500).send("Server error"); }
});

/* ═══════════════════════════════════════════════════════════
   DEBUG  (remove before production)
═══════════════════════════════════════════════════════════ */
app.get("/debug", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");
  try {
    const institutes = await Institute.find({}).lean();
    res.json({
      token: req.user,
      institutes: institutes.map(i => ({
        name:      i.name,
        domain:    i.domain,
        roles:     i.roles,
        userCount: i.users.length,
        users:     i.users.map(u => ({ username: u.username, role: u.role, email: u.email }))
      }))
    });
  } catch(e) { res.status(500).send(e.message); }
});

/* ═══════════════════════════════════════════════════════════
   START
═══════════════════════════════════════════════════════════ */
const PORT = process.env.PORT || 3000;
connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Venatrix on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error("❌ DB connection failed:", err.message);
    process.exit(1);
  });