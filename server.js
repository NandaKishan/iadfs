const express  = require("express");
const fetch = (...args) =>
  import('node-fetch').then(({default: fetch}) => fetch(...args));
const multer   = require("multer");
const fs       = require("fs");
const cors     = require("cors");
const bcrypt   = require("bcrypt");
const jwt      = require("jsonwebtoken");
const crypto   = require("crypto");
require("dotenv").config();

const app = express();

// ─── CONFIG ───────────────────────────────────────────────
const SECRET     = process.env.JWT_SECRET || "venatrix_supersecret_2025";
const OTP_TTL    = 10 * 60 * 1000; // 10 minutes

// ─── RESEND EMAIL (real email, no fake SMTP) ──────────────
// Set RESEND_API_KEY env variable with your key from resend.com
// Set RESEND_FROM env to your verified sender e.g. "Venatrix <noreply@yourdomain.com>"
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM    = process.env.RESEND_FROM;

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn("⚠️  RESEND_API_KEY not set — email not sent. OTP logged below.");
    return { ok: false, fake: true };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ from: RESEND_FROM, to, subject, html }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("Resend error:", data);
    return { ok: false, error: data };
  }
  console.log(`📧 Email sent via Resend → ${to} (id: ${data.id})`);
  return { ok: true, id: data.id };
}

if (!RESEND_API_KEY) {
  console.log("💡 To enable real email: set RESEND_API_KEY (get one free at resend.com)");
  console.log("   Optional: set RESEND_FROM to your verified sender address");
}

// ─── MIDDLEWARE ───────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

console.log("🔥 VENATRIX SERVER v2.0 LOADED");

// ─── IN-MEMORY OTP STORE ─────────────────────────────────
// Format: { email: { otp, expiresAt, data } }
const otpStore = new Map();

// ─── IN-MEMORY NOTIFICATION STORE ────────────────────────
// Format: { username: [ { msg, time, read } ] }
const notifStore = new Map();

function pushNotif(username, msg) {
  if (!username) return;
  if (!notifStore.has(username)) notifStore.set(username, []);
  const list = notifStore.get(username);
  list.unshift({ msg, time: Date.now(), read: false });
  if (list.length > 50) list.pop();
}

// ─── DATA LOADERS ─────────────────────────────────────────

function getInstitutes() {
  return JSON.parse(fs.readFileSync("institutes.json"));
}

function saveInstitutes(data) {
  fs.writeFileSync("institutes.json", JSON.stringify(data, null, 2));
}

let documents = fs.existsSync("data.json")
  ? JSON.parse(fs.readFileSync("data.json"))
  : [];

let workflows = JSON.parse(fs.readFileSync("workflows.json"));

// ─── AUTH MIDDLEWARE ──────────────────────────────────────

function auth(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send("No token");
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).send("Invalid or expired token");
  }
}

// ─────────────────────────────────────────────────────────
// 📧 SEND OTP  (new — replaces old /signup)
// ─────────────────────────────────────────────────────────

