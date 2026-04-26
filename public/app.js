// ============== Penned: Main App ==============

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
  scale: 1.5,
  allDocs: [],       // full doc list for filtering
  currentView: 'dashboard'
};

// --------------- Auth & CSRF Helpers ---------------
let _csrfToken = null;

function getAuthToken() {
  return localStorage.getItem('esign_token');
}

function getAuthHeaders() {
  const token = getAuthToken();
  const headers = token ? { 'Authorization': 'Bearer ' + token } : {};
  if (_csrfToken) headers['X-CSRF-Token'] = _csrfToken;
  return headers;
}

async function fetchCsrfToken() {
  try {
    const res = await fetch('/api/csrf-token', { headers: { 'Authorization': 'Bearer ' + (getAuthToken() || '') } });
    const data = await res.json();
    _csrfToken = data.token;
  } catch (e) { /* non-critical */ }
}

async function authFetch(url, options = {}) {
  if (!_csrfToken) await fetchCsrfToken();
  options.headers = { ...getAuthHeaders(), ...(options.headers || {}) };
  const res = await fetch(url, options);
  if (res.status === 401) {
    localStorage.removeItem('esign_token');
    localStorage.removeItem('esign_user');
    window.location.replace('/login');
    throw new Error('Session expired');
  }
  if (res.status === 403) {
    // CSRF token may be stale — refresh and retry once
    const data = await res.clone().json().catch(() => ({}));
    if (data.error && data.error.includes('CSRF')) {
      await fetchCsrfToken();
      options.headers = { ...getAuthHeaders(), ...(options.headers || {}) };
      return fetch(url, options);
    }
  }
  return res;
}

function logout() {
  const token = getAuthToken();
  if (token) {
    fetch('/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'X-CSRF-Token': _csrfToken || '' }
    });
  }
  localStorage.removeItem('esign_token');
  localStorage.removeItem('esign_user');
  window.location.replace('/');
}

// --------------- Init ---------------
document.addEventListener('DOMContentLoaded', async () => {
  // Auth gate
  if (!getAuthToken()) {
    window.location.replace('/login');
    return;
  }

  // Verify token
  try {
    const meRes = await fetch('/api/auth/me', { headers: getAuthHeaders() });
    if (!meRes.ok) {
      localStorage.removeItem('esign_token');
      localStorage.removeItem('esign_user');
      window.location.replace('/login');
      return;
    }
    const user = await meRes.json();
    localStorage.setItem('esign_user', JSON.stringify(user));
    updateUserDisplay(user);
  } catch (e) {
    window.location.replace('/login');
    return;
  }

  // Check for billing return from Stripe Checkout
  checkBillingReturn();

  // Dashboard
  loadStats();
  loadDocuments();
  loadSavedTemplates();
  setupDocFilters();

  // Nav dropdown
  setupNavDropdown();

  // New doc button
  document.getElementById('btn-new-doc').addEventListener('click', () => showView('create'));
  document.getElementById('btn-back-dashboard').addEventListener('click', () => showView('dashboard'));

  // Document creation flow
  loadTemplates();
  setupSourceToggle();
  setupFieldPlacement();
  setupPageNav();
  setupTargetCursor();

  document.getElementById('btn-prepare').addEventListener('click', prepareDocument);
  document.getElementById('btn-done-fields').addEventListener('click', finishFieldPlacement);
  document.getElementById('btn-undo').addEventListener('click', removeLastField);
  document.getElementById('btn-save-template').addEventListener('click', saveFieldsAsTemplate);
});

