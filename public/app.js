// ============== E-Sign: Main App ==============

let state = {
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  fields: [],
  pdfSource: null,
  templateName: null,
  uploadedPath: null,
  scale: 1.5
};

// --------------- Init ---------------
document.addEventListener('DOMContentLoaded', () => {
  loadTemplates();
  loadDocuments();
  setupSourceToggle();
  setupFieldPlacement();
  setupPageNav();
  setupTargetCursor();

  document.getElementById('btn-prepare').addEventListener('click', prepareDocument);
  document.getElementById('btn-done-fields').addEventListener('click', finishFieldPlacement);
  document.getElementById('btn-undo').addEventListener('click', removeLastField);
});

// --------------- Target Cursor ---------------
function setupTargetCursor() {
  const cursor = document.getElementById('target-cursor');
  const container = document.getElementById('pdf-container');

  container.addEventListener('mouseenter', () => {
    cursor.style.display = 'block';
    updateCursorColor();
  });

  container.addEventListener('mouseleave', () => {
    cursor.style.display = 'none';
  });

  container.addEventListener('mousemove', (e) => {
    cursor.style.left = e.clientX + 'px';
    cursor.style.top = e.clientY + 'px';
  });

  // Update cursor color when role changes
  document.getElementById('field-role').addEventListener('change', updateCursorColor);
}

function updateCursorColor() {
  const cursor = document.getElementById('target-cursor');
  const role = document.getElementById('field-role').value;
  cursor.classList.toggle('recipient-mode', role === 'recipient');
}

// --------------- Templates ---------------
async function loadTemplates() {
  const res = await fetch('/api/templates');
  const templates = await res.json();
  const select = document.getElementById('template-select');
  select.innerHTML = '';
  templates.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.name;
    opt.textContent = t.name.replace('.pdf', '').replace(/-/g, ' ');
    select.appendChild(opt);
  });
}

function setupSourceToggle() {
  const btnTemplate = document.getElementById('btn-template');
  const btnUpload = document.getElementById('btn-upload');

  btnTemplate.addEventListener('click', () => {
    btnTemplate.classList.add('active');
    btnUpload.classList.remove('active');
    document.getElementById('template-section').style.display = '';
    document.getElementById('upload-section').style.display = 'none';
  });

  btnUpload.addEventListener('click', () => {
    btnUpload.classList.add('active');
    btnTemplate.classList.remove('active');
    document.getElementById('upload-section').style.display = '';
    document.getElementById('template-section').style.display = 'none';
  });
}

// --------------- Prepare Document ---------------
async function prepareDocument() {
  const title = document.getElementById('doc-title').value.trim();
  const senderName = document.getElementById('sender-name').value.trim();
  const senderEmail = document.getElementById('sender-email').value.trim();
  const recipientName = document.getElementById('recipient-name').value.trim();
  const recipientEmail = document.getElementById('recipient-email').value.trim();

  if (!title || !senderName || !senderEmail || !recipientName || !recipientEmail) {
    showToast('Please fill in all fields');
    return;
  }

  state.docInfo = { title, senderName, senderEmail, recipientName, recipientEmail };

  const isTemplate = document.getElementById('btn-template').classList.contains('active');
  let pdfUrl;

  if (isTemplate) {
    state.templateName = document.getElementById('template-select').value;
    pdfUrl = `/api/templates/${encodeURIComponent(state.templateName)}`;
  } else {
    const fileInput = document.getElementById('pdf-upload');
    if (!fileInput.files[0]) { showToast('Please select a PDF'); return; }
    const formData = new FormData();
    formData.append('pdf', fileInput.files[0]);
    const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
    const uploadData = await uploadRes.json();
    state.uploadedPath = uploadData.path;
    pdfUrl = `/uploads/${uploadData.path.split(/[/\\]/).pop()}`;
  }

  const loadingTask = pdfjsLib.getDocument(pdfUrl);
  state.pdfDoc = await loadingTask.promise;
  state.totalPages = state.pdfDoc.numPages;
  state.currentPage = 1;
  state.fields = [];

  document.getElementById('step-setup').style.display = 'none';
  document.getElementById('step-fields').style.display = '';
  document.getElementById('doc-list').style.display = 'none';
  document.querySelector('main').classList.add('workspace-mode');

  renderPage(state.currentPage);
}

