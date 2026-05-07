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
  currentView: 'dashboard',
  // Single-pass flow: sender's text values and signature, captured during placement
  senderFieldValues: {},
  senderSignature: null,
  // Additional signers beyond the primary recipient (e.g., 2nd/3rd tenants on a lease).
  // Empty array = single-recipient flow (existing behavior). Each entry: { name, email }.
  extraSigners: []
};

const MAX_EXTRA_SIGNERS = 4; // up to 5 total recipients including primary
// Used in dropdowns, field markers, and the dashboard. Generic "Recipient N" so
// the same wording works for tenants, contractors, partners, witnesses, etc.
const SIGNER_PALETTE_NAMES = ['Recipient 1', 'Recipient 2', 'Recipient 3', 'Recipient 4', 'Recipient 5'];

function totalRecipientCount() { return 1 + state.extraSigners.length; }
function recipientLabelFor(idx) {
  if (state.extraSigners.length === 0) return 'Recipient';
  return SIGNER_PALETTE_NAMES[idx] || `Recipient ${idx + 1}`;
}
// Ordinal label used on the form ("Second Recipient", "Third Recipient", ...)
const ORDINAL_RECIPIENT_LABELS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
function ordinalRecipientLabel(idx) {
  // idx is 0-based across ALL recipients. The primary is idx=0; extras start at 1.
  return ORDINAL_RECIPIENT_LABELS[idx] ? `${ORDINAL_RECIPIENT_LABELS[idx]} Recipient` : `Recipient ${idx + 1}`;
}

// Sender signature canvas refs (set up in setupSenderSignaturePad on first use)
let senderSigCanvas = null;
let senderSigCtx = null;
let senderSigDrawing = false;

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
  loadLibrary();
  setupSourceToggle();
  setupFieldPlacement();
  setupPageNav();
  setupTargetCursor();

  // Extra signers (multi-recipient support)
  setupExtraSigners();

  document.getElementById('btn-prepare').addEventListener('click', prepareDocument);
  document.getElementById('btn-done-fields').addEventListener('click', finishFieldPlacement);
  document.getElementById('btn-undo').addEventListener('click', removeLastField);
  document.getElementById('btn-save-template').addEventListener('click', saveFieldsAsTemplate);

  // Send confirmation modal — final check before recipient is emailed
  document.getElementById('btn-send-cancel').addEventListener('click', closeSendConfirm);
  document.getElementById('btn-send-confirm').addEventListener('click', confirmAndSend);
  document.getElementById('send-confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'send-confirm-modal') closeSendConfirm();
  });
  // Toggle the template-name input when the user opts to save the template
  document.getElementById('send-confirm-save-template').addEventListener('change', (e) => {
    const nameInput = document.getElementById('send-confirm-template-name');
    nameInput.style.display = e.target.checked ? '' : 'none';
    if (e.target.checked) {
      if (!nameInput.value) nameInput.value = state.docInfo ? (state.docInfo.title || '') : '';
      nameInput.focus();
    }
  });
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
    state.libraryItemId = null;
    state.selectedLibraryItem = null;
    state.uploadedPath = null;
    state.savedPdfPath = null;
    state.loadedSavedTemplate = null;
    state.prefillFieldValues = null;
    state.prefillSignature = null;
    state.senderFieldValues = {};
    state.senderSignature = null;
    // Hide and clear the inline signature pad if it's been used
    const sigSection = document.getElementById('sender-signature-section');
    if (sigSection) sigSection.style.display = 'none';
    if (senderSigCtx && senderSigCanvas) {
      senderSigCtx.clearRect(0, 0, senderSigCanvas.width, senderSigCanvas.height);
    }
    document.querySelectorAll('.library-item.selected').forEach(b => b.classList.remove('selected'));
    const detail = document.getElementById('library-detail');
    if (detail) detail.innerHTML = '<div class="library-detail-empty"><p class="hint" style="margin:0">Select a template from the library on the left to use it as the starting point for your document.</p></div>';
    // Reset form
    document.getElementById('doc-title').value = '';
    document.getElementById('recipient-name').value = '';
    document.getElementById('recipient-email').value = '';
    state.extraSigners = [];
    renderExtraSignerRows();
    rebuildFieldRoleSelect();
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
  document.getElementById('doc-status-filter').addEventListener('change', renderFilteredDocs);
  document.getElementById('doc-sort').addEventListener('change', renderFilteredDocs);
}