// --------------- View Switching ---------------
function showView(view) {
  state.currentView = view;
  document.getElementById('view-dashboard').style.display = view === 'dashboard' ? '' : 'none';
  document.getElementById('view-create').style.display = view === 'create' ? '' : 'none';

  if (view === 'dashboard') {
    loadStats();
    loadDocuments();
    loadSavedTemplates();
    // Reset creation state
    document.getElementById('step-setup').style.display = '';
    document.getElementById('step-fields').style.display = 'none';
    document.querySelector('main').classList.remove('workspace-mode');
    state.pdfDoc = null;
    state.fields = [];
    state.templateName = null;
    state.uploadedPath = null;
    state.savedPdfPath = null;
    state.loadedSavedTemplate = null;
    state.prefillFieldValues = null;
    state.prefillSignature = null;
    // Reset form
    document.getElementById('doc-title').value = '';
    document.getElementById('recipient-name').value = '';
    document.getElementById('recipient-email').value = '';
    // Re-fill sender from user info
    const user = JSON.parse(localStorage.getItem('esign_user') || '{}');
    if (user.name) document.getElementById('sender-name').value = user.name;
    if (user.email) document.getElementById('sender-email').value = user.email;
  }

  if (view === 'create') {
    // Pre-fill sender info
    const user = JSON.parse(localStorage.getItem('esign_user') || '{}');
    const sn = document.getElementById('sender-name');
    const se = document.getElementById('sender-email');
    if (sn && !sn.value && user.name) sn.value = user.name;
    if (se && !se.value && user.email) se.value = user.email;
  }
}

// --------------- User Display & Nav ---------------
function updateUserDisplay(user) {
  const nameEl = document.getElementById('nav-user-name');
  const avatarEl = document.getElementById('nav-avatar');
  if (nameEl) nameEl.textContent = user.name;
  if (avatarEl) avatarEl.textContent = (user.name || 'U').charAt(0).toUpperCase();

  // Plan badge
  const badge = document.getElementById('nav-plan-badge');
  if (badge) {
    if (user.plan_type === 'unlimited') {
      badge.textContent = 'PRO';
      badge.className = 'plan-badge plan-pro';
    } else {
      badge.textContent = 'FREE';
      badge.className = 'plan-badge plan-free';
    }
  }

  // Pre-fill sender fields
  const senderName = document.getElementById('sender-name');
  const senderEmail = document.getElementById('sender-email');
  if (senderName && !senderName.value) senderName.value = user.name;
  if (senderEmail && !senderEmail.value) senderEmail.value = user.email;
}

function setupNavDropdown() {
  const btn = document.getElementById('nav-user-btn');
  const dropdown = document.getElementById('nav-dropdown');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    dropdown.classList.remove('open');
  });

  document.getElementById('menu-logout').addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });

  document.getElementById('menu-settings').addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/settings';
  });

  document.getElementById('menu-billing').addEventListener('click', (e) => {
    e.preventDefault();
    window.location.href = '/settings#account';
  });
}

// --------------- Stats ---------------
async function loadStats() {
  try {
    const res = await authFetch('/api/stats');
    const stats = await res.json();

    let sentText;
    if (stats.plan_type === 'unlimited') {
      sentText = `${stats.sent_this_month} this month`;
    } else {
      sentText = `${stats.sent_this_month} of 3 free`;
    }

    document.getElementById('stat-sent').textContent = sentText;
    document.getElementById('stat-awaiting').textContent = stats.awaiting;
    document.getElementById('stat-completed').textContent = stats.completed;
  } catch (e) { /* stats are non-critical */ }
}

// --------------- Document Filters ---------------
function setupDocFilters() {
  document.getElementById('doc-search').addEventListener('input', renderFilteredDocs);
  document.getElementById('doc-status-filter').addEventListener('change', renderFilteredDocs);
  document.getElementById('doc-sort').addEventListener('change', renderFilteredDocs);
}

function renderFilteredDocs() {
  const search = document.getElementById('doc-search').value.toLowerCase().trim();
  const statusFilter = document.getElementById('doc-status-filter').value;
  const sort = document.getElementById('doc-sort').value;

  let docs = [...state.allDocs];

  // Filter by search
  if (search) {
    docs = docs.filter(d =>
      (d.title || '').toLowerCase().includes(search) ||
      (d.recipient_name || '').toLowerCase().includes(search) ||
      (d.recipient_email || '').toLowerCase().includes(search)
    );
  }

  // Filter by status
  if (statusFilter !== 'all') {
    docs = docs.filter(d => d.status === statusFilter);
  }

  // Sort
  if (sort === 'date-desc') {
    docs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } else if (sort === 'date-asc') {
    docs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  } else if (sort === 'status') {
    const order = { draft: 0, awaiting_recipient: 1, completed: 2, expired: 3 };
    docs.sort((a, b) => (order[a.status] || 0) - (order[b.status] || 0));
  }

  renderDocTable(docs);
}

