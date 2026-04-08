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
let isDragging = false;

function setupFieldPlacement() {
  const container = document.getElementById('pdf-container');

  container.addEventListener('mousedown', (e) => {
    // Ignore if clicking an existing field marker (handled by its own drag)
    if (e.target.closest('.field-marker')) return;

    const canvas = container.querySelector('canvas');
    if (!canvas) return;
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    const role = document.getElementById('field-role').value;
    const type = document.getElementById('field-type').value;
    const customLabel = document.getElementById('field-label').value.trim();

    const typeLabels = { text: 'Text', name: 'Full Name', date: 'Date', initials: 'Initials', signature: 'Signature' };
    const label = customLabel || typeLabels[type];

    const fieldW = type === 'signature' ? 180 : 150;
    const fieldH = type === 'signature' ? 50 : 18;

    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    // Create the field immediately at the mousedown point
    const field = {
      id: 'field_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
      role,
      type,
      label,
      page: state.currentPage - 1,
      x: (clickX * scaleX / state.scale) - fieldW / 2,
      y: ((canvas.height - clickY * scaleY) / state.scale) - fieldH / 2,
      width: fieldW,
      height: fieldH,
      fontSize: 11,
      displayX: clickX / rect.width * 100,
      displayY: clickY / rect.height * 100
    };

    state.fields.push(field);
    document.getElementById('field-label').value = '';
    renderFieldMarkers();
    updateFieldSummary();

    // Find the marker we just created and start dragging it immediately
    const marker = [...container.querySelectorAll('.field-marker')].find(m => {
      const removeBtn = m.querySelector('.remove-field');
      return removeBtn && removeBtn.dataset.id === field.id;
    });
    if (marker) marker.classList.add('dragging');

    // Hide the target cursor during drag
    const cursor = document.getElementById('target-cursor');
    cursor.style.display = 'none';

    function onMove(ev) {
      const dx = ev.clientX - (rect.left + clickX);
      const dy = ev.clientY - (rect.top + clickY);

      const newDisplayX = field.displayX + (dx / rect.width * 100);
      const newDisplayY = field.displayY + (dy / rect.height * 100);

      // Clamp within the canvas bounds (0-100%)
      field.displayX = Math.max(0, Math.min(100, (e.clientX - rect.left + (ev.clientX - e.clientX)) / rect.width * 100));
      field.displayY = Math.max(0, Math.min(100, (e.clientY - rect.top + (ev.clientY - e.clientY)) / rect.height * 100));

      if (marker) {
        marker.style.left = field.displayX + '%';
        marker.style.top = field.displayY + '%';
      }

      // Update PDF coordinates
      const pdfClickX = (field.displayX / 100) * rect.width;
      const pdfClickY = (field.displayY / 100) * rect.height;
      field.x = (pdfClickX * scaleX / state.scale) - field.width / 2;
      field.y = ((canvas.height - pdfClickY * scaleY) / state.scale) - field.height / 2;
    }

    function onUp() {
      if (marker) marker.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Re-show cursor
      cursor.style.display = 'block';
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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

    // Drag to reposition
    setupDrag(marker, field, container);

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

function setupDrag(marker, field, container) {
  let startX, startY, startDisplayX, startDisplayY, hasMoved;

  marker.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('remove-field')) return;
    e.preventDefault();
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    startDisplayX = field.displayX;
    startDisplayY = field.displayY;
    marker.classList.add('dragging');

    const canvas = container.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;

      const newDisplayX = startDisplayX + (dx / rect.width * 100);
      const newDisplayY = startDisplayY + (dy / rect.height * 100);

      field.displayX = newDisplayX;
      field.displayY = newDisplayY;
      marker.style.left = newDisplayX + '%';
      marker.style.top = newDisplayY + '%';

      // Update PDF coordinates to match
      const pdfClickX = (newDisplayX / 100) * rect.width;
      const pdfClickY = (newDisplayY / 100) * rect.height;
      field.x = (pdfClickX * scaleX / state.scale) - field.width / 2;
      field.y = ((canvas.height - pdfClickY * scaleY) / state.scale) - field.height / 2;
    }

    function onUp() {
      marker.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (hasMoved) {
        isDragging = true; // prevent click handler from adding a new field
      }
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
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
      <div class="doc-actions">
        ${d.status === 'draft' ? `<a href="/sign/${d.id}?role=sender" class="btn btn-sm">Sign</a>` : ''}
        ${d.status === 'awaiting_recipient' ? `<a href="/sign/${d.id}?role=recipient" class="btn btn-sm">View</a>` : ''}
        ${d.status === 'completed' ? `<a href="/api/documents/${d.id}/pdf" class="btn btn-sm btn-success" download>Download</a>` : ''}
        <button class="btn btn-sm btn-delete" onclick="deleteDocument('${d.id}', '${d.title.replace(/'/g, "\\'")}')">&#10005;</button>
      </div>
    </div>
  `).join('');
}

// --------------- Delete Document ---------------
async function deleteDocument(id, title) {
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
  const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
  if (res.ok) {
    showToast('Document deleted');
    loadDocuments();
  } else {
    showToast('Failed to delete document');
  }
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