function renderFilteredDocs() {
  const statusFilter = document.getElementById('doc-status-filter').value;
  const sort = document.getElementById('doc-sort').value;

  let docs = [...state.allDocs];

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
// Escape a string for safe use as an HTML attribute value (used for data-* in row actions)
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function loadDocuments() {
  const res = await authFetch('/api/documents');
  state.allDocs = await res.json();
  renderFilteredDocs();
  bindDocActions();
}

// Delegated click handler for the documents table — bound once, survives re-renders.
let _docActionsBound = false;
function bindDocActions() {
  if (_docActionsBound) return;
  const container = document.getElementById('documents-table');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const docId = btn.dataset.docId;
    if (action === 'delete') {
      deleteDocument(docId, btn.dataset.docTitle || '', btn.dataset.docStatus || '');
    } else if (action === 'remind') {
      remindRecipient(docId);
    }
  });
  _docActionsBound = true;
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
      actions += `<button class="btn btn-sm btn-resend" data-action="remind" data-doc-id="${d.id}">Resend</button>`;
      actions += `<a href="/sign/${d.id}?role=recipient" class="btn btn-sm">View</a>`;
    }
    if (d.status === 'completed') {
      actions += `<a href="/api/documents/${d.id}/pdf" class="btn btn-sm btn-success" download>Download</a>`;
    }
    actions += `<button class="btn btn-sm btn-delete" data-action="delete" data-doc-id="${d.id}" data-doc-title="${escapeAttr(d.title || '')}" data-doc-status="${d.status}">&#10005;</button>`;

    // Multi-signer recipient cell + progress badge
    const extras = Array.isArray(d.extra_signers) ? d.extra_signers : [];
    let recipientCellName = d.recipient_name || '-';
    let recipientCellEmail = d.recipient_email || '';
    let progressBadge = '';
    if (extras.length > 0) {
      recipientCellName = `${d.recipient_name || '-'} <span class="signer-progress">+${extras.length} more</span>`;
      // How many have signed?
      let signedCount = d.recipient_completed_at ? 1 : 0;
      for (const s of extras) if (s && s.signed_at) signedCount++;
      const total = 1 + extras.length;
      if (d.status === 'awaiting_recipient') {
        progressBadge = ` <span class="signer-progress">${signedCount} of ${total} signed</span>`;
      } else if (d.status === 'completed') {
        progressBadge = ` <span class="signer-progress">${total} signers</span>`;
      }
    }

    return `<div class="doc-table-row${d.status === 'expired' ? ' doc-expired' : ''}">
      <div>
        <div class="doc-table-title">${d.title}${progressBadge}</div>
        ${expiryInfo}
      </div>
      <div>
        <div class="doc-table-recipient">${recipientCellName}</div>
        <div class="doc-table-email">${recipientCellEmail}</div>
      </div>
      <div><span class="status-badge ${statusClass[d.status] || ''}">${statusLabel[d.status] || d.status}</span></div>
      <div class="doc-table-date">${dateStr}</div>
      <div class="doc-actions">${actions}</div>
    </div>`;
  }).join('');

  container.innerHTML = html;
}

