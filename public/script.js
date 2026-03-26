async function upload() {
  const file = document.getElementById("fileInput").files[0];

  if (!file) {
    alert("Please select a file");
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  await fetch("/upload", {
    method: "POST",
    body: formData
  });

  loadDocs();
}

async function loadDocs() {
  const res = await fetch("/documents");
  const data = await res.json();

  const list = document.getElementById("list");
  list.innerHTML = "";

  data.forEach(doc => {
    const li = document.createElement("li");

    li.innerHTML = `
      <strong>${doc.name}</strong><br>
      Status: ${doc.status}<br>
      Routed to: ${doc.route}<br>
      <button onclick="update(${doc.id}, 'Approved')">Approve</button>
      <button onclick="update(${doc.id}, 'Rejected')">Reject</button>
    `;

    list.appendChild(li);
  });
}

async function update(id, status) {
  await fetch("/update", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ id, status })
  });

  loadDocs();
}

// Load documents on start
loadDocs();