// --------------- Documents List ---------------
async function loadDocuments() {
  const res = await authFetch('/api/documents');
  state.allDocs = await res.json();
  renderFilteredDocs();
}

function renderDocTable(docs) {
  const container = document.getElementById('documents-table');

  if (docs.length === 0 && state.allDocs.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div style="font-size:32px;margin-bottom:12px;opacity:0.3">&#128196;</div>
        <p>No documents yet</p>
        <p style="margin-top:4px;font-size:13px">Click <strong>+ New Document</strong> to get started.</p>
      </div>`;
    return;
  }

  if (docs.length === 0) {
    container.innerHTML = '<div class="empty-state">No documents match your filters.</div>';
    return;
  }

  const statusLabel = { draft: 'Draft', awaiting_recipient: 'Awaiting Signature', completed: 'Completed', expired: 'Expired' };
  const statusClass = { draft: 'draft', awaiting_recipient: 'awaiting', completed: 'completed', expired: 'expired' };

  let html = `<div class="doc-table-header">
    <div>Document</div>
    <div>Recipient</div>
    <div>Status</div>
    <div>Date</div>
    <div>Actions</div>
  </div>`;

  html += docs.map(d => {
    const date = new Date(d.created_at);
    const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const escapedTitle = (d.title || '').replace(/'/g, "\\'");

    // Expiration info
    let expiryInfo = '';
    if (d.status === 'awaiting_recipient' && d.expires_at) {
      const expiresDate = new Date(d.expires_at);
      const daysLeft = Math.ceil((expiresDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 0) {
        expiryInfo = '<span class="expiry-tag expiry-urgent">Expired</span>';
      } else if (daysLeft <= 5) {
        expiryInfo = `<span class="expiry-tag expiry-urgent">Expires in ${daysLeft}d</span>`;
      } else {
        expiryInfo = `<span class="expiry-tag">Expires ${expiresDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>`;
      }
    }

    let actions = '';
    if (d.status === 'draft') {
      actions += `<a href="/sign/${d.id}?role=sender" class="btn btn-sm">Sign</a>`;
    }
    if (d.status === 'awaiting_recipient') {
      actions += `<button class="btn btn-sm btn-resend" onclick="remindRecipient('${d.id}')">Resend</button>`;
      actions += `<a href="/sign/${d.id}?role=recipient" class="btn btn-sm">View</a>`;
    }
    if (d.status === 'completed') {
      actions += `<a href="/api/documents/${d.id}/pdf" class="btn btn-sm btn-success" download>Download</a>`;
    }
    if (d.status !== 'completed') {
      actions += `<button class="btn btn-sm btn-delete" onclick="deleteDocument('${d.id}', '${escapedTitle}')">&#10005;</button>`;
    }

    return `<div class="doc-table-row${d.status === 'expired' ? ' doc-expired' : ''}">
      <div>
        <div class="doc-table-title">${d.title}</div>
        ${expiryInfo}
      </div>
      <div>
        <div class="doc-table-recipient">${d.recipient_name || '-'}</div>
        <div class="doc-table-email">${d.recipient_email || ''}</div>
      </div>
      <div><span class="status-badge ${statusClass[d.status] || ''}">${statusLabel[d.status] || d.status}</span></div>
      <div class="doc-table-date">${dateStr}</div>
      <div class="doc-actions">${actions}</div>
    </div>`;
  }).join('');

  container.innerHTML = html;
}

// --------------- Delete Document ---------------
async function deleteDocument(id, title) {
  if (!confirm(`Delete "${title}"? This cannot be undone.`)) return;
  const res = await authFetch(`/api/documents/${id}`, { method: 'DELETE' });
  if (res.ok) {
    showToast('Document deleted');
    loadDocuments();
    loadStats();
  } else {
    showToast('Failed to delete document');
  }
}