// --------------- Delete Document ---------------
async function deleteDocument(id, title, status) {
  // Stronger warning for fully signed/completed documents — the user is about to
  // permanently delete a legally signed PDF (and lose the file from disk).
  const prompt = status === 'completed'
    ? `Permanently delete the signed document "${title}"?\n\nThis is a fully executed agreement. Once deleted, the signed PDF will be removed from your dashboard and from our server. This cannot be undone.\n\nMake sure you've downloaded a copy if you need to keep it.`
    : `Delete "${title}"? This cannot be undone.`;
  if (!confirm(prompt)) return;
  try {
    const res = await authFetch(`/api/documents/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Document deleted');
      loadDocuments();
      loadStats();
      return;
    }
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) detail = data.error;
    } catch (_) { /* response wasn't JSON */ }
    showToast(`Couldn't delete: ${detail}`);
    console.error('[delete] failed', { id, status: res.status, detail });
  } catch (err) {
    showToast(`Couldn't delete: ${err && err.message ? err.message : 'network error'}`);
    console.error('[delete] threw', err);
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
  // role values are now "sender" or "recipient:N". Any recipient turns the cursor orange.
  cursor.classList.toggle('recipient-mode', role.startsWith('recipient'));
}

// --------------- Library (curated public templates) ---------------
async function loadLibrary() {
  const res = await authFetch('/api/library');
  const data = await res.json();
  const sidebar = document.getElementById('library-sidebar');
  if (!sidebar) return;

  state.library = data;
  state.libraryItemsById = {};
  const cats = data.categories || [];
  if (cats.length === 0) {
    sidebar.innerHTML = '<div class="library-empty">No templates available yet.</div>';
    return;
  }

  let html = '';
  for (const cat of cats) {
    html += `<div class="library-category">
      <div class="library-category-name">${escapeHtml(cat.name)}</div>`;
    for (const item of (cat.items || [])) {
      state.libraryItemsById[item.id] = item;
      const tag = item.province ? `<span class="library-province">${escapeHtml(item.province)}</span>` : '';
      html += `<button class="library-item" data-item-id="${escapeHtml(item.id)}" type="button">
        <div class="library-item-main">
          <div class="library-item-name">${escapeHtml(item.name)}</div>
          ${item.subtitle ? `<div class="library-item-subtitle">${escapeHtml(item.subtitle)}</div>` : ''}
        </div>
        ${tag}
      </button>`;
    }
    html += `</div>`;
  }
  sidebar.innerHTML = html;

  sidebar.querySelectorAll('.library-item').forEach(btn => {
    btn.addEventListener('click', () => selectLibraryItem(btn.dataset.itemId));
  });
}

function selectLibraryItem(itemId) {
  const item = state.libraryItemsById[itemId];
  if (!item) return;
  state.selectedLibraryItem = item;
  document.querySelectorAll('.library-item').forEach(b => b.classList.toggle('selected', b.dataset.itemId === itemId));

  const detail = document.getElementById('library-detail');
  if (detail) {
    detail.innerHTML = `
      <div class="library-detail-card">
        <div class="library-detail-name">${escapeHtml(item.name)}</div>
        ${item.subtitle ? `<div class="library-detail-subtitle">${escapeHtml(item.subtitle)}</div>` : ''}
        ${item.description ? `<p class="library-detail-desc">${escapeHtml(item.description)}</p>` : ''}
        ${item.source ? `<a class="library-detail-source" href="${escapeAttr(item.source)}" target="_blank" rel="noopener">View official source &rarr;</a>` : ''}
      </div>
    `;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

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

// --------------- Extra Signers (multi-recipient) ---------------
function setupExtraSigners() {
  const btn = document.getElementById('btn-add-signer');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (state.extraSigners.length >= MAX_EXTRA_SIGNERS) {
      showToast(`Maximum ${MAX_EXTRA_SIGNERS + 1} signers (1 primary + ${MAX_EXTRA_SIGNERS} additional)`);
      return;
    }
    state.extraSigners.push({ name: '', email: '' });
    renderExtraSignerRows();
    rebuildFieldRoleSelect();
  });
  renderExtraSignerRows();
}

function renderExtraSignerRows() {
  const container = document.getElementById('extra-signers-list');
  if (!container) return;
  container.innerHTML = '';

  state.extraSigners.forEach((signer, idx) => {
    // idx is 0-based within extras (so first extra = idx 0, second = idx 1).
    // Across the whole signer list it's idx+1 (primary is index 0).
    const overallIdx = idx + 1;
    const ordinalLabel = ordinalRecipientLabel(overallIdx);
    const row = document.createElement('div');
    row.className = 'form-row extra-signer-row';
    row.dataset.idx = String(idx);
    row.innerHTML = `
      <div class="form-group">
        <label for="extra-signer-name-${idx}">${escapeAttr(ordinalLabel)} Name</label>
        <input type="text" id="extra-signer-name-${idx}" class="extra-signer-name" data-idx="${idx}" value="${escapeAttr(signer.name || '')}" placeholder="Full legal name">
      </div>
      <div class="form-group">
        <label for="extra-signer-email-${idx}">${escapeAttr(ordinalLabel)} Email</label>
        <input type="email" id="extra-signer-email-${idx}" class="extra-signer-email" data-idx="${idx}" value="${escapeAttr(signer.email || '')}" placeholder="recipient@example.com">
      </div>
      <button type="button" class="extra-signer-remove" data-idx="${idx}" title="Remove this recipient" aria-label="Remove ${escapeAttr(ordinalLabel)}">&times;</button>
    `;
    container.appendChild(row);
  });

  container.querySelectorAll('.extra-signer-name').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const i = parseInt(e.target.dataset.idx, 10);
      if (state.extraSigners[i]) state.extraSigners[i].name = e.target.value;
    });
  });
  container.querySelectorAll('.extra-signer-email').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const i = parseInt(e.target.dataset.idx, 10);
      if (state.extraSigners[i]) state.extraSigners[i].email = e.target.value;
    });
  });
  container.querySelectorAll('.extra-signer-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const i = parseInt(e.currentTarget.dataset.idx, 10);
      removeExtraSigner(i);
    });
  });

  // Hide the "+ Add another signer" button once cap is reached
  const addBtn = document.getElementById('btn-add-signer');
  if (addBtn) addBtn.style.display = state.extraSigners.length >= MAX_EXTRA_SIGNERS ? 'none' : '';
}

function removeExtraSigner(idx) {
  if (idx < 0 || idx >= state.extraSigners.length) return;
  const removedSignerIdx = idx + 1; // because primary is signer 0
  state.extraSigners.splice(idx, 1);

  // Reassign signer_index on existing fields:
  //   - fields targeted at removed signer → demoted to primary recipient (signer 0) so user doesn't lose them silently
  //   - fields targeted at signers above the removed one → shift down by 1
  for (const f of state.fields) {
    if (f.role !== 'recipient') continue;
    const cur = typeof f.signer_index === 'number' ? f.signer_index : 0;
    if (cur === removedSignerIdx) {
      f.signer_index = 0;
    } else if (cur > removedSignerIdx) {
      f.signer_index = cur - 1;
    }
  }

  renderExtraSignerRows();
  rebuildFieldRoleSelect();
  if (state.fields.length > 0) {
    renderFieldMarkers();
    updateFieldSummary();
  }
}

