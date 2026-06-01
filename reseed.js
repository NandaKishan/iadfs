/**
 * reseed.js — hardcodes the RVCE institute directly into MongoDB
 * Run: node reseed.js
 * 
 * Bypasses institutes.json entirely since it has JSON syntax errors.
 * Passwords are the original bcrypt hashes — nothing changes for users.
 */
const mongoose = require("mongoose");
require("dotenv").config();

const UserSubSchema = new mongoose.Schema({
  username:       String,
  password:       String,
  role:           String,
  email:          { type: String, default: "" },
  signingKey:     { type: String, default: null },
  keyFingerprint: { type: String, default: null },
  keyGeneratedAt: { type: String, default: null }
}, { _id: false });

const InstituteSchema = new mongoose.Schema({
  name:   { type: String, required: true, unique: true },
  domain: { type: String, default: "" },
  roles:  [String],
  users:  [UserSubSchema]
});
const Institute = mongoose.model("Institute", InstituteSchema);

// ── Paste your exact users here — hashes copied from institutes.json ──
const RVCE = {
  name:   "RVCE",
  domain: "rvce.edu.in",
  roles:  ["ADMIN", "HOD", "Dean Student Affairs", "my assistant"],
  users: [
    { username: "admin",     password: "$2b$10$lSfnLhWZ5ugKA4qoWQAIBu2MYflazEx42lWTC2ArMJiua6lIBZmXy", role: "ADMIN",                   email: "" },
    { username: "nanda",     password: "$2b$10$y73VhXkfFFpz937DVL3UXupKblbDEzjCxu3lb0Efmd8401drcx856", role: "USER",                    email: "nanda@rvce.edu.in" },
    { username: "nanda2",    password: "$2b$10$s2wQnqc32X.a2fCYqZ5CWO.noLV./6X10PWVyxRbJjC19ITveYl5S", role: "USER",                    email: "nanda2@rvce.edu.in" },
    { username: "abhishek",  password: "$2b$10$0gN3elktL02SGDBa7u2Yh.J0wK1O45lx2XF.5v14i.liQ3hIZIy6a", role: "USER",                    email: "abhishek@rvce.edu.in" },
    { username: "abhishek2", password: "$2b$10$9O4EopmrCbG1EEP71lJ0NOk6T/KT9caEyjmnk7Pm5OuNdd3iBf.Sa", role: "USER",                    email: "abhisehk2@rvce.edu.in" },
    { username: "test123",   password: "$2b$10$14C2HAMPe2VNPTejAuWxGOkqt949YY2R/V6v7qCUbzdbG.eGnVDaO", role: "Associate Professor",     email: "test123@rvce.edu.in" },
    { username: "test4",     password: "$2b$10$mKOeXuk4z29KCVwu739b6.dTyjy6L6EoMuv8HJGQXuqSdsvpWr1Ry", role: "Professor",               email: "test4@rvce.edu.in" },
    { username: "sachin",    password: "$2b$10$W9KIBSrTKpv5irCctQ5FduQ5jFCWyuS4vxoVJ2Wjv3OM1Re7CoQmS", role: "HOD",                     email: "sachin@rvce.edu.in" },
    { username: "rahul",     password: "$2b$10$ZHnQ8xB/JNg3oOtIy9h8O.S/zB7OJg1Hei7tqLNehPc/0qa/UAN/C", role: "Associate Professor",     email: "rahul123@rvce.edu.in" },
    { username: "test8",     password: "$2b$10$Z3Nb8EofK7JkQ3.uH8v2VuHZJ90O6kIqlCekLrIx6fODIIsow5ihu", role: "Associate Professor - PHY", email: "test8@rvce.edu.in" },
    { username: "rushil",    password: "$2b$10$iHXkmQhvJavUEiwVYFhgoOMo8QDzbbO69yDvREId8n1V7QhYT0GJ2", role: "HOD  Math",               email: "rushil123@rvce.edu.in" },
    { username: "sushmitha", password: "$2b$10$LFWJzEVEmImF79GTypzL4.2kWAS/FyuqU6fJCMxtqnjvkFDBOUDja", role: "Professor",               email: "abc@rvce.edu.in" },
    { username: "pranav",    password: "$2b$10$0DTdJlTDVLgdYQshQcKsPuNFr06hrxL76y5Eua5LOO00l7/ojmWgK", role: "ASSOCIATE PROFESSOR",     email: "pranavmm.ci25@rvce.edu.in",
      signingKey: "VNX-D1AA67E01A995BC0", keyFingerprint: "d1:aa:67:e0:1a:99:5b:c0:b7:14:89:33:bb:37:67:b2" }
  ]
};

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected\n");

  const exists = await Institute.findOne({ name: "RVCE" });
  if (exists) {
    console.log("⚠️  RVCE already exists in DB.");
    console.log("   If you want to fully restore, drop the institutes collection first, then re-run.");
    await mongoose.disconnect();
    return;
  }

  await Institute.create(RVCE);
  console.log(`✅ Restored RVCE with ${RVCE.users.length} users`);
  console.log("\nUsers restored:");
  RVCE.users.forEach(u => console.log(`  • ${u.username.padEnd(12)} (${u.role})`));
  console.log("\n✅ Done — run: node server.js");
  await mongoose.disconnect();
}

run().catch(err => { console.error("❌", err.message); process.exit(1); });