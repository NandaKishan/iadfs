const express = require("express");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken"); // ✅ ADDED

const app = express();

const SECRET = "supersecretkey"; // ✅ ADDED

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

console.log("🔥 SERVER FILE LOADED");


// =========================
// 🔐 AUTH MIDDLEWARE (ADDED)
// =========================
function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) return res.status(401).send("No token");

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).send("Invalid token");
  }
}


// =========================
// 📦 LOAD DATA
// =========================

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


// =========================
// 🔐 LOGIN (UPDATED WITH JWT)
// =========================

app.post("/login", async (req, res) => {
  const { username, password, institute } = req.body;

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);

  if (!inst) return res.status(400).send("Invalid institute");

  const user = inst.users.find(u => u.username === username);
  if (!user) return res.status(401).send("User not found");

  if (user.role === "PENDING") {
    return res.status(403).send("Awaiting admin approval");
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).send("Wrong password");

  const token = jwt.sign(
    {
      username: user.username,
      role: user.role,
      institute: inst.name
    },
    SECRET,
    { expiresIn: "2h" }
  );

  res.json({ token });
});


// =========================
// 🆕 SIGNUP
// =========================

app.post("/signup", async (req, res) => {
  console.log("🔥 SIGNUP HIT");

  const { username, password, email, institute } = req.body;

  if (!username || !password || !email || !institute) {
    return res.status(400).send("All fields required");
  }

  if (!email.endsWith("@rvce.edu.in")) {
    return res.status(400).send("Use institute email only");
  }

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);

  if (!inst) return res.status(400).send("Invalid institute");

  if (inst.users.find(u => u.username === username)) {
    return res.status(400).send("Username already exists");
  }

  if (inst.users.find(u => u.email === email)) {
    return res.status(400).send("Email already registered");
  }

  const hashed = await bcrypt.hash(password, 10);

  inst.users.push({
    username,
    password: hashed,
    role: "PENDING",
    email
  });

  saveInstitutes(institutes);

  res.send("Signup submitted. Await admin approval.");
});


// =========================
// 🟢 APPROVE USER (PROTECTED)
// =========================

app.post("/approve-user", auth, (req, res) => {

  if (req.user.role !== "ADMIN") {
    return res.status(403).send("Not allowed");
  }

  const { username, institute, role } = req.body;

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);

  if (!inst) return res.status(400).send("Institute not found");

  const user = inst.users.find(u => u.username === username);

  if (!user) return res.status(400).send("User not found");

  if (user.role !== "PENDING") {
    return res.status(400).send("User already approved");
  }

  if (role === "ADMIN") {
    return res.status(400).send("Cannot assign ADMIN");
  }

  user.role = role;

  saveInstitutes(institutes);

  res.send("User approved");
});


// =========================
// 🏗️ CREATE ROLE (PROTECTED)
// =========================

app.post("/create-role", auth, (req, res) => {

  if (req.user.role !== "ADMIN") {
    return res.status(403).send("Not allowed");
  }

  const { role, institute } = req.body;

  if (!role) return res.status(400).send("Role required");

  if (role === "ADMIN") {
    return res.status(400).send("ADMIN role is reserved");
  }

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);

  if (!inst) return res.status(400).send("Institute not found");

  if (!inst.roles.includes(role)) {
    inst.roles.push(role);
  }

  saveInstitutes(institutes);
  res.send("Role created");
});


// =========================
// 📤 GET ROLES (PROTECTED)
// =========================

app.get("/roles/:institute", auth, (req, res) => {
  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === req.params.institute);

  if (!inst) return res.status(400).send("Institute not found");

  res.json(inst.roles);
});


// =========================
// 👤 CREATE USER (PROTECTED)
// =========================

app.post("/create-user", auth, async (req, res) => {

  if (req.user.role !== "ADMIN") {
    return res.status(403).send("Not allowed");
  }

  const { username, password, role, institute } = req.body;

  if (!username || !password || !role) {
    return res.status(400).send("All fields required");
  }

  if (role === "ADMIN") {
    return res.status(400).send("Cannot create ADMIN user");
  }

  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === institute);

  if (!inst) return res.status(400).send("Invalid institute");

  if (inst.users.find(u => u.username === username)) {
    return res.status(400).send("User already exists");
  }

  if (!inst.roles.includes(role)) {
    return res.status(400).send("Role does not exist");
  }

  const hashed = await bcrypt.hash(password, 10);

  inst.users.push({
    username,
    password: hashed,
    role
  });

  saveInstitutes(institutes);

  res.send("User created");
});


// =========================
// 📤 GET USERS (PROTECTED)
// =========================

app.get("/users/:institute", auth, (req, res) => {
  const institutes = getInstitutes();
  const inst = institutes.find(i => i.name === req.params.institute);

  if (!inst) return res.status(400).send("Institute not found");

  res.json(inst.users.map(u => ({
    username: u.username,
    role: u.role,
    email: u.email || "-"
  })));
});


// =========================
// 📥 UPLOAD (PROTECTED)
// =========================

app.post("/upload", auth, upload.single("file"), (req, res) => {
  const name = req.file.originalname.toLowerCase();

  let type = "leave";

  workflows.forEach(w => {
    if (name.includes(w.type)) {
      type = w.type;
    }
  });

  const wf = workflows.find(w => w.type === type);

  const doc = {
    id: Date.now(),
    name: req.file.originalname,
    type,
    flow: wf ? wf.flow : ["ADMIN"],
    currentStep: 0,
    status: "Pending",

    // ✅ ADDED FEATURES
    rejected: false,
    rejectionComment: "",
    signedBy: []
  };

  documents.push(doc);
  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  res.json(doc);
});


// =========================
// 📤 GET DOCS (PROTECTED)
// =========================

app.get("/documents", auth, (req, res) => {
  res.json(documents);
});


// =========================
// 🔄 APPROVE DOC (PROTECTED)
// =========================

app.post("/approve", auth, (req, res) => {
  const { id, role } = req.body;

  documents = documents.map(doc => {
    if (doc.id === id && doc.flow[doc.currentStep] === role) {

      // ✅ E-SIGN ADDED
      if (!doc.signedBy) doc.signedBy = [];
      doc.signedBy.push(role);

      doc.currentStep++;

      if (doc.currentStep >= doc.flow.length) {
        doc.status = "Fully Approved";
      }
    }
    return doc;
  });

  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  res.send("Approved");
});


// =========================
// ❌ REJECT DOC (PROTECTED)
// =========================

app.post("/reject", auth, (req, res) => {
  const { id, role, comment } = req.body;

  documents = documents.map(doc => {
    if (doc.id === id && doc.flow[doc.currentStep] === role) {

      doc.status = "Rejected";
      doc.rejected = true;
      doc.rejectionComment = comment || "No comment";

    }
    return doc;
  });

  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  res.send("Rejected");
});


// =========================
// 🏗️ WORKFLOW (PROTECTED)
// =========================

app.post("/create-workflow", auth, (req, res) => {
  const { type, flow } = req.body;

  workflows.push({ type, flow });

  fs.writeFileSync("workflows.json", JSON.stringify(workflows, null, 2));

  res.send("Workflow created");
});

app.get("/workflows", auth, (req, res) => {
  res.json(workflows);
});


// =========================
// 🚀 START
// =========================

app.listen(3000, () => {
  console.log("🚀 Running on http://localhost:3000");
});