function rebuildFieldRoleSelect() {
  const select = document.getElementById('field-role');
  if (!select) return;
  const prev = select.value;
  // Sender + one option per recipient
  let html = '<option value="sender">You (Sender)</option>';
  if (state.extraSigners.length === 0) {
    html += '<option value="recipient:0">Recipient</option>';
  } else {
    for (let i = 0; i < totalRecipientCount(); i++) {
      html += `<option value="recipient:${i}">${escapeAttr(SIGNER_PALETTE_NAMES[i] || `Recipient ${i + 1}`)}</option>`;
    }
  }
  select.innerHTML = html;
  // Restore previous selection if still valid; otherwise default to sender.
  if ([...select.options].some(o => o.value === prev)) {
    select.value = prev;
  } else {
    select.value = 'sender';
  }
  updateLegend();
}

function updateLegend() {
  const legend = document.querySelector('.color-legend');
  if (!legend) return;
  let html = '<div class="legend-item"><span class="legend-dot sender"></span> Your fields</div>';
  if (state.extraSigners.length === 0) {
    html += '<div class="legend-item"><span class="legend-dot recipient"></span> Their fields</div>';
  } else {
    for (let i = 0; i < totalRecipientCount(); i++) {
      const cls = i === 0 ? 'recipient' : `recipient-${i}`;
      html += `<div class="legend-item"><span class="legend-dot ${cls}"></span> ${escapeAttr(SIGNER_PALETTE_NAMES[i] || `Recipient ${i + 1}`)}</div>`;
    }
  }
  legend.innerHTML = html;
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

  // Validate extra signers (if any). Empty rows are not allowed once added —
  // the user should remove them via the "Remove" button.
  for (let i = 0; i < state.extraSigners.length; i++) {
    const s = state.extraSigners[i];
    if (!s.name || !s.name.trim() || !s.email || !s.email.trim()) {
      showToast(`Please fill in name and email for ${SIGNER_PALETTE_NAMES[i + 1] || `Recipient ${i + 2}`} (or remove that row)`);
      return;
    }
  }

  state.docInfo = {
    title, senderName, senderEmail, recipientName, recipientEmail,
    extraSigners: state.extraSigners.map(s => ({ name: s.name.trim(), email: s.email.trim() }))
  };

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
      // Single-pass flow: seed the inline editor with the template's saved values/signature
      state.senderFieldValues = { ...remapped };
      state.senderSignature = saved.sender_signature || null;
    }

    if (saved.uploaded_pdf_path) {
      state.savedPdfPath = saved.uploaded_pdf_path;
      pdfUrl = `/api/saved-template-pdf/${encodeURIComponent(saved.id)}`;
    } else if (saved.template_name) {
      // Legacy reference (pre-library) — surface clearly
      showToast('This saved template references an old file that is no longer available. Please re-create it from the library.');
      return;
    }
  } else if (isTemplate) {
    if (!state.selectedLibraryItem) { showToast('Please select a template from the library'); return; }
    state.libraryItemId = state.selectedLibraryItem.id;
    pdfUrl = `/api/library/${encodeURIComponent(state.libraryItemId)}/pdf`;
    state.fields = [];
    state.senderFieldValues = {};
    state.senderSignature = null;
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
    state.senderFieldValues = {};
    state.senderSignature = null;
  }

  try {
    const loadingTask = pdfjsLib.getDocument({ url: pdfUrl, httpHeaders: getAuthHeaders() });
    state.pdfDoc = await loadingTask.promise;
  } catch (err) {
    showToast('Could not load PDF. Please try again.');
    console.error('PDF load failed:', err);
    return;
  }
  state.totalPages = state.pdfDoc.numPages;
  state.currentPage = 1;

  document.getElementById('step-setup').style.display = 'none';
  document.getElementById('step-fields').style.display = '';
  document.querySelector('main').classList.add('workspace-mode');

  // Refresh role select + legend in case the user added/removed signers since last visit.
  rebuildFieldRoleSelect();

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

    const roleRaw = document.getElementById('field-role').value;
    // roleRaw is either "sender" or "recipient:N" (N = signer_index, 0 for primary).
    let role, signerIdx;
    if (roleRaw.startsWith('recipient')) {
      role = 'recipient';
      const colonIdx = roleRaw.indexOf(':');
      signerIdx = colonIdx >= 0 ? parseInt(roleRaw.slice(colonIdx + 1), 10) || 0 : 0;
    } else {
      role = 'sender';
      signerIdx = null;
    }
    const type = document.getElementById('field-type').value;
    const customLabel = document.getElementById('field-label').value.trim();

    const typeLabels = { text: 'Text', name: 'Full Name', date: 'Date', initials: 'Initials', signature: 'Signature' };
    const label = customLabel || typeLabels[type];

    // Default field widths: roomy enough for typical content, then resize as needed.
    const fieldW = type === 'signature' ? 240 : (type === 'initials' ? 100 : 240);
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
    // Only attach signer_index for recipient fields. Sender fields stay plain.
    if (role === 'recipient') field.signer_index = signerIdx || 0;

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
  const hasSenderSig = state.fields.some(f => f.role === 'sender' && f.type === 'signature');

  pageFields.forEach((field) => {
    const marker = document.createElement('div');
    // Sender's own text/date/initials/name fields are inline-editable in this single-pass
    // flow — sender fills in values right here instead of a separate signing screen.
    // Sender's signature field shows a "Click to sign" placeholder that opens the pad below.
    // Recipient fields stay label-only — they fill those in remotely from the email link.
    const isEditableForSender = field.role === 'sender' && field.type !== 'signature';
    const isSenderSigField = field.role === 'sender' && field.type === 'signature';

    let extraClass = '';
    if (isEditableForSender) extraClass = ' editable';
    else if (isSenderSigField) extraClass = ' sig-field';

    // Recipient markers get a per-signer color class so different tenants are visually distinct.
    let signerClass = '';
    if (field.role === 'recipient') {
      const sIdx = typeof field.signer_index === 'number' ? field.signer_index : 0;
      // recipient-0 falls back to the existing .recipient styling; 1+ pick from palette.
      if (state.extraSigners.length > 0 && sIdx > 0) signerClass = ` recipient-${sIdx}`;
    }

    marker.className = `field-marker ${field.role}${extraClass}${signerClass}`;
    marker.style.left = field.displayX + '%';
    marker.style.top = field.displayY + '%';

    if (canvas) {
      const displayScale = canvas.getBoundingClientRect().width / canvas.width;
      marker.style.width = (field.width * state.scale * displayScale) + 'px';
      marker.style.height = (field.height * state.scale * displayScale) + 'px';
    }

    let roleLabel;
    if (field.role === 'sender') {
      roleLabel = 'You';
    } else if (state.extraSigners.length === 0) {
      roleLabel = 'Them';
    } else {
      const sIdx = typeof field.signer_index === 'number' ? field.signer_index : 0;
      roleLabel = SIGNER_PALETTE_NAMES[sIdx] || `Recipient ${sIdx + 1}`;
    }
    const labelEl = document.createElement('span');
    labelEl.className = 'field-marker-label';
    labelEl.textContent = `${roleLabel}: ${field.label}`;
    marker.appendChild(labelEl);

    const removeBtn = document.createElement('span');
    removeBtn.className = 'remove-field';
    removeBtn.dataset.id = field.id;
    removeBtn.innerHTML = '&times;';
    marker.appendChild(removeBtn);

    // For markers whose interior is occupied by an input or signature placeholder,
    // expose an explicit drag handle so the field can still be repositioned after
    // values have been typed in.
    if (isEditableForSender || isSenderSigField) {
      const moveHandle = document.createElement('span');
      moveHandle.className = 'move-handle';
      moveHandle.title = 'Drag to move this field';
      moveHandle.innerHTML = '&#10303;'; // ⠿ braille pattern dots-12345678 (looks like a grip)
      marker.appendChild(moveHandle);
    }

    if (isEditableForSender) {
      // Use a textarea for free-form text/name fields so long content wraps to multiple
       // lines as the user types (matching the server's word-wrap when the PDF renders).
       // date/initials stay as single-line inputs since they don't benefit from wrapping.
      const isMultiline = field.type === 'text' || field.type === 'name';
      const input = document.createElement(isMultiline ? 'textarea' : 'input');
      input.className = 'marker-input' + (isMultiline ? ' marker-input-multiline' : '');
      if (!isMultiline) {
        input.type = field.type === 'date' ? 'date' : 'text';
      }
      input.dataset.fieldId = field.id;
      input.placeholder = field.type === 'name' ? 'Full legal name'
                        : field.type === 'initials' ? 'Initials'
                        : field.type === 'date' ? '' : 'Type here';
      // Restore prior value (preserved across re-renders / page navigation / template prefill)
      if (state.senderFieldValues[field.id] !== undefined) {
        input.value = state.senderFieldValues[field.id];
      } else if (field.type === 'date') {
        // Default dates to today so users don't have to type the common case
        const today = new Date().toISOString().split('T')[0];
        input.value = today;
        state.senderFieldValues[field.id] = today;
      }
      input.addEventListener('input', () => {
        state.senderFieldValues[field.id] = input.value;
      });
      // Don't start a marker drag when the user clicks into the input
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      marker.appendChild(input);
    } else if (isSenderSigField) {
      const placeholder = document.createElement('div');
      placeholder.className = 'sig-placeholder';
      placeholder.dataset.fieldId = field.id;
      if (state.senderSignature) {
        placeholder.classList.add('signed');
        placeholder.textContent = 'Signed';
      } else {
        placeholder.textContent = 'Click to sign';
      }
      placeholder.addEventListener('mousedown', (e) => e.stopPropagation());
      placeholder.addEventListener('click', (e) => {
        e.stopPropagation();
        openSenderSignaturePad();
      });
      marker.appendChild(placeholder);
    }

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
      // Drop any captured sender value for this field
      delete state.senderFieldValues[id];
      renderFieldMarkers();
      updateFieldSummary();
    });
  });

  // Show or hide the sender signature pad based on whether a sender sig field exists
  const sigSection = document.getElementById('sender-signature-section');
  if (sigSection) {
    sigSection.style.display = hasSenderSig ? '' : 'none';
    // If a saved-template prefilled a signature, initialize the pad so the existing
    // signature renders into the canvas (otherwise it'd only show when the user clicks).
    if (hasSenderSig && state.senderSignature) {
      setupSenderSignaturePad();
    }
  }
}

