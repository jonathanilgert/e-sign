// ============== E-Sign: Main App ==============

let state = {
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  fields: [],
  pdfSource: null,
  templateName: null,
  uploadedPath: null,
  savedPdfPath: null,
  loadedSavedTemplate: null,
  scale: 1.5
};

// --------------- Init ---------------
document.addEventListener('DOMContentLoaded', () => {
  loadTemplates();
  loadDocuments();
  loadSavedTemplates();
  setupSourceToggle();
  setupFieldPlacement();
  setupPageNav();
  setupTargetCursor();

  document.getElementById('btn-prepare').addEventListener('click', prepareDocument);
  document.getElementById('btn-done-fields').addEventListener('click', finishFieldPlacement);
  document.getElementById('btn-undo').addEventListener('click', removeLastField);
  document.getElementById('btn-save-template').addEventListener('click', saveFieldsAsTemplate);
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
  const btnSaved = document.getElementById('btn-saved');
  const sections = ['template-section', 'upload-section', 'saved-section'];

  function activate(activeBtn, showSection) {
    [btnTemplate, btnUpload, btnSaved].forEach(b => b.classList.remove('active'));
    activeBtn.classList.add('active');
    sections.forEach(s => document.getElementById(s).style.display = 'none');
    document.getElementById(showSection).style.display = '';
  }

  btnTemplate.addEventListener('click', () => activate(btnTemplate, 'template-section'));
  btnUpload.addEventListener('click', () => activate(btnUpload, 'upload-section'));
  btnSaved.addEventListener('click', () => {
    activate(btnSaved, 'saved-section');
    populateSavedSelect();
  });
}

// --------------- Prepare Document ---------------
async function prepareDocument() {
  const title = document.getElementById('doc-title').value.trim();
  const senderName = document.getElementById('sender-name').value.trim();
  const senderEmail = document.getElementById('sender-email').value.trim();
  const recipientName = document.getElementById('recipient-name').value.trim();
  const recipientEmail = document.getElementById('recipient-email').value.trim();

  const isSaved = document.getElementById('btn-saved').classList.contains('active');
  const isTemplate = document.getElementById('btn-template').classList.contains('active');

  // For "ready_to_send" saved templates, only need recipient + title
  if (isSaved && state.loadedSavedTemplate && state.loadedSavedTemplate.stage === 'ready_to_send') {
    if (!recipientName || !recipientEmail) {
      showToast('Please fill in recipient name and email');
      return;
    }
    await quickSend(state.loadedSavedTemplate, title, recipientName, recipientEmail);
    return;
  }

  if (!title || !senderName || !senderEmail) {
    showToast('Please fill in document title and your info');
    return;
  }

  state.docInfo = { title, senderName, senderEmail, recipientName, recipientEmail };

  let pdfUrl;

  if (isSaved) {
    const selectEl = document.getElementById('saved-select');
    const templateId = selectEl.value;
    if (!templateId) { showToast('Please select a saved template'); return; }

    const res = await fetch(`/api/saved-templates/${templateId}`);
    const saved = await res.json();
    state.loadedSavedTemplate = saved;

    // Restore fields with fresh IDs to avoid collisions
    state.fields = saved.fields.map(f => ({
      ...f,
      id: 'field_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4)
    }));

    if (saved.template_name) {
      state.templateName = saved.template_name;
      pdfUrl = `/api/templates/${encodeURIComponent(saved.template_name)}`;
    } else if (saved.uploaded_pdf_path) {
      state.savedPdfPath = saved.uploaded_pdf_path;
      pdfUrl = `/uploads/${saved.uploaded_pdf_path.split(/[/\\]/).pop()}`;
    }
  } else if (isTemplate) {
    state.templateName = document.getElementById('template-select').value;
    pdfUrl = `/api/templates/${encodeURIComponent(state.templateName)}`;
    state.fields = [];
  } else {
    const fileInput = document.getElementById('pdf-upload');
    if (!fileInput.files[0]) { showToast('Please select a PDF'); return; }
    const formData = new FormData();
    formData.append('pdf', fileInput.files[0]);
    const uploadRes = await fetch('/api/upload', { method: 'POST', body: formData });
    const uploadData = await uploadRes.json();
    state.uploadedPath = uploadData.path;
    pdfUrl = `/uploads/${uploadData.path.split(/[/\\]/).pop()}`;
    state.fields = [];
  }

  const loadingTask = pdfjsLib.getDocument(pdfUrl);
  state.pdfDoc = await loadingTask.promise;
  state.totalPages = state.pdfDoc.numPages;
  state.currentPage = 1;

  document.getElementById('step-setup').style.display = 'none';
  document.getElementById('step-fields').style.display = '';
  document.getElementById('doc-list').style.display = 'none';
  document.getElementById('saved-templates-section').style.display = 'none';
  document.querySelector('main').classList.add('workspace-mode');

  renderPage(state.currentPage);
  if (state.fields.length > 0) updateFieldSummary();
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

    const fieldW = type === 'signature' ? 180 : (type === 'initials' ? 50 : 120);
    const fieldH = type === 'signature' ? 50 : (type === 'initials' ? 18 : 20);

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

  const canvas = container.querySelector('canvas');

  pageFields.forEach((field) => {
    const marker = document.createElement('div');
    marker.className = `field-marker ${field.role}`;
    marker.style.left = field.displayX + '%';
    marker.style.top = field.displayY + '%';

    // Show actual field size scaled to display
    if (canvas) {
      const displayScale = canvas.getBoundingClientRect().width / canvas.width;
      marker.style.width = (field.width * state.scale * displayScale) + 'px';
      marker.style.height = (field.height * state.scale * displayScale) + 'px';
    }

    const roleLabel = field.role === 'sender' ? 'You' : 'Them';
    marker.innerHTML = `<span class="field-marker-label">${roleLabel}: ${field.label}</span><span class="remove-field" data-id="${field.id}">&times;</span>`;

    // Add resize handle for non-signature fields
    if (field.type !== 'signature') {
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'resize-handle';
      marker.appendChild(resizeHandle);
      setupResize(resizeHandle, marker, field, container);
    }

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

function setupResize(handle, marker, field, container) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = marker.offsetWidth;
    const startHeight = marker.offsetHeight;

    const canvas = container.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const displayScale = rect.width / canvas.width;

    // Hide cursor during resize
    const cursor = document.getElementById('target-cursor');
    cursor.style.display = 'none';

    function onMove(ev) {
      const newW = Math.max(40, startWidth + (ev.clientX - startX));
      const newH = Math.max(16, startHeight + (ev.clientY - startY));
      marker.style.width = newW + 'px';
      marker.style.height = newH + 'px';

      // Update PDF dimensions
      field.width = newW / (state.scale * displayScale);
      field.height = newH / (state.scale * displayScale);
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      cursor.style.display = 'block';
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

  if (!state.docInfo.recipientName || !state.docInfo.recipientEmail) {
    showToast('Please go back and fill in the recipient name and email');
    return;
  }

  const body = {
    title: state.docInfo.title,
    templateName: state.templateName || undefined,
    pdfSource: state.uploadedPath || undefined,
    savedTemplatePdf: state.savedPdfPath || undefined,
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

// --------------- Saved Templates ---------------

async function loadSavedTemplates() {
  const res = await fetch('/api/saved-templates');
  const templates = await res.json();
  const container = document.getElementById('saved-templates-list');

  if (templates.length === 0) {
    container.innerHTML = '<div class="empty-state">No saved templates yet. Place fields on a document and click "Save as Template".</div>';
    return;
  }

  const stageLabel = { fields_placed: 'Fields Only', ready_to_send: 'Ready to Send' };
  const stageClass = { fields_placed: 'fields-placed', ready_to_send: 'ready-to-send' };

  container.innerHTML = templates.map(t => `
    <div class="doc-row">
      <div>
        <div class="title">${t.name}</div>
        <div class="meta">${t.doc_title || 'No title'}</div>
      </div>
      <div><span class="status-badge ${stageClass[t.stage]}">${stageLabel[t.stage]}</span></div>
      <div class="meta">${new Date(t.created_at).toLocaleDateString()}</div>
      <div class="doc-actions">
        <button class="btn btn-sm btn-primary" onclick="useSavedTemplate('${t.id}')">Use</button>
        <button class="btn btn-sm btn-delete" onclick="deleteSavedTemplate('${t.id}', '${t.name.replace(/'/g, "\\'")}')">&times;</button>
      </div>
    </div>
  `).join('');
}

async function populateSavedSelect() {
  const res = await fetch('/api/saved-templates');
  const templates = await res.json();
  const select = document.getElementById('saved-select');
  select.innerHTML = '<option value="">-- Select a saved template --</option>';

  templates.forEach(t => {
    const stageLabel = t.stage === 'ready_to_send' ? ' [Ready to Send]' : ' [Fields Only]';
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name + stageLabel;
    select.appendChild(opt);
  });

  // Show info when selection changes
  select.addEventListener('change', async () => {
    const info = document.getElementById('saved-template-info');
    if (!select.value) { info.textContent = ''; state.loadedSavedTemplate = null; return; }
    const r = await fetch(`/api/saved-templates/${select.value}`);
    const saved = await r.json();
    state.loadedSavedTemplate = saved;

    if (saved.stage === 'ready_to_send') {
      info.textContent = `Ready to send: ${saved.fields.length} fields, sender pre-filled as ${saved.sender_name}. Just enter recipient info and click Prepare.`;
      // Pre-fill sender fields
      document.getElementById('sender-name').value = saved.sender_name || '';
      document.getElementById('sender-email').value = saved.sender_email || '';
      if (saved.doc_title) document.getElementById('doc-title').value = saved.doc_title;
    } else {
      info.textContent = `${saved.fields.length} fields placed. You'll fill in details and sign after loading.`;
      if (saved.doc_title) document.getElementById('doc-title').value = saved.doc_title;
    }
  });
}

async function saveFieldsAsTemplate() {
  if (state.fields.length === 0) {
    showToast('Place some fields first');
    return;
  }

  const name = prompt('Name this template (e.g. "Office Lease - 914 19th Ave"):');
  if (!name) return;

  const body = {
    name,
    stage: 'fields_placed',
    templateName: state.templateName || null,
    uploadedPdfPath: state.uploadedPath || state.savedPdfPath || null,
    fields: state.fields,
    docTitle: state.docInfo ? state.docInfo.title : '',
    senderName: state.docInfo ? state.docInfo.senderName : null,
    senderEmail: state.docInfo ? state.docInfo.senderEmail : null
  };

  const res = await fetch('/api/saved-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.ok) {
    showToast('Template saved! You can reuse it from the dashboard.');
  } else {
    showToast('Failed to save template');
  }
}

async function useSavedTemplate(id) {
  const res = await fetch(`/api/saved-templates/${id}`);
  const saved = await res.json();

  // Switch to saved template source
  document.getElementById('btn-saved').click();

  // Set the select value
  const select = document.getElementById('saved-select');
  await populateSavedSelect();
  select.value = id;
  select.dispatchEvent(new Event('change'));

  // Pre-fill form fields
  if (saved.doc_title) document.getElementById('doc-title').value = saved.doc_title;
  if (saved.sender_name) document.getElementById('sender-name').value = saved.sender_name;
  if (saved.sender_email) document.getElementById('sender-email').value = saved.sender_email;

  // Scroll to setup section
  document.getElementById('step-setup').scrollIntoView({ behavior: 'smooth' });
}

async function quickSend(saved, title, recipientName, recipientEmail) {
  // For "ready_to_send" templates: create doc, auto-sign sender, send to recipient
  const btn = document.getElementById('btn-prepare');
  btn.disabled = true;
  btn.textContent = 'Sending...';

  try {
    // Generate fresh field IDs
    const fields = saved.fields.map(f => ({
      ...f,
      id: 'field_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
    }));

    // Remap sender field values to new IDs
    const senderFieldValues = {};
    if (saved.sender_field_values) {
      const oldFields = saved.fields.filter(f => f.role === 'sender' && f.type !== 'signature');
      oldFields.forEach((oldField, i) => {
        const newField = fields.find((nf, j) => saved.fields[j] === oldField);
        const idx = saved.fields.indexOf(oldField);
        if (idx >= 0 && saved.sender_field_values[oldField.id]) {
          senderFieldValues[fields[idx].id] = saved.sender_field_values[oldField.id];
        }
      });
    }

    // 1. Create the document
    const docBody = {
      title: title || saved.doc_title || 'Untitled',
      templateName: saved.template_name || undefined,
      savedTemplatePdf: saved.uploaded_pdf_path || undefined,
      senderName: saved.sender_name,
      senderEmail: saved.sender_email,
      recipientName,
      recipientEmail,
      fields
    };

    const createRes = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(docBody)
    });
    const docData = await createRes.json();
    if (!docData.id) throw new Error('Failed to create document');

    // 2. Auto-sign as sender
    const signRes = await fetch(`/api/documents/${docData.id}/sign-sender`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fieldValues: senderFieldValues,
        signatureDataUrl: saved.sender_signature,
        attestation: true
      })
    });
    const signData = await signRes.json();

    if (signData.success) {
      showToast(`Document sent to ${recipientName}!`);
      loadDocuments();
      // Clear form
      document.getElementById('recipient-name').value = '';
      document.getElementById('recipient-email').value = '';
    } else {
      throw new Error(signData.error || 'Signing failed');
    }
  } catch (err) {
    showToast('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Prepare Document';
  }
}

async function deleteSavedTemplate(id, name) {
  if (!confirm(`Delete saved template "${name}"?`)) return;
  const res = await fetch(`/api/saved-templates/${id}`, { method: 'DELETE' });
  if (res.ok) {
    showToast('Template deleted');
    loadSavedTemplates();
  } else {
    showToast('Failed to delete template');
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