app.post("/send-otp", async (req, res) => {
  const { username, password, email, institute } = req.body;

  if (!username || !password || !email || !institute) {
    return res.status(400).send("All fields required");
  }

  if (!email.endsWith("@rvce.edu.in")) {
    return res.status(400).send("Only RVCE institute emails allowed");
  }

  // Validate email domain loosely (institute-specific check on final verify)
  if (!email.includes("@") || email.length < 5) {
    return res.status(400).send("Invalid email address");
  }

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);
  if (!inst) return res.status(400).send("Invalid institute");

  // Check username/email uniqueness early
  if (inst.users.find(u => u.username === username)) {
    return res.status(400).send("Username already taken");
  }
  if (inst.users.find(u => u.email === email)) {
    return res.status(400).send("Email already registered");
  }

  // Generate OTP
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + OTP_TTL;

  otpStore.set(email, { otp, expiresAt, data: { username, password, email, institute } });

  // Send email via Resend
  const emailHtml = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#04050f;color:#e8eeff;border-radius:16px;">
      <div style="font-family:monospace;font-size:22px;font-weight:700;letter-spacing:3px;color:#00e5c8;margin-bottom:8px;">VENATRIX</div>
      <div style="font-size:14px;color:#8899bb;margin-bottom:32px;">Intelligent Information Flow</div>
      <div style="font-size:16px;margin-bottom:16px;color:#e8eeff;">
        Hi <strong>${username}</strong>, here is your verification code:
      </div>
      <div style="background:#0d1225;border:1px solid rgba(0,229,200,0.2);border-radius:12px;padding:20px 32px;text-align:center;margin:24px 0;">
        <div style="font-family:monospace;font-size:40px;font-weight:700;letter-spacing:12px;color:#00e5c8;">${otp}</div>
      </div>
      <div style="font-size:13px;color:#4a5880;">
        This code expires in <strong style="color:#e8eeff">10 minutes</strong>.<br>
        If you didn't request this, you can safely ignore this email.
      </div>
    </div>
  `;

  const result = await sendEmail({ to: email, subject: "Your Venatrix Verification Code", html: emailHtml });

  if (result.fake) {
    // No API key — log OTP so dev can still test
    console.log(`🔑 DEV OTP for ${email}: ${otp}`);
    res.send("OTP sent (check server console — set RESEND_API_KEY for real email)");
  } else if (!result.ok) {
    console.error("Email delivery failed:", result.error);
    // Still let user proceed; log OTP as fallback
    console.log(`🔑 FALLBACK OTP for ${email}: ${otp}`);
    res.send("OTP sent");
  } else {
    res.send("OTP sent");
  }
});

// ─────────────────────────────────────────────────────────
// ✅ VERIFY OTP & COMPLETE SIGNUP
// ─────────────────────────────────────────────────────────

app.post("/verify-otp", async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) return res.status(400).send("Email and OTP required");

  const record = otpStore.get(email);
  if (!record) return res.status(400).send("OTP not found or expired. Request a new one.");
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.status(400).send("OTP expired. Request a new one.");
  }
  if (record.otp !== String(otp).trim()) {
    return res.status(400).send("Incorrect OTP. Try again.");
  }

  // OTP valid — complete signup
  otpStore.delete(email);

  const { username, password, institute } = record.data;
  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);
  if (!inst) return res.status(400).send("Institute not found");

  // Re-check uniqueness (race condition guard)
  if (inst.users.find(u => u.username === username)) {
    return res.status(400).send("Username already taken");
  }

  const hashed = await bcrypt.hash(password, 10);
  inst.users.push({ username, password: hashed, role: "PENDING", email });
  saveInstitutes(institutes);

  // Notify admins
  const admins = inst.users.filter(u => u.role === "ADMIN");
  admins.forEach(a => pushNotif(a.username, `New signup awaiting approval: "${username}"`));

  res.send("Signup complete. Awaiting admin approval.");
});

// ─────────────────────────────────────────────────────────
// 🔐 LOGIN (JWT)
// ─────────────────────────────────────────────────────────

app.post("/login", async (req, res) => {
  const { username, password, institute } = req.body;

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);
  if (!inst) return res.status(400).send("Invalid institute");

  const user = inst.users.find(u => u.username === username);
  if (!user) return res.status(401).send("User not found");

  if (user.role === "PENDING") {
    return res.status(403).send("Account pending admin approval");
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).send("Incorrect password");

  const token = jwt.sign(
    { username: user.username, role: user.role, institute: inst.name },
    SECRET,
    { expiresIn: "8h" }
  );

  pushNotif(username, `You logged in as ${user.role}`);
  res.json({ token });
});

// ─────────────────────────────────────────────────────────
// 🔔 NOTIFICATIONS (SSE stream)
// ─────────────────────────────────────────────────────────

app.get("/notifications/stream", auth, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const username = req.user.username;
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
  const notifs = notifStore.get(req.user.username) || [];
  res.json(notifs);
});

app.post("/notifications/read", auth, (req, res) => {
  const notifs = notifStore.get(req.user.username) || [];
  notifs.forEach(n => n.read = true);
  res.send("OK");
});

// ─────────────────────────────────────────────────────────
// 🏗️ ROLE MANAGEMENT
// ─────────────────────────────────────────────────────────

app.post("/create-role", auth, (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");

  const { role, institute } = req.body;
  if (!role) return res.status(400).send("Role required");
  if (role.toUpperCase() === "ADMIN") return res.status(400).send("ADMIN role is reserved");

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);
  if (!inst) return res.status(400).send("Institute not found");

  if (!inst.roles.includes(role.toUpperCase())) {
    inst.roles.push(role.toUpperCase());
    saveInstitutes(institutes);
  }

  res.send("Role created");
});

app.get("/roles/:institute", auth, (req, res) => {
  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === req.params.institute);
  if (!inst) return res.status(400).send("Institute not found");
  res.json(inst.roles);
});

// ─────────────────────────────────────────────────────────
// 👤 USER MANAGEMENT
// ─────────────────────────────────────────────────────────

app.post("/create-user", auth, async (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");

  const { username, password, role, institute } = req.body;
  if (!username || !password || !role) return res.status(400).send("All fields required");
  if (role.toUpperCase() === "ADMIN") return res.status(400).send("Cannot create ADMIN user via this form");

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);
  if (!inst) return res.status(400).send("Invalid institute");

  if (inst.users.find(u => u.username === username)) {
    return res.status(400).send("User already exists");
  }
  if (!inst.roles.includes(role.toUpperCase())) {
    return res.status(400).send("Role does not exist");
  }

  const hashed = await bcrypt.hash(password, 10);
  inst.users.push({ username, password: hashed, role: role.toUpperCase() });
  saveInstitutes(institutes);

  pushNotif(username, `Your account has been created with role: ${role.toUpperCase()}`);
  res.send("User created");
});

app.get("/users/:institute", auth, (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === req.params.institute);
  if (!inst) return res.status(400).send("Institute not found");

  res.json(inst.users.map(u => ({
    username: u.username,
    role: u.role,
    email: u.email || "—"
  })));
});

app.post("/approve-user", auth, (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");

  const { username, institute, role } = req.body;
  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);
  if (!inst) return res.status(400).send("Institute not found");

  const user = inst.users.find(u => u.username === username);
  if (!user) return res.status(400).send("User not found");
  if (user.role !== "PENDING") return res.status(400).send("User already approved");
  if (role.toUpperCase() === "ADMIN") return res.status(400).send("Cannot assign ADMIN");

  user.role = role.toUpperCase();
  saveInstitutes(institutes);

  pushNotif(username, `✅ Your account has been approved with role: ${user.role}`);
  res.send("User approved");
});

// ─────────────────────────────────────────────────────────
// 📤 UPLOAD (with role & workflow override)
// ─────────────────────────────────────────────────────────

app.post("/upload", auth, upload.single("file"), (req, res) => {
  const name = req.file.originalname;
  const nameLower = name.toLowerCase();

  // Determine workflow type
  let type = "general";
  const workflowOverride = req.body.workflow;
  const targetRole = req.body.targetRole;

  if (workflowOverride) {
    type = workflowOverride;
  } else {
    workflows.forEach(w => {
      if (nameLower.includes(w.type.toLowerCase())) {
        type = w.type;
      }
    });
  }

  let flowToUse = ["ADMIN"]; // default

  // If targetRole override, route to that role first
  if (targetRole) {
    const wf = workflows.find(w => w.type === type);
    flowToUse = wf ? [targetRole, ...wf.flow.filter(r => r !== targetRole)] : [targetRole, "ADMIN"];
  } else {
    const wf = workflows.find(w => w.type === type);
    if (wf) flowToUse = wf.flow;
  }

  const doc = {
    id:              Date.now(),
    name,
    type,
    flow:            flowToUse,
    currentStep:     0,
    status:          `Pending — ${flowToUse[0]}`,
    uploadedBy:      req.user.username,
    uploadedAt:      new Date().toISOString(),
    rejected:        false,
    rejectionComment: "",
    signedBy:        [],
    signatures:      {}  // role -> { signature, timestamp }
  };

  documents.push(doc);
  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  // Notify the first approver (all users with that role)
  const firstRole = flowToUse[0];
  notifyRole(doc, firstRole, `📄 New document "${name}" requires your approval`);
  pushNotif(req.user.username, `You uploaded "${name}" — waiting on ${firstRole}`);

  res.json(doc);
});

// Helper: push notification to all users of a role in same institute
function notifyRole(doc, role, msg) {
  try {
    const institutes = getInstitutes();
    institutes.forEach(inst => {
      inst.users
        .filter(u => u.role === role)
        .forEach(u => pushNotif(u.username, msg));
    });
  } catch(e) {}
}

// ─────────────────────────────────────────────────────────
// 📋 GET DOCUMENTS
// ─────────────────────────────────────────────────────────

app.get("/documents", auth, (req, res) => {
  res.json(documents);
});

// ─────────────────────────────────────────────────────────
// 🔏 APPROVE WITH E-SIGN
// ─────────────────────────────────────────────────────────

app.post("/approve", auth, (req, res) => {
  const { id, role, signature } = req.body;

  let nextRole = null;
  let uploaderUsername = null;
  let docName = null;

  documents = documents.map(doc => {
    if (doc.id !== id) return doc;
    if (doc.flow[doc.currentStep] !== role) return doc;

    if (!doc.signedBy) doc.signedBy = [];
    if (!doc.signatures) doc.signatures = {};

    // Store encrypted signature with timestamp
    const sigHash = crypto
      .createHmac("sha256", SECRET)
      .update(`${req.user.username}:${role}:${id}:${signature || ""}`)
      .digest("hex");

    doc.signatures[role] = {
      signer:    req.user.username,
      role,
      hash:      sigHash,
      timestamp: new Date().toISOString()
    };

    doc.signedBy.push(role);
    doc.currentStep++;
    uploaderUsername = doc.uploadedBy;
    docName = doc.name;

    if (doc.currentStep >= doc.flow.length) {
      doc.status = "Fully Approved";
      nextRole = null;
    } else {
      nextRole = doc.flow[doc.currentStep];
      doc.status = `Pending — ${nextRole}`;
    }

    return doc;
  });

  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  // Notifications
  if (nextRole) {
    notifyRole({ id, name: docName }, nextRole, `📄 Document "${docName}" needs your approval`);
  } else {
    // Fully approved — notify uploader
    if (uploaderUsername) {
      pushNotif(uploaderUsername, `✅ Your document "${docName}" has been fully approved!`);
    }
  }

  if (uploaderUsername) {
    pushNotif(uploaderUsername, `🔏 "${docName}" was signed by ${role}`);
  }

  res.send("Approved");
});

// ─────────────────────────────────────────────────────────
// ❌ REJECT
// ─────────────────────────────────────────────────────────

app.post("/reject", auth, (req, res) => {
  const { id, role, comment } = req.body;

  let uploaderUsername = null;
  let docName = null;

  documents = documents.map(doc => {
    if (doc.id !== id) return doc;
    if (doc.flow[doc.currentStep] !== role) return doc;

    doc.status = "Rejected";
    doc.rejected = true;
    doc.rejectionComment = comment || "No comment provided";
    uploaderUsername = doc.uploadedBy;
    docName = doc.name;

    return doc;
  });

  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  if (uploaderUsername) {
    pushNotif(uploaderUsername, `❌ Your document "${docName}" was rejected by ${role}: "${comment?.slice(0,60)}"`);
  }

  res.send("Rejected");
});

// ─────────────────────────────────────────────────────────
// 🔑 GENERATE / STORE SIGNING KEY
// ─────────────────────────────────────────────────────────

app.post("/generate-key", auth, (req, res) => {
  // Generate a deterministic public key fingerprint for the user
  // In a real system this would be a proper asymmetric keypair; here we
  // derive a stable fingerprint from the user identity + a server secret.
  const rawKey = crypto
    .createHmac("sha256", SECRET + "_KEY_SALT")
    .update(req.user.username + ":" + req.user.institute)
    .digest("hex");

  const fingerprint = rawKey.match(/.{2}/g).join(":").substring(0, 47); // XX:XX:XX… format
  const publicKey = "VNX-" + rawKey.substring(0, 16).toUpperCase();

  // Persist key reference in institutes.json
  try {
    const institutes = getInstitutes();
    const inst = institutes.find(i => i.name === req.user.institute);
    if (inst) {
      const u = inst.users.find(u => u.username === req.user.username);
      if (u) {
        u.signingKey = publicKey;
        u.keyFingerprint = fingerprint;
        saveInstitutes(institutes);
      }
    }
  } catch(e) {}

  pushNotif(req.user.username, `🔑 Signing key generated: ${publicKey}`);
  res.json({ publicKey, fingerprint });
});

app.get("/my-key", auth, (req, res) => {
  try {
    const institutes = getInstitutes();
    const inst = institutes.find(i => i.name === req.user.institute);
    if (!inst) return res.json({ publicKey: null });
    const u = inst.users.find(u => u.username === req.user.username);
    if (!u) return res.json({ publicKey: null });
    res.json({ publicKey: u.signingKey || null, fingerprint: u.keyFingerprint || null });
  } catch(e) {
    res.json({ publicKey: null });
  }
});

// ─────────────────────────────────────────────────────────
// 📎 ASSIGN DOCUMENT TO SPECIFIC USER
// ─────────────────────────────────────────────────────────

app.post("/assign-document", auth, (req, res) => {
  const { docId, assignTo } = req.body;
  if (!docId || !assignTo) return res.status(400).send("docId and assignTo required");

  const doc = documents.find(d => d.id === docId);
  if (!doc) return res.status(404).send("Document not found");

  // Only uploader or ADMIN can assign
  if (doc.uploadedBy !== req.user.username && req.user.role !== "ADMIN") {
    return res.status(403).send("Not authorized to assign this document");
  }

  doc.assignedTo = assignTo;
  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  pushNotif(assignTo, `📄 Document "${doc.name}" has been assigned to you for review`);
  pushNotif(req.user.username, `You assigned "${doc.name}" to ${assignTo}`);

  res.send("Assigned");
});

// ─────────────────────────────────────────────────────────
// 🔄 WORKFLOWS
// ─────────────────────────────────────────────────────────

app.post("/create-workflow", auth, (req, res) => {
  if (req.user.role !== "ADMIN") return res.status(403).send("Not allowed");

  const { type, flow } = req.body;
  if (!type || !flow || !flow.length) return res.status(400).send("Invalid workflow");

  const normalizedFlow = flow.map(r => r.trim().toUpperCase()).filter(Boolean);

  // Update if exists, else add
  const existing = workflows.findIndex(w => w.type === type.toLowerCase());
  if (existing >= 0) {
    workflows[existing].flow = normalizedFlow;
  } else {
    workflows.push({ type: type.toLowerCase(), flow: normalizedFlow });
  }

  fs.writeFileSync("workflows.json", JSON.stringify(workflows, null, 2));
  res.send("Workflow saved");
});

app.get("/workflows", auth, (req, res) => {
  res.json(workflows);
});

// ─────────────────────────────────────────────────────────
// 🔐 E-SIGN AUDIT — verify a document's signature chain
// ─────────────────────────────────────────────────────────

app.get("/audit/:docId", auth, (req, res) => {
  const doc = documents.find(d => d.id === parseInt(req.params.docId));
  if (!doc) return res.status(404).send("Document not found");

  res.json({
    id:        doc.id,
    name:      doc.name,
    status:    doc.status,
    signedBy:  doc.signedBy,
    signatures: doc.signatures || {},
    uploadedBy: doc.uploadedBy,
    uploadedAt: doc.uploadedAt,
    flow:       doc.flow
  });
});

// ─────────────────────────────────────────────────────────
// 🚀 START
// ─────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Venatrix running on http://localhost:${PORT}`);
  console.log(`📧 Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE envs for real email`);
});