function setupDrag(marker, field, container) {
  let startX, startY, startDisplayX, startDisplayY, hasMoved;

  marker.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('remove-field')) return;
    // Don't drag when the user is typing into an inline input or clicking a signature
    // placeholder — those events need to pass through to focus / click the inner element.
    if (e.target.classList.contains('marker-input')) return;
    if (e.target.classList.contains('sig-placeholder')) return;
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
    html += `<span class="field-summary-item sender">You: ${escapeAttr(f.label)} (p${f.page + 1})</span>`;
  });
  if (state.extraSigners.length === 0) {
    recipientFields.forEach(f => {
      html += `<span class="field-summary-item recipient">Them: ${escapeAttr(f.label)} (p${f.page + 1})</span>`;
    });
  } else {
    recipientFields.forEach(f => {
      const sIdx = typeof f.signer_index === 'number' ? f.signer_index : 0;
      const cls = sIdx === 0 ? 'recipient' : `recipient-${sIdx}`;
      const tag = SIGNER_PALETTE_NAMES[sIdx] || `Recipient ${sIdx + 1}`;
      html += `<span class="field-summary-item ${cls}">${escapeAttr(tag)}: ${escapeAttr(f.label)} (p${f.page + 1})</span>`;
    });
  }
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

// --------------- Sender Signature Pad (placement-page, single-pass flow) ---------------
function setupSenderSignaturePad() {
  if (senderSigCanvas) return; // Already set up
  senderSigCanvas = document.getElementById('sender-sig-canvas');
  if (!senderSigCanvas) return;
  senderSigCtx = senderSigCanvas.getContext('2d');

  // Match canvas pixel resolution to its rendered size so strokes look crisp
  const rect = senderSigCanvas.getBoundingClientRect();
  senderSigCanvas.width = rect.width || 500;
  senderSigCanvas.height = 120;

  senderSigCtx.strokeStyle = '#1a1a2e';
  senderSigCtx.lineWidth = 2;
  senderSigCtx.lineCap = 'round';
  senderSigCtx.lineJoin = 'round';

  function getPos(e) {
    const r = senderSigCanvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    const scaleX = senderSigCanvas.width / r.width;
    const scaleY = senderSigCanvas.height / r.height;
    return { x: (touch.clientX - r.left) * scaleX, y: (touch.clientY - r.top) * scaleY };
  }

  senderSigCanvas.addEventListener('mousedown', (e) => { senderSigDrawing = true; senderSigCtx.beginPath(); const p = getPos(e); senderSigCtx.moveTo(p.x, p.y); });
  senderSigCanvas.addEventListener('mousemove', (e) => { if (!senderSigDrawing) return; const p = getPos(e); senderSigCtx.lineTo(p.x, p.y); senderSigCtx.stroke(); });
  senderSigCanvas.addEventListener('mouseup', () => { senderSigDrawing = false; commitSenderSignature(); });
  senderSigCanvas.addEventListener('mouseleave', () => { senderSigDrawing = false; });

  senderSigCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); senderSigDrawing = true; senderSigCtx.beginPath(); const p = getPos(e); senderSigCtx.moveTo(p.x, p.y); });
  senderSigCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); if (!senderSigDrawing) return; const p = getPos(e); senderSigCtx.lineTo(p.x, p.y); senderSigCtx.stroke(); });
  senderSigCanvas.addEventListener('touchend', () => { senderSigDrawing = false; commitSenderSignature(); });

  document.getElementById('btn-clear-sender-sig').addEventListener('click', () => {
    senderSigCtx.clearRect(0, 0, senderSigCanvas.width, senderSigCanvas.height);
    state.senderSignature = null;
    document.querySelectorAll('.field-marker .sig-placeholder').forEach(el => {
      el.classList.remove('signed');
      el.textContent = 'Click to sign';
    });
  });

  // Restore a previously-drawn signature (e.g. from a saved template prefill)
  if (state.senderSignature) {
    const img = new Image();
    img.onload = () => {
      senderSigCtx.drawImage(img, 0, 0, senderSigCanvas.width, senderSigCanvas.height);
    };
    img.src = state.senderSignature;
  }
}