// --------------- PDF Rendering ---------------
async function renderPage(num) {
  const page = await state.pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: state.scale });

  const container = document.getElementById('pdf-container');

  const oldCanvas = container.querySelector('canvas');
  if (oldCanvas) oldCanvas.remove();

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  container.prepend(canvas);

  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  document.getElementById('page-indicator').textContent = `Page ${num} of ${state.totalPages}`;
  renderFieldMarkers();
}

// --------------- Field Placement ---------------
function setupFieldPlacement() {
  document.getElementById('pdf-container').addEventListener('click', (e) => {
    if (e.target.closest('.field-marker')) return;

    const container = document.getElementById('pdf-container');
    const canvas = container.querySelector('canvas');
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const clickX = (e.clientX - rect.left);
    const clickY = (e.clientY - rect.top);

    const pdfX = (e.clientX - rect.left) * scaleX / state.scale;
    const pdfY = (canvas.height - (e.clientY - rect.top) * scaleY) / state.scale;

    const role = document.getElementById('field-role').value;
    const type = document.getElementById('field-type').value;
    const customLabel = document.getElementById('field-label').value.trim();

    const typeLabels = { text: 'Text', name: 'Full Name', date: 'Date', initials: 'Initials', signature: 'Signature' };
    const label = customLabel || typeLabels[type];

    const field = {
      id: 'field_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      role,
      type,
      label,
      page: state.currentPage - 1,
      x: pdfX,
      y: pdfY - (type === 'signature' ? 40 : 12),
      width: type === 'signature' ? 180 : 150,
      height: type === 'signature' ? 50 : 18,
      fontSize: 11,
      displayX: clickX / rect.width * 100,
      displayY: clickY / rect.height * 100
    };

    state.fields.push(field);
    document.getElementById('field-label').value = '';
    renderFieldMarkers();
    updateFieldSummary();

    // Brief pulse animation on the cursor
    const cursor = document.getElementById('target-cursor');
    cursor.style.transition = 'transform 0.15s';
    cursor.style.transform = 'translate(-50%, -50%) scale(1.4)';
    setTimeout(() => {
      cursor.style.transform = 'translate(-50%, -50%) scale(1)';
    }, 150);
  });
}

function renderFieldMarkers() {
  const container = document.getElementById('pdf-container');
  container.querySelectorAll('.field-marker').forEach(m => m.remove());

  const pageFields = state.fields.filter(f => f.page === state.currentPage - 1);

  pageFields.forEach((field) => {
    const marker = document.createElement('div');
    marker.className = `field-marker ${field.role}`;
    marker.style.left = field.displayX + '%';
    marker.style.top = field.displayY + '%';

    const roleLabel = field.role === 'sender' ? 'You' : 'Them';
    marker.innerHTML = `<span>${roleLabel}: ${field.label}</span><span class="remove-field" data-id="${field.id}">&times;</span>`;

    container.appendChild(marker);
  });

  container.querySelectorAll('.remove-field').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = e.target.dataset.id;
      state.fields = state.fields.filter(f => f.id !== id);
      renderFieldMarkers();
      updateFieldSummary();
    });
  });
}

function removeLastField() {
  const pageFields = state.fields.filter(f => f.page === state.currentPage - 1);
  if (pageFields.length > 0) {
    const lastId = pageFields[pageFields.length - 1].id;
    state.fields = state.fields.filter(f => f.id !== lastId);
    renderFieldMarkers();
    updateFieldSummary();
  }
}