// --------------- Resend / Remind ---------------
async function remindRecipient(docId) {
  const res = await authFetch(`/api/documents/${docId}/remind`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  const data = await res.json();
  if (res.ok) {
    showToast(data.message || 'Reminder sent');
  } else {
    showToast(data.error || 'Failed to send reminder');
  }
}

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

  document.getElementById('field-role').addEventListener('change', updateCursorColor);
}

function updateCursorColor() {
  const cursor = document.getElementById('target-cursor');
  const role = document.getElementById('field-role').value;
  cursor.classList.toggle('recipient-mode', role === 'recipient');
}

// --------------- Templates ---------------
async function loadTemplates() {
  const res = await authFetch('/api/templates');
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

  if (!title || !senderName || !senderEmail) {
    showToast('Please fill in document title and your info');
    return;
  }
  if (!recipientName || !recipientEmail) {
    showToast('Please fill in recipient name and email');
    return;
  }

  state.docInfo = { title, senderName, senderEmail, recipientName, recipientEmail };

  let pdfUrl;

  if (isSaved) {
    const selectEl = document.getElementById('saved-select');
    const templateId = selectEl.value;
    if (!templateId) { showToast('Please select a saved template'); return; }

    const res = await authFetch(`/api/saved-templates/${templateId}`);
    const saved = await res.json();
    state.loadedSavedTemplate = saved;

    const idMap = {};
    state.fields = saved.fields.map(f => {
      const newId = 'field_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      idMap[f.id] = newId;
      return { ...f, id: newId };
    });

    if (saved.stage === 'ready_to_send' && saved.sender_field_values) {
      const remapped = {};
      for (const [oldId, val] of Object.entries(saved.sender_field_values)) {
        if (idMap[oldId]) remapped[idMap[oldId]] = val;
      }
      state.prefillFieldValues = remapped;
      state.prefillSignature = saved.sender_signature || null;
    }

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
    const uploadRes = await authFetch('/api/upload', { method: 'POST', body: formData });
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

    const marker = [...container.querySelectorAll('.field-marker')].find(m => {
      const removeBtn = m.querySelector('.remove-field');
      return removeBtn && removeBtn.dataset.id === field.id;
    });
    if (marker) marker.classList.add('dragging');

    const cursor = document.getElementById('target-cursor');
    cursor.style.display = 'none';

    function onMove(ev) {
      field.displayX = Math.max(0, Math.min(100, (e.clientX - rect.left + (ev.clientX - e.clientX)) / rect.width * 100));
      field.displayY = Math.max(0, Math.min(100, (e.clientY - rect.top + (ev.clientY - e.clientY)) / rect.height * 100));

      if (marker) {
        marker.style.left = field.displayX + '%';
        marker.style.top = field.displayY + '%';
      }

      const pdfClickX = (field.displayX / 100) * rect.width;
      const pdfClickY = (field.displayY / 100) * rect.height;
      field.x = (pdfClickX * scaleX / state.scale) - field.width / 2;
      field.y = ((canvas.height - pdfClickY * scaleY) / state.scale) - field.height / 2;
    }

    function onUp() {
      if (marker) marker.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
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

    if (canvas) {
      const displayScale = canvas.getBoundingClientRect().width / canvas.width;
      marker.style.width = (field.width * state.scale * displayScale) + 'px';
      marker.style.height = (field.height * state.scale * displayScale) + 'px';
    }

    const roleLabel = field.role === 'sender' ? 'You' : 'Them';
    marker.innerHTML = `<span class="field-marker-label">${roleLabel}: ${field.label}</span><span class="remove-field" data-id="${field.id}">&times;</span>`;

    if (field.type !== 'signature') {
      const resizeHandle = document.createElement('div');
      resizeHandle.className = 'resize-handle';
      marker.appendChild(resizeHandle);
      setupResize(resizeHandle, marker, field, container);
    }

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
        isDragging = true;
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

    const cursor = document.getElementById('target-cursor');
    cursor.style.display = 'none';

    function onMove(ev) {
      const newW = Math.max(40, startWidth + (ev.clientX - startX));
      const newH = Math.max(16, startHeight + (ev.clientY - startY));
      marker.style.width = newW + 'px';
      marker.style.height = newH + 'px';

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

// --------------- Billing Return Check ---------------

function checkBillingReturn() {
  const params = new URLSearchParams(window.location.search);
  const billing = params.get('billing');
  if (!billing) return;

  // Clean the URL
  window.history.replaceState({}, '', '/');

  switch (billing) {
    case 'per_doc_success':
      showToast('Payment confirmed! You can now send your document.');
      break;
    case 'unlimited_success':
      showToast('Welcome to Unlimited! You can now send unlimited documents.');
      // Refresh user data to pick up new plan
      fetch('/api/auth/me', { headers: getAuthHeaders() }).then(r => r.json()).then(user => {
        localStorage.setItem('esign_user', JSON.stringify(user));
        updateUserDisplay(user);
        loadStats();
      });
      break;
    case 'cancelled':
      // No toast needed for cancel
      break;
  }
}

// --------------- Billing Check ---------------

async function checkAndHandleBilling() {
  try {
    const res = await authFetch('/api/billing/status');
    const status = await res.json();

    if (status.allowed) return { proceed: true };

    // User hit their limit — show upgrade modal
    return new Promise((resolve) => {
      showUpgradeModal(status, resolve);
    });
  } catch (e) {
    return { proceed: true };
  }
}

function showUpgradeModal(status, resolve) {
  const existing = document.getElementById('upgrade-modal');
  if (existing) existing.remove();

  // Format the reset date
  let resetText = '';
  if (status.reset_date) {
    const d = new Date(status.reset_date + 'T00:00:00');
    resetText = d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  }

  const overlay = document.createElement('div');
  overlay.id = 'upgrade-modal';
  overlay.className = 'upgrade-overlay';

  overlay.innerHTML = `
    <div class="upgrade-box">
      <h3>You've used your 3 free documents this month</h3>
      <p class="upgrade-subtitle">Choose how you'd like to continue:</p>

      <div class="upgrade-options">
        <button class="upgrade-option" id="upgrade-per-doc">
          <div class="upgrade-option-body">
            <div class="upgrade-option-title">Send this one</div>
            <div class="upgrade-option-desc">One-time charge, no commitment</div>
          </div>
          <div class="upgrade-option-price">$1.99</div>
        </button>

        <button class="upgrade-option upgrade-option-featured" id="upgrade-unlimited">
          <div class="upgrade-option-badge">BEST VALUE</div>
          <div class="upgrade-option-body">
            <div class="upgrade-option-title">Go Unlimited</div>
            <div class="upgrade-option-desc">Unlimited documents every month</div>
          </div>
          <div class="upgrade-option-price">$7<span>/mo</span></div>
        </button>
      </div>

      ${resetText ? `<p class="upgrade-reset">Or wait until <strong>${resetText}</strong> for 3 more free documents</p>` : ''}

      <button class="upgrade-cancel" id="upgrade-cancel">Cancel</button>
      <div class="upgrade-status" id="upgrade-status"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  // Cancel
  document.getElementById('upgrade-cancel').addEventListener('click', () => {
    overlay.remove();
    resolve({ proceed: false });
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { overlay.remove(); resolve({ proceed: false }); }
  });

  // Per-doc: redirect to Stripe Checkout
  document.getElementById('upgrade-per-doc').addEventListener('click', async () => {
    const statusEl = document.getElementById('upgrade-status');
    statusEl.style.display = '';
    statusEl.textContent = 'Redirecting to checkout...';

    try {
      const res = await authFetch('/api/billing/create-per-doc-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        statusEl.textContent = data.error || 'Failed to start checkout.';
      }
    } catch (e) {
      statusEl.textContent = 'Failed to connect to payment provider.';
    }
  });

  // Unlimited: redirect to Stripe Checkout
  document.getElementById('upgrade-unlimited').addEventListener('click', async () => {
    const statusEl = document.getElementById('upgrade-status');
    statusEl.style.display = '';
    statusEl.textContent = 'Redirecting to checkout...';

    try {
      const res = await authFetch('/api/billing/create-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        statusEl.textContent = data.error || 'Failed to start checkout.';
      }
    } catch (e) {
      statusEl.textContent = 'Failed to connect to payment provider.';
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

  // Check billing status before creating document
  const billing = await checkAndHandleBilling();
  if (!billing.proceed) return;

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

  const res = await authFetch('/api/documents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (res.status === 402) {
    // Server-side billing rejection — shouldn't normally happen since we check client-side
    const data = await res.json();
    showToast(data.error || 'Document limit reached');
    return;
  }

  const data = await res.json();
  if (data.id) {
    if (state.prefillFieldValues || state.prefillSignature) {
      sessionStorage.setItem('prefill_' + data.id, JSON.stringify({
        fieldValues: state.prefillFieldValues || {},
        signature: state.prefillSignature || null
      }));
    }
    window.location.href = `/sign/${data.id}?role=sender`;
  }
}

// --------------- Saved Templates ---------------

async function loadSavedTemplates() {
  const res = await authFetch('/api/saved-templates');
  const templates = await res.json();
  const container = document.getElementById('saved-templates-list');

  if (templates.length === 0) {
    container.innerHTML = '<div class="empty-state">No saved templates yet. Create a document and save your field layout as a reusable template.</div>';
    return;
  }

  const stageLabel = { fields_placed: 'Fields Only', ready_to_send: 'Ready to Send' };
  const stageClass = { fields_placed: 'fields-placed', ready_to_send: 'ready-to-send' };

  container.innerHTML = templates.map(t => `
    <div class="template-row">
      <div class="template-info">
        <div class="template-name">${t.name}</div>
        <div class="template-meta">${t.doc_title || 'No title'}</div>
      </div>
      <span class="status-badge ${stageClass[t.stage]}">${stageLabel[t.stage]}</span>
      <div class="template-meta">${new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      <div class="doc-actions">
        <button class="btn btn-sm" onclick="useSavedTemplate('${t.id}')">Use</button>
        <button class="btn btn-sm btn-delete" onclick="deleteSavedTemplate('${t.id}', '${t.name.replace(/'/g, "\\'")}')">&times;</button>
      </div>
    </div>
  `).join('');
}

async function populateSavedSelect() {
  const res = await authFetch('/api/saved-templates');
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

  select.addEventListener('change', async () => {
    const info = document.getElementById('saved-template-info');
    if (!select.value) { info.textContent = ''; state.loadedSavedTemplate = null; return; }
    const r = await authFetch(`/api/saved-templates/${select.value}`);
    const saved = await r.json();
    state.loadedSavedTemplate = saved;

    if (saved.stage === 'ready_to_send') {
      info.textContent = `Ready to send: ${saved.fields.length} fields, sender pre-filled as ${saved.sender_name}. Fill in recipient info, click Prepare, then review/edit your fields before sending.`;
      document.getElementById('sender-name').value = saved.sender_name || '';
      document.getElementById('sender-email').value = saved.sender_email || '';
      if (saved.doc_title) document.getElementById('doc-title').value = saved.doc_title;
    } else {
      info.textContent = `${saved.fields.length} fields placed. Fill in all details, click Prepare, then sign.`;
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

  const res = await authFetch('/api/saved-templates', {
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
  showView('create');
  const res = await authFetch(`/api/saved-templates/${id}`);
  const saved = await res.json();

  document.getElementById('btn-saved').click();

  const select = document.getElementById('saved-select');
  await populateSavedSelect();
  select.value = id;
  select.dispatchEvent(new Event('change'));

  if (saved.doc_title) document.getElementById('doc-title').value = saved.doc_title;
  if (saved.sender_name) document.getElementById('sender-name').value = saved.sender_name;
  if (saved.sender_email) document.getElementById('sender-email').value = saved.sender_email;

  document.getElementById('step-setup').scrollIntoView({ behavior: 'smooth' });
}

async function deleteSavedTemplate(id, name) {
  if (!confirm(`Delete saved template "${name}"?`)) return;
  const res = await authFetch(`/api/saved-templates/${id}`, { method: 'DELETE' });
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
