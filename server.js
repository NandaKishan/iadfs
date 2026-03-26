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

// 🔐 LOGIN
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const user = users.find(u => u.username === username);
  if (!user) return res.status(401).send("User not found");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).send("Wrong password");

  res.json({ username: user.username, role: user.role });
});

// 📥 Upload
app.post("/upload", upload.single("file"), (req, res) => {
  const name = req.file.originalname.toLowerCase();

  let route = "HOD";
  if (name.includes("finance")) route = "ACCOUNTS";

  const doc = {
    id: Date.now(),
    name: req.file.originalname,
    status: "Pending",
    route: route,
    approvedBy: []
  };

  documents.push(doc);
  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  res.json(doc);
});

// 📤 Get docs
app.get("/documents", (req, res) => {
  res.json(documents);
});

// 🔄 Approve (ROLE CHECK)
app.post("/approve", (req, res) => {
  const { id, role } = req.body;

  documents = documents.map(doc => {
    if (doc.id === id && doc.route === role) {
      doc.status = "Approved";
      doc.approvedBy.push(role);
    }
    return doc;
  });

  fs.writeFileSync("data.json", JSON.stringify(documents, null, 2));

  res.send("Approved");
});

app.listen(3000, () => console.log("🚀 Running on http://localhost:3000"));