function updateFieldSummary() {
  const summary = document.getElementById('field-summary');
  if (state.fields.length === 0) {
    summary.innerHTML = '<p class="hint">No fields placed yet. Click on the PDF to add fields.</p>';
    return;
  }

  const senderFields = state.fields.filter(f => f.role === 'sender');
  const recipientFields = state.fields.filter(f => f.role === 'recipient');

  let html = '<p style="font-size:13px;color:var(--muted);margin-bottom:6px">Fields placed:</p>';
  senderFields.forEach(f => {
    html += `<span class="field-summary-item sender">You: ${f.label} (p${f.page + 1})</span>`;
  });
  recipientFields.forEach(f => {
    html += `<span class="field-summary-item recipient">Them: ${f.label} (p${f.page + 1})</span>`;
  });
  summary.innerHTML = html;
}

// --------------- Page Navigation ---------------
function setupPageNav() {
  document.getElementById('btn-prev-page').addEventListener('click', () => {
    if (state.currentPage > 1) {
      state.currentPage--;
      renderPage(state.currentPage);
    }
  });
  document.getElementById('btn-next-page').addEventListener('click', () => {
    if (state.currentPage < state.totalPages) {
      state.currentPage++;
      renderPage(state.currentPage);
    }
  });
}

// --------------- Finish & Create Document ---------------
async function finishFieldPlacement() {
  if (state.fields.length === 0) {
    showToast('Please place at least one field on the document');
    return;
  }

  const hasSenderSig = state.fields.some(f => f.role === 'sender' && f.type === 'signature');
  const hasRecipientSig = state.fields.some(f => f.role === 'recipient' && f.type === 'signature');

  if (!hasSenderSig || !hasRecipientSig) {
    if (!confirm('You haven\'t placed signature fields for both parties. Continue anyway?')) return;
  }

  const body = {
    title: state.docInfo.title,
    templateName: state.templateName || undefined,
    pdfSource: state.uploadedPath || undefined,
    senderName: state.docInfo.senderName,
    senderEmail: state.docInfo.senderEmail,
    recipientName: state.docInfo.recipientName,
    recipientEmail: state.docInfo.recipientEmail,
    fields: state.fields
  };

  const res = await fetch('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  if (data.id) {
    window.location.href = `/sign/${data.id}?role=sender`;
  }
}

// --------------- Documents List ---------------
async function loadDocuments() {
  const res = await fetch('/api/documents');
  const docs = await res.json();
  const container = document.getElementById('documents-table');

  if (docs.length === 0) {
    container.innerHTML = '<div class="empty-state">No documents yet. Create one above!</div>';
    return;
  }

  const statusLabel = { draft: 'Draft', awaiting_recipient: 'Awaiting Signature', completed: 'Completed' };
  const statusClass = { draft: 'draft', awaiting_recipient: 'awaiting', completed: 'completed' };

  container.innerHTML = docs.map(d => `
    <div class="doc-row">
      <div>
        <div class="title">${d.title}</div>
        <div class="meta">${d.sender_name} &rarr; ${d.recipient_name || 'N/A'}</div>
      </div>
      <div><span class="status-badge ${statusClass[d.status]}">${statusLabel[d.status] || d.status}</span></div>
      <div class="meta">${new Date(d.created_at).toLocaleDateString()}</div>
      <div>
        ${d.status === 'draft' ? `<a href="/sign/${d.id}?role=sender" class="btn btn-sm">Sign</a>` : ''}
        ${d.status === 'awaiting_recipient' ? `<a href="/sign/${d.id}?role=recipient" class="btn btn-sm">View</a>` : ''}
        ${d.status === 'completed' ? `<a href="/api/documents/${d.id}/pdf" class="btn btn-sm btn-success" download>Download</a>` : ''}
      </div>
    </div>
  `).join('');
}

// --------------- Toast ---------------
function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}
