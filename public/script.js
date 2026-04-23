// ===== USER =====
const user = JSON.parse(localStorage.getItem("user"));

if (!user) {
  window.location = "index.html";
}

// ===== DISPLAY ROLE =====
document.getElementById("role").innerText = user.role;

// ===== SHOW ADMIN PANEL =====
if (user.role === "ADMIN") {
  document.getElementById("adminPanel").style.display = "block";
}

// ===== LOGOUT =====
function logout() {
  localStorage.removeItem("user");
  window.location = "index.html";
}

// ===== UPLOAD =====
async function upload() {
  const file = document.getElementById("file").files[0];

  if (!file) {
    alert("Select a file first");
    return;
  }

  const fd = new FormData();
  fd.append("file", file);

  await fetch("/upload", {
    method: "POST",
    body: fd
  });

  loadDocs();
}

// ===== LOAD DOCUMENTS =====
async function loadDocs() {
  const list = document.getElementById("list");
  list.innerHTML = "<p>Loading...</p>";

  const res = await fetch("/documents");
  const docs = await res.json();

  list.innerHTML = "";

  if (docs.length === 0) {
    list.innerHTML = "<p style='color:#94a3b8;'>No documents yet</p>";
    return;
  }

  docs.forEach(doc => {
    const div = document.createElement("div");
    div.className = "doc-card";

    let approveBtn = "";

    // ✅ Only allow correct role to approve
    if (doc.flow[doc.currentStep] === user.role) {
      approveBtn = `<button onclick="approve(${doc.id})">Approve</button>`;
    }

    div.innerHTML = `
      <h4>${doc.name}</h4>
      <p>Status: ${doc.status}</p>
      <p>Current: ${doc.flow[doc.currentStep] || "Done"}</p>
      <p class="flow">${doc.flow.join(" → ")}</p>
      ${approveBtn}
    `;

    list.appendChild(div);
  });
}

// ===== APPROVE =====
async function approve(id) {
  await fetch("/approve", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id, role: user.role })
  });

  loadDocs();
}

// ===== CREATE WORKFLOW =====
async function createWorkflow() {
  const type = document.getElementById("type").value;
  const flow = document.getElementById("flow").value.split(",");

  if (!type || flow.length === 0) {
    alert("Enter valid workflow");
    return;
  }

  await fetch("/create-workflow", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ type, flow })
  });

  alert("Workflow created");
}

// ===== INITIAL LOAD =====
loadDocs();