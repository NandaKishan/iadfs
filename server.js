const express = require("express");
const multer = require("multer");
const fs = require("fs");
const cors = require("cors");
const bcrypt = require("bcrypt");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

// Load data
let documents = fs.existsSync("data.json")
  ? JSON.parse(fs.readFileSync("data.json"))
  : [];

let users = JSON.parse(fs.readFileSync("users.json"));
let workflows = JSON.parse(fs.readFileSync("workflows.json"));


// 🔐 LOGIN
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).send("User not found");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).send("Wrong password");

  res.json({ username: user.username, role: user.role });
});


// 📥 Upload with dynamic workflow
app.post("/upload", upload.single("file"), (req, res) => {
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
    type: type,
    flow: wf ? wf.flow : ["ADMIN"],
    currentStep: 0,
    status: "Pending"
  };

  documents.push(doc);
  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  res.json(doc);
});


// 📤 Get documents
app.get("/documents", (req, res) => {
  res.json(documents);
});


// 🔄 Approve step
app.post("/approve", (req, res) => {
  const { id, role } = req.body;

  documents = documents.map(doc => {
    if (doc.id === id && doc.flow[doc.currentStep] === role) {
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


// 🏗️ Create workflow (ADMIN)
app.post("/create-workflow", (req, res) => {
  const { type, flow } = req.body;

  workflows.push({ type, flow });

  fs.writeFileSync("workflows.json", JSON.stringify(workflows, null, 2));

  res.send("Workflow created");
});


// 📤 Get workflows
app.get("/workflows", (req, res) => {
  res.json(workflows);
});


app.listen(3000, () => {
  console.log("🚀 Running on http://localhost:3000");
});