function commitSenderSignature() {
  if (!senderSigCtx || !senderSigCanvas) return;
  const imageData = senderSigCtx.getImageData(0, 0, senderSigCanvas.width, senderSigCanvas.height);
  const hasContent = imageData.data.some((val, i) => i % 4 === 3 && val > 0);
  if (hasContent) {
    state.senderSignature = senderSigCanvas.toDataURL('image/png');
    document.querySelectorAll('.field-marker .sig-placeholder').forEach(el => {
      el.classList.add('signed');
      el.textContent = 'Signed';
    });
  } else {
    state.senderSignature = null;
  }
}

function openSenderSignaturePad() {
  const section = document.getElementById('sender-signature-section');
  if (!section) return;
  section.style.display = '';
  setupSenderSignaturePad();
  section.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// --------------- Finish & Send Document (single-pass) ---------------
async function finishFieldPlacement() {
  if (state.fields.length === 0) {
    showToast('Please place at least one field on the document');
    return;
  }

  const senderFields = state.fields.filter(f => f.role === 'sender');
  const recipientFields = state.fields.filter(f => f.role === 'recipient');
  const hasSenderSig = senderFields.some(f => f.type === 'signature');
  const hasRecipientSig = recipientFields.some(f => f.type === 'signature');

  if (!hasSenderSig || !hasRecipientSig) {
    if (!confirm('You haven\'t placed signature fields for both parties. Continue anyway?')) return;
  }

  // Validate that every sender text/date/etc. field has a value typed in
  const missingValue = senderFields.find(f => {
    if (f.type === 'signature') return false;
    const v = state.senderFieldValues[f.id];
    return v === undefined || v === null || String(v).trim() === '';
  });
  if (missingValue) {
    showToast(`Please fill in your "${missingValue.label}" field before sending`);
    return;
  }

  // Validate signature is drawn if a sender signature field exists
  if (hasSenderSig && !state.senderSignature) {
    showToast('Please draw your signature in the signature pad below');
    openSenderSignaturePad();
    return;
  }

  if (!state.docInfo.recipientName || !state.docInfo.recipientEmail) {
    showToast('Please go back and fill in the recipient name and email');
    return;
  }

  // Open the confirmation modal — actual send happens in confirmAndSend
  openSendConfirm();
}

function openSendConfirm() {
  document.getElementById('send-confirm-doc-title').textContent = state.docInfo.title;
  const single = document.getElementById('send-confirm-single');
  const multi = document.getElementById('send-confirm-multi');
  const heading = document.getElementById('send-confirm-heading');
  const sub = document.getElementById('send-confirm-sub');
  const extras = state.docInfo.extraSigners || [];

  if (extras.length === 0) {
    // Single-recipient layout (unchanged)
    if (single) single.style.display = '';
    if (multi) { multi.style.display = 'none'; multi.innerHTML = ''; }
    if (heading) heading.textContent = 'Send to recipient?';
    if (sub) sub.textContent = "Once you confirm, this document goes straight to the recipient's inbox.";
    document.getElementById('send-confirm-recipient-name').textContent = state.docInfo.recipientName;
    document.getElementById('send-confirm-recipient-email').textContent = state.docInfo.recipientEmail;
  } else {
    // Multi-signer layout — list all signers, in signing order
    if (single) single.style.display = 'none';
    if (multi) {
      multi.style.display = '';
      const allSigners = [
        { name: state.docInfo.recipientName, email: state.docInfo.recipientEmail },
        ...extras
      ];
      multi.innerHTML = allSigners.map((s, i) => `
        <div class="send-confirm-signer">
          <div class="send-confirm-signer-tag">${escapeAttr(SIGNER_PALETTE_NAMES[i] || `Recipient ${i + 1}`)}${i === 0 ? ' (signs first)' : ''}</div>
          <div><strong>${escapeAttr(s.name)}</strong> &middot; ${escapeAttr(s.email)}</div>
        </div>
      `).join('');
    }
    if (heading) heading.textContent = `Send to ${1 + extras.length} signers?`;
    if (sub) sub.textContent = `Each signer will receive their own link, in order. The next signer is emailed only after the previous one signs.`;
  }

  // Reset the save-as-template controls each time the modal opens
  const saveCheckbox = document.getElementById('send-confirm-save-template');
  const nameInput = document.getElementById('send-confirm-template-name');
  saveCheckbox.checked = false;
  nameInput.style.display = 'none';
  nameInput.value = '';
  document.getElementById('send-confirm-modal').style.display = '';
}

function closeSendConfirm() {
  const modal = document.getElementById('send-confirm-modal');
  if (modal) modal.style.display = 'none';
  // Re-enable confirm button in case it was disabled mid-send
  const btn = document.getElementById('btn-send-confirm');
  if (btn) { btn.disabled = false; btn.textContent = 'Send now'; }
}

async function confirmAndSend() {
  const confirmBtn = document.getElementById('btn-send-confirm');
  confirmBtn.disabled = true;
  confirmBtn.textContent = 'Sending…';

  const wantsTemplate = document.getElementById('send-confirm-save-template').checked;
  const tplName = wantsTemplate
    ? (document.getElementById('send-confirm-template-name').value.trim() || state.docInfo.title || 'My Template')
    : null;

  // Check billing before creating the document
  const billing = await checkAndHandleBilling();
  if (!billing.proceed) {
    closeSendConfirm();
    return;
  }

  // Step 1: Create the document
  const createBody = {
    title: state.docInfo.title,
    libraryItemId: state.libraryItemId || undefined,
    pdfSource: state.uploadedPath || undefined,
    savedTemplatePdf: state.savedPdfPath || undefined,
    senderName: state.docInfo.senderName,
    senderEmail: state.docInfo.senderEmail,
    recipientName: state.docInfo.recipientName,
    recipientEmail: state.docInfo.recipientEmail,
    fields: state.fields,
    extraSigners: (state.docInfo.extraSigners && state.docInfo.extraSigners.length > 0) ? state.docInfo.extraSigners : undefined
  };

  let createRes;
  try {
    createRes = await authFetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody)
    });
  } catch (err) {
    showToast('Network error creating the document. Please try again.');
    closeSendConfirm();
    return;
  }

  if (createRes.status === 402) {
    const data = await createRes.json();
    showToast(data.error || 'Document limit reached');
    closeSendConfirm();
    return;
  }
  if (!createRes.ok) {
    showToast('Could not create the document. Please try again.');
    closeSendConfirm();
    return;
  }

  const created = await createRes.json();
  if (!created || !created.id) {
    showToast('Unexpected response from server.');
    closeSendConfirm();
    return;
  }

  // Step 2: Save the template BEFORE sign-sender — sign-sender stamps the sender's
  // signature and values onto the PDF on disk (overwriting it). If we save the template
  // after that, the template would carry your old signature baked into the PDF, which
  // is unusable for future sends. Saving here uses the still-blank PDF.
  // Use the doc's freshly-created pdf_path (covers upload, library, and saved-template
  // sources uniformly — all three end up at uploads/<id>.pdf as a clean copy).
  let templateSavedOk = null; // null = wasn't requested, true/false = outcome
  if (wantsTemplate && tplName) {
    const tplRes = await authFetch('/api/saved-templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: tplName,
        stage: 'ready_to_send',
        uploadedPdfPath: created.pdf_path || state.uploadedPath || state.savedPdfPath || null,
        templateName: state.templateName || null,
        fields: state.fields,
        senderName: state.docInfo.senderName,
        senderEmail: state.docInfo.senderEmail,
        senderFieldValues: state.senderFieldValues,
        senderSignature: state.senderSignature,
        docTitle: state.docInfo.title
      })
    });
    templateSavedOk = tplRes.ok;
  }

  // Step 3: Submit sender values + signature, which stamps the PDF and emails the recipient
  const signRes = await authFetch(`/api/documents/${created.id}/sign-sender`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fieldValues: state.senderFieldValues,
      signatureDataUrl: state.senderSignature,
      attestation: true,
      fields: state.fields
    })
  });

  if (!signRes.ok) {
    // Doc was created but sender-sign failed. Fall back to the legacy signing page so the
    // user can retry from there rather than losing their work.
    showToast('Saved your document, but couldn\'t finalize the send. Continuing on the signing page.');
    closeSendConfirm();
    window.location.href = `/sign/${created.id}?role=sender`;
    return;
  }

  closeSendConfirm();

  // Compose a single toast that reflects what actually happened
  const totalSigners = 1 + ((state.docInfo.extraSigners && state.docInfo.extraSigners.length) || 0);
  const recipientLabel = totalSigners > 1
    ? `${state.docInfo.recipientName} (1 of ${totalSigners})`
    : state.docInfo.recipientName;
  let msg = `Sent to ${recipientLabel}. Awaiting their signature.`;
  if (templateSavedOk === true) {
    msg = `Sent to ${recipientLabel}. Template "${tplName}" saved.`;
  } else if (templateSavedOk === false) {
    msg = `Sent to ${recipientLabel}, but the template couldn't be saved.`;
  }
  showToast(msg);
  showView('dashboard');
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
        <div class="template-name">${escapeAttr(t.name)}</div>
        <div class="template-meta">${escapeAttr(t.doc_title || 'No title')}</div>
      </div>
      <span class="status-badge ${stageClass[t.stage]}">${stageLabel[t.stage]}</span>
      <div class="template-meta">${new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</div>
      <div class="doc-actions">
        <button class="btn btn-sm" data-action="use-template" data-tpl-id="${t.id}">Use</button>
        <button class="btn btn-sm btn-delete" data-action="delete-template" data-tpl-id="${t.id}" data-tpl-name="${escapeAttr(t.name)}">&times;</button>
      </div>
    </div>
  `).join('');

  bindSavedTemplateActions();
}

// Delegated click handler for the saved-templates list — bound once, survives re-renders.
let _savedTemplateActionsBound = false;
function bindSavedTemplateActions() {
  if (_savedTemplateActionsBound) return;
  const container = document.getElementById('saved-templates-list');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const tplId = btn.dataset.tplId;
    if (action === 'use-template') {
      useSavedTemplate(tplId);
    } else if (action === 'delete-template') {
      deleteSavedTemplate(tplId, btn.dataset.tplName || '');
    }
  });
  _savedTemplateActionsBound = true;
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
  try {
    const res = await authFetch(`/api/saved-templates/${id}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('Template deleted');
      loadSavedTemplates();
      return;
    }
    let detail = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data && data.error) detail = data.error;
    } catch (_) { /* response wasn't JSON */ }
    showToast(`Couldn't delete: ${detail}`);
    console.error('[delete template] failed', { id, status: res.status, detail });
  } catch (err) {
    showToast(`Couldn't delete: ${err && err.message ? err.message : 'network error'}`);
    console.error('[delete template] threw', err);
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
