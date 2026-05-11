require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const Database = require('better-sqlite3');
const { execSync } = require('child_process');
const { Resend } = require('resend');
const nodemailer = require('nodemailer');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Stripe = require('stripe');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --------------- Stripe ---------------
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_ID_UNLIMITED = process.env.STRIPE_PRICE_ID_UNLIMITED || '';
const FREE_DOC_LIMIT = 3;
const PAY_PER_DOC_PRICE = 199; // cents
const DOC_EXPIRY_DAYS = 30;
const REMINDER_DAYS = [3, 7, 25]; // days after sending to send reminders

// --------------- Config ---------------
// JWT_SECRET MUST be set in .env. Falling back to a random in-memory value
// silently invalidates every active JWT and CSRF token on restart, which
// presents to users as random "Invalid or missing CSRF token" / login-loop
// failures. In production we'd rather refuse to boot than serve broken auth.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is not set. Add it to .env and restart.');
    process.exit(1);
  }
  console.warn('WARN: JWT_SECRET not set — using a random secret. All sessions will be invalidated on restart. Set JWT_SECRET in .env for stable auth.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = '7d';

const config = {
  resendApiKey: process.env.RESEND_API_KEY || '',
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || ''
    }
  },
  fromEmail: process.env.FROM_EMAIL || process.env.SMTP_USER || '',
  fromName: process.env.FROM_NAME || 'Penned'
};

// --------------- Database ---------------
const db = new Database(path.join(__dirname, 'esign.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    pdf_path TEXT NOT NULL,
    status TEXT DEFAULT 'draft',
    sender_name TEXT,
    sender_email TEXT,
    recipient_name TEXT,
    recipient_email TEXT,
    fields TEXT DEFAULT '[]',
    sender_completed_at TEXT,
    recipient_completed_at TEXT,
    final_pdf_path TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    ip_sender TEXT,
    ip_recipient TEXT
  )
`);

// Add template_name column to existing documents table (migration-safe)
try { db.exec(`ALTER TABLE documents ADD COLUMN template_name TEXT`); } catch (e) { /* column already exists */ }
// Add user_id column to documents (migration-safe)
try { db.exec(`ALTER TABLE documents ADD COLUMN user_id TEXT`); } catch (e) { /* column already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    plan_type TEXT DEFAULT 'free' CHECK(plan_type IN ('free', 'pay_per_doc', 'unlimited')),
    documents_sent_this_month INTEGER DEFAULT 0,
    monthly_reset_date TEXT DEFAULT (date('now', 'start of month', '+1 month')),
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Invalidated JWT tokens (for logout)
db.exec(`
  CREATE TABLE IF NOT EXISTS token_blacklist (
    token_jti TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS saved_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN ('fields_placed', 'ready_to_send')),
    template_name TEXT,
    uploaded_pdf_path TEXT,
    fields TEXT DEFAULT '[]',
    sender_name TEXT,
    sender_email TEXT,
    sender_field_values TEXT,
    sender_signature TEXT,
    doc_title TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// User settings columns (migration-safe)
try { db.exec(`ALTER TABLE users ADD COLUMN notify_signed INTEGER DEFAULT 1`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE users ADD COLUMN notify_expired INTEGER DEFAULT 1`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE users ADD COLUMN company_name TEXT`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE users ADD COLUMN logo_path TEXT`); } catch (e) { /* exists */ }

// Document lifecycle columns (migration-safe)
try { db.exec(`ALTER TABLE documents ADD COLUMN expires_at TEXT`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE documents ADD COLUMN last_reminder_at TEXT`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE documents ADD COLUMN reminder_count INTEGER DEFAULT 0`); } catch (e) { /* exists */ }

// Multi-signer columns (migration-safe). extra_signers is JSON array of
// { name, email, signed_at, ip } for signers BEYOND the primary recipient
// (which is still tracked in recipient_name / recipient_email).
// current_signer_index is 0-based and points at whichever signer is currently
// awaited. 0 = primary recipient. NULL/missing extra_signers means single-recipient
// (back-compat); existing rows behave exactly as before.
try { db.exec(`ALTER TABLE documents ADD COLUMN extra_signers TEXT`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE documents ADD COLUMN current_signer_index INTEGER DEFAULT 0`); } catch (e) { /* exists */ }

// Stripe billing columns (migration-safe)
try { db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`); } catch (e) { /* exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS billing_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT DEFAULT 'usd',
    stripe_payment_id TEXT,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS deleted_accounts (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    plan_type TEXT,
    company_name TEXT,
    total_docs INTEGER DEFAULT 0,
    total_spent_cents INTEGER DEFAULT 0,
    joined_at TEXT,
    deleted_at TEXT DEFAULT (datetime('now')),
    deleted_by TEXT DEFAULT 'admin'
  )
`);

// Saved-template PDFs and any other persistent runtime data live OUTSIDE the
// deploy directory so they survive code deploys, predeploy snapshots, or any
// tooling that touches /opt/e-sign. On prod set PENNED_DATA_DIR=/var/lib/penned
// in .env. In dev, falls back to ./data so the workspace is self-contained.
const dataDir = process.env.PENNED_DATA_DIR || path.join(__dirname, 'data');
const savedTemplatesDir = path.join(dataDir, 'saved-templates');
fs.mkdirSync(savedTemplatesDir, { recursive: true });

// Ensure logos directory exists
const logosDir = path.join(__dirname, 'uploads', 'logos');
if (!fs.existsSync(logosDir)) fs.mkdirSync(logosDir, { recursive: true });

// Ensure signed-documents directory exists. qpdf writes finalized PDFs here when
// the recipient completes signing — without it, the recipient sign step fails with
// "No such file or directory" on a fresh deploy (the dir is gitignored).
const signedDir = path.join(__dirname, 'signed');
if (!fs.existsSync(signedDir)) fs.mkdirSync(signedDir, { recursive: true });

// Same reason for uploads/ — gitignored, but needed for new document PDFs.
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Privacy: scope saved_templates to the owning user.
try { db.exec(`ALTER TABLE saved_templates ADD COLUMN user_id TEXT`); } catch (e) { /* exists */ }

// Startup integrity check: surface saved_templates rows whose PDFs are gone.
// Logged loud (stderr) so the next incident is caught immediately, not by users.
try {
  const rows = db.prepare('SELECT id, name, uploaded_pdf_path FROM saved_templates').all();
  const missing = rows.filter(r => {
    const computed = path.join(savedTemplatesDir, `${r.id}.pdf`);
    return !fs.existsSync(computed) && (!r.uploaded_pdf_path || !fs.existsSync(r.uploaded_pdf_path));
  });
  if (missing.length) {
    console.error(`[STARTUP-WARN] ${missing.length}/${rows.length} saved_template row(s) have missing PDFs:`);
    for (const m of missing) console.error(`  - ${m.id} "${m.name}"  stored=${m.uploaded_pdf_path || 'null'}`);
  } else if (rows.length) {
    console.log(`[STARTUP] saved_template integrity OK (${rows.length} rows, dir=${savedTemplatesDir})`);
  }
} catch (e) { console.error('[STARTUP] saved_template integrity check failed:', e.message); }

// Curated public template library (manifest + PDFs in /library)
const libraryDir = path.join(__dirname, 'library');
let libraryManifest = { categories: [] };
let libraryItemsById = {};
function loadLibraryManifest() {
  try {
    const raw = fs.readFileSync(path.join(libraryDir, 'manifest.json'), 'utf8');
    libraryManifest = JSON.parse(raw);
    libraryItemsById = {};
    for (const cat of libraryManifest.categories || []) {
      for (const item of cat.items || []) {
        libraryItemsById[item.id] = { ...item, categoryId: cat.id, categoryName: cat.name };
      }
    }
    console.log(`[LIBRARY] Loaded ${Object.keys(libraryItemsById).length} items in ${libraryManifest.categories.length} categories`);
  } catch (e) {
    console.warn('[LIBRARY] No manifest found at', libraryDir, '—', e.message);
  }
}
loadLibraryManifest();

// --------------- Stripe Webhook (must be before JSON body parser) ---------------
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(400).send('Stripe not configured');

  let event;
  try {
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('[STRIPE WEBHOOK] Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[STRIPE WEBHOOK] ${event.type}`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.user_id || session.client_reference_id;
        if (!userId) break;
        const custId = session.customer;
        const checkoutType = session.metadata?.type;

        // Always store the customer ID
        db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(custId, userId);

        const paidUser = db.prepare('SELECT name, email FROM users WHERE id = ?').get(userId);
        const receiptDate = new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

        if (checkoutType === 'per_doc' || session.mode === 'payment') {
          // One-time per-doc payment — grant one extra document send
          db.prepare('INSERT INTO billing_history (id, user_id, type, amount_cents, stripe_payment_id, description) VALUES (?, ?, ?, ?, ?, ?)')
            .run(uuidv4(), userId, 'per_document', PAY_PER_DOC_PRICE, session.payment_intent || session.id, 'Pay-per-document');
          db.prepare('UPDATE users SET documents_sent_this_month = MAX(0, documents_sent_this_month - 1) WHERE id = ?').run(userId);
          if (paidUser) {
            sendEmail(paidUser.email, 'Penned payment receipt', emailTemplates.paymentReceipt(paidUser.name, '$1.99', 'Single document send', receiptDate)).catch(e => console.error('Receipt email error:', e));
          }
          console.log(`[STRIPE] Per-doc payment for user ${userId}`);
        } else {
          // Subscription
          const subId = session.subscription;
          db.prepare('UPDATE users SET plan_type = ?, stripe_subscription_id = ? WHERE id = ?')
            .run('unlimited', subId, userId);
          db.prepare('INSERT INTO billing_history (id, user_id, type, amount_cents, stripe_payment_id, description) VALUES (?, ?, ?, ?, ?, ?)')
            .run(uuidv4(), userId, 'subscription', 700, session.payment_intent || session.id, 'Unlimited plan subscription');
          if (paidUser) {
            sendEmail(paidUser.email, 'Penned payment receipt', emailTemplates.paymentReceipt(paidUser.name, '$7.00', 'Unlimited plan — monthly subscription', receiptDate)).catch(e => console.error('Receipt email error:', e));
          }
          console.log(`[STRIPE] User ${userId} upgraded to unlimited`);
        }
        break;
      }

      case 'invoice.paid': {
        const invoice = event.data.object;
        const subId = invoice.subscription;
        if (!subId) break;
        const user = db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(subId);
        if (!user) break;
        // Ensure plan stays active and reset monthly counter
        db.prepare('UPDATE users SET plan_type = ?, documents_sent_this_month = 0 WHERE id = ?')
          .run('unlimited', user.id);
        if (invoice.amount_paid > 0) {
          db.prepare('INSERT INTO billing_history (id, user_id, type, amount_cents, stripe_payment_id, description) VALUES (?, ?, ?, ?, ?, ?)')
            .run(uuidv4(), user.id, 'subscription_renewal', invoice.amount_paid, invoice.payment_intent || invoice.id, 'Unlimited plan renewal');
        }
        console.log(`[STRIPE] Subscription renewed for user ${user.id}`);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const user = db.prepare('SELECT id FROM users WHERE stripe_subscription_id = ?').get(sub.id);
        if (!user) break;
        db.prepare('UPDATE users SET plan_type = ?, stripe_subscription_id = NULL WHERE id = ?')
          .run('free', user.id);
        console.log(`[STRIPE] User ${user.id} downgraded to free (subscription cancelled)`);
        break;
      }

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const userId = pi.metadata?.user_id;
        const docId = pi.metadata?.document_id;
        if (!userId) break;
        db.prepare('INSERT INTO billing_history (id, user_id, type, amount_cents, stripe_payment_id, description) VALUES (?, ?, ?, ?, ?, ?)')
          .run(uuidv4(), userId, 'per_document', pi.amount, pi.id, docId ? `Pay-per-doc: ${docId}` : 'Pay-per-document charge');
        // Mark the pending document as paid
        if (docId) {
          db.prepare("UPDATE documents SET status = 'draft' WHERE id = ? AND status = 'payment_pending'").run(docId);
        }
        console.log(`[STRIPE] Per-doc payment confirmed for user ${userId}`);
        break;
      }
    }
  } catch (err) {
    console.error('[STRIPE WEBHOOK] Handler error:', err);
  }

  res.json({ received: true });
});

// --------------- Security Middleware ---------------

// Helmet security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://js.stripe.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https://api.stripe.com"],
      frameSrc: ["https://js.stripe.com", "https://checkout.stripe.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

// Trust proxy (Nginx/Caddy in front)
app.set('trust proxy', 1);

// HTTPS redirect in production
if (BASE_URL.startsWith('https://')) {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') return next();
    res.redirect(301, `https://${req.headers.host}${req.url}`);
  });
}

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const userId = req.user?.id || '-';
    const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms user=${userId} ip=${req.ip}`;
    if (res.statusCode >= 400) {
      console.warn(`[REQ] ${line}`);
    } else if (req.originalUrl.startsWith('/api/')) {
      console.log(`[REQ] ${line}`);
    }
  });
  next();
});

// Rate limiters
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  validate: { ip: false }
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts. Please try again later.' },
  validate: { ip: false }
});

const docSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Document send rate limit reached. Please try again later.' },
  keyGenerator: (req) => req.user?.id || req.ip,
  validate: { ip: false, ipv6SubnetOrKeyGenerator: false, keyGeneratorIpFallback: false }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  keyGenerator: (req) => req.user?.id || req.ip,
  validate: { ip: false, ipv6SubnetOrKeyGenerator: false, keyGeneratorIpFallback: false }
});

app.use('/api/', apiLimiter);

// CSRF token generation and validation
const CSRF_SECRET = process.env.JWT_SECRET || JWT_SECRET;

function generateCsrfToken(sessionId) {
  const payload = sessionId + ':' + Math.floor(Date.now() / 3600000);
  return crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex').slice(0, 32);
}

function validateCsrfToken(token, sessionId) {
  if (!token || !sessionId) return false;
  const currentHour = Math.floor(Date.now() / 3600000);
  for (let i = 0; i <= 1; i++) {
    const payload = sessionId + ':' + (currentHour - i);
    const expected = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex').slice(0, 32);
    if (token === expected) return true;
  }
  return false;
}

// CSRF endpoint — returns a token tied to the user's JWT jti
app.get('/api/csrf-token', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.json({ token: generateCsrfToken('anon-' + req.ip) });
  }
  try {
    const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
    res.json({ token: generateCsrfToken(decoded.jti) });
  } catch (e) {
    res.json({ token: generateCsrfToken('anon-' + req.ip) });
  }
});

// CSRF validation middleware for state-changing requests
function csrfProtection(req, res, next) {
  // Skip for safe methods, webhooks, and auth routes (pre-session, rate-limited instead)
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/api/webhooks/') || req.path.startsWith('/webhooks/')) return next();
  if (req.path.startsWith('/api/auth/') || req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/api/admin/') || req.path.startsWith('/admin/')) return next();

  const csrfToken = req.headers['x-csrf-token'];
  const authHeader = req.headers.authorization;

  let sessionId;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
      sessionId = decoded.jti;
    } catch (e) {
      sessionId = 'anon-' + req.ip;
    }
  } else {
    sessionId = 'anon-' + req.ip;
  }

  if (!validateCsrfToken(csrfToken, sessionId)) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
}

// Input sanitization helper — strips HTML tags and trims
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>/g, '').trim();
}

function sanitizeObj(obj, keys) {
  const result = {};
  for (const key of keys) {
    if (obj[key] !== undefined) {
      result[key] = typeof obj[key] === 'string' ? sanitize(obj[key]) : obj[key];
    }
  }
  return result;
}

// Password strength validation
function validatePassword(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be under 128 characters';
  return null;
}

// --------------- Middleware ---------------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: false, index: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  }
});

const logoUpload = multer({
  dest: path.join(__dirname, 'uploads', 'logos'),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPG, SVG, and WebP images are allowed'));
  }
});

// --------------- Email ---------------
const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

function getTransporter() {
  if (!config.smtp.auth.user) return null;
  return nodemailer.createTransport(config.smtp);
}

async function sendEmail(to, subject, html, attachments = []) {
  // Use Resend if configured (works over HTTPS, no SMTP port needed)
  if (resend) {
    const emailData = {
      from: `${config.fromName} <${config.fromEmail}>`,
      to,
      subject,
      html
    };
    if (attachments.length > 0) {
      emailData.attachments = attachments.map(a => ({
        filename: a.filename,
        content: fs.readFileSync(a.path).toString('base64')
      }));
    }
    await resend.emails.send(emailData);
    console.log(`[EMAIL SENT via Resend] To: ${to} | Subject: ${subject}`);
    return true;
  }

  // Fallback to SMTP
  const transporter = getTransporter();
  if (!transporter) {
    console.log(`[EMAIL SKIPPED] To: ${to} | Subject: ${subject}`);
    console.log('  Configure RESEND_API_KEY or SMTP_USER/SMTP_PASS to enable email.');
    return false;
  }
  await transporter.sendMail({
    from: `"${config.fromName}" <${config.fromEmail}>`,
    to,
    subject,
    html,
    attachments
  });
  console.log(`[EMAIL SENT via SMTP] To: ${to} | Subject: ${subject}`);
  return true;
}

// --------------- Email Templates ---------------

function emailLayout(content, options = {}) {
  const year = new Date().getFullYear();
  const settingsUrl = `${BASE_URL}/settings#notifications`;
  const fontStack = `'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#faf9f5;font-family:${fontStack};color:#1c2230;-webkit-font-smoothing:antialiased">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#faf9f5;padding:36px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px">

<!-- Brand row (mirrors the site's nav / auth page header) -->
<tr><td style="padding:0 4px 18px">
  <table cellpadding="0" cellspacing="0" role="presentation"><tr>
    <td width="30" height="30" align="center" valign="middle" style="background:#1c2230;border-radius:7px;color:#faf9f5;font-weight:700;font-size:15px;letter-spacing:-0.04em;font-family:${fontStack};line-height:30px">P</td>
    <td valign="middle" style="padding-left:10px;font-size:16px;font-weight:600;color:#1c2230;letter-spacing:-0.012em;font-family:${fontStack}">Penned</td>
  </tr></table>
</td></tr>

<!-- Card -->
<tr><td style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;padding:36px 36px 28px;box-shadow:0 1px 2px rgba(20,30,40,0.03),0 24px 50px -28px rgba(20,30,40,0.12)">
${content}
</td></tr>

<!-- Footer -->
<tr><td style="padding:22px 8px 0">
  <p style="margin:0;font-size:12px;color:#6b7480;line-height:1.6;font-family:${fontStack}">
    Sent by Penned${config.fromEmail ? ' &middot; ' + config.fromEmail : ''}
  </p>
  ${options.hideUnsubscribe ? '' : `<p style="margin:6px 0 0;font-size:12px;color:#6b7480;font-family:${fontStack}">
    <a href="${settingsUrl}" style="color:#16708a;text-decoration:underline">Email preferences</a>
  </p>`}
  <p style="margin:6px 0 0;font-size:11px;color:#a3a8b3;font-family:${fontStack}">&copy; ${year} Penned</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function emailButton(text, url) {
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:24px 0"><tr><td style="background:#1c2230;border-radius:10px">
  <a href="${url}" style="display:inline-block;color:#ffffff;padding:13px 32px;font-size:15px;font-weight:500;letter-spacing:-0.005em;text-decoration:none;border-radius:10px;font-family:inherit">${text}</a>
</td></tr></table>`;
}

const emailTemplates = {

  welcome(name) {
    return emailLayout(`
      <h2 style="margin:0 0 8px;font-size:22px;color:#1c2230">Welcome to Penned</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#3d4654;line-height:1.6">Hi ${name},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#3d4654;line-height:1.6">
        Your account is ready. Penned lets you send documents for signature in minutes &mdash; no printing, scanning, or mailing.
      </p>
      <p style="margin:0 0 4px;font-size:15px;color:#3d4654;line-height:1.6">Here's how to get started:</p>
      <ol style="margin:8px 0 20px;padding-left:20px;font-size:14px;color:#3d4654;line-height:1.8">
        <li>Upload a PDF or choose a template</li>
        <li>Place signature and text fields</li>
        <li>Send &mdash; your recipient signs from any device</li>
      </ol>
      ${emailButton('Go to Dashboard', BASE_URL + '/dashboard')}
      <p style="margin:0;font-size:13px;color:#6b7480">You have 3 free documents per month on your current plan.</p>
    `);
  },

  signingInvitation(senderName, docTitle, signUrl) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1c2230">${senderName} sent you a document to sign</h2>
      <p style="margin:0 0 8px;font-size:15px;color:#3d4654;line-height:1.6">
        You've been asked to review and sign the following document:
      </p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin:16px 0">
        <p style="margin:0;font-size:16px;font-weight:600;color:#1c2230">${docTitle}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#6b7480">From: ${senderName}</p>
      </div>
      ${emailButton('Review & Sign Document', signUrl)}
      <p style="margin:0 0 6px;font-size:13px;color:#6b7480">This is a secure signing link. Only use it if you were expecting this document.</p>
      <p style="margin:0;font-size:13px;color:#6b7480">If you weren't expecting this, you can safely ignore this email.</p>
    `, { hideUnsubscribe: true });
  },

  documentSigned(senderName, recipientName, docTitle) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1c2230">Document Signed</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#3d4654;line-height:1.6">
        Hi ${senderName},
      </p>
      <p style="margin:0 0 8px;font-size:15px;color:#3d4654;line-height:1.6">
        <strong>${recipientName}</strong> has signed <strong>${docTitle}</strong>.
      </p>
      <p style="margin:0 0 20px;font-size:15px;color:#3d4654;line-height:1.6">
        Both parties have now completed the document. A copy of the fully executed PDF is attached to this email.
      </p>
      ${emailButton('View in Dashboard', BASE_URL + '/dashboard')}
    `);
  },

  documentCompleteRecipient(recipientName, docTitle) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1c2230">Document Complete</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#3d4654;line-height:1.6">
        Hi ${recipientName},
      </p>
      <p style="margin:0 0 20px;font-size:15px;color:#3d4654;line-height:1.6">
        <strong>${docTitle}</strong> has been fully signed by both parties. A copy of the executed document is attached for your records.
      </p>
      <p style="margin:0;font-size:13px;color:#6b7480">This document was digitally signed via Penned. Both parties attested that this electronic signature is legally binding.</p>
    `, { hideUnsubscribe: true });
  },

  passwordReset(name, resetUrl) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1c2230">Reset Your Password</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#3d4654;line-height:1.6">Hi ${name},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#3d4654;line-height:1.6">
        We received a request to reset your password. Click the button below to choose a new one:
      </p>
      ${emailButton('Reset Password', resetUrl)}
      <p style="margin:0 0 6px;font-size:13px;color:#6b7480">This link expires in 1 hour.</p>
      <p style="margin:0;font-size:13px;color:#6b7480">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
    `);
  },

  signingReminder(senderName, docTitle, signUrl, daysWaiting, expiresInDays) {
    const urgency = expiresInDays <= 5
      ? `<p style="margin:0 0 16px;font-size:14px;color:#dc2626;font-weight:500">This document expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}.</p>`
      : '';
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1c2230">Reminder: Document awaiting your signature</h2>
      <p style="margin:0 0 8px;font-size:15px;color:#3d4654;line-height:1.6">
        ${senderName} sent you a document ${daysWaiting} day${daysWaiting === 1 ? '' : 's'} ago that still needs your signature:
      </p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin:16px 0">
        <p style="margin:0;font-size:16px;font-weight:600;color:#1c2230">${docTitle}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#6b7480">From: ${senderName}</p>
      </div>
      ${urgency}
      ${emailButton('Review & Sign Document', signUrl)}
      <p style="margin:0;font-size:13px;color:#6b7480">If you've already signed this document, please disregard this reminder.</p>
    `, { hideUnsubscribe: true });
  },

  documentExpiredSender(senderName, recipientName, docTitle) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1c2230">Document Expired</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#3d4654;line-height:1.6">Hi ${senderName},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#3d4654;line-height:1.6">
        <strong>${docTitle}</strong> sent to ${recipientName} has expired after ${DOC_EXPIRY_DAYS} days without being signed.
      </p>
      <p style="margin:0 0 20px;font-size:15px;color:#3d4654;line-height:1.6">
        You can create a new document and resend it from your dashboard.
      </p>
      ${emailButton('Go to Dashboard', BASE_URL + '/dashboard')}
    `);
  },

  // Sent to OTHER unsigned signers when one of them just signed in a multi-signer doc.
  // Informational + nudge: tells them the doc is moving forward and re-surfaces their link.
  coSignerSigned(recipientName, signerWhoJustSignedName, senderName, docTitle, signUrl) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1c2230">${signerWhoJustSignedName} just signed</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#3d4654;line-height:1.6">Hi ${recipientName},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#3d4654;line-height:1.6">
        <strong>${signerWhoJustSignedName}</strong> has signed <strong>${docTitle}</strong>${senderName ? ` from ${senderName}` : ''}. The document still needs your signature to be fully executed.
      </p>
      ${emailButton('Review & Sign Document', signUrl)}
      <p style="margin:0;font-size:13px;color:#6b7480">If you've already signed, please disregard this notice.</p>
    `, { hideUnsubscribe: true });
  },

  paymentReceipt(name, amount, description, date) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1c2230">Payment Receipt</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#3d4654;line-height:1.6">Hi ${name},</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 24px;font-size:14px;color:#3d4654">
        <tr><td style="padding:14px 20px;border-bottom:1px solid #e5e7eb"><strong>Description</strong></td><td style="padding:14px 20px;border-bottom:1px solid #e5e7eb;text-align:right">${description}</td></tr>
        <tr><td style="padding:14px 20px;border-bottom:1px solid #e5e7eb"><strong>Amount</strong></td><td style="padding:14px 20px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;font-size:16px">${amount}</td></tr>
        <tr><td style="padding:14px 20px"><strong>Date</strong></td><td style="padding:14px 20px;text-align:right">${date}</td></tr>
      </table>
      <p style="margin:0;font-size:13px;color:#6b7480">If you have questions about this charge, visit your <a href="${BASE_URL}/settings#account" style="color:#16708a;text-decoration:underline">billing settings</a>.</p>
    `);
  }
};

// --------------- Helpers ---------------

// Draw text within field bounds: tries single line first, wraps if needed, shrinks as last resort
function drawFieldText(page, font, text, field) {
  const maxSize = field.fontSize || 11;
  const padding = 3;
  const fieldW = field.width - padding * 2;
  const fieldH = field.height || 18;
  const lineSpacing = 1.25;

  // Try single line at full size first
  let size = maxSize;
  let textWidth = font.widthOfTextAtSize(text, size);
  if (textWidth <= fieldW) {
    // Fits on one line - draw left-aligned from field left edge
    page.drawText(text, {
      x: field.x + padding, y: field.y + 4,
      size, font, color: rgb(0, 0, 0.4)
    });
    return;
  }

  // Wrap text into multiple lines
  const words = text.split(/\s+/);
  let lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word;
    if (font.widthOfTextAtSize(testLine, size) <= fieldW) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      // If a single word is too wide, shrink font for it
      if (font.widthOfTextAtSize(word, size) > fieldW) {
        let wordSize = size;
        while (wordSize > 6 && font.widthOfTextAtSize(word, wordSize) > fieldW) {
          wordSize -= 0.5;
        }
        size = wordSize; // Use smaller size for all remaining text
      }
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  // Check if wrapped lines fit vertically; if not, shrink font
  while (lines.length * size * lineSpacing > fieldH && size > 6) {
    size -= 0.5;
    // Re-wrap at smaller size
    lines = [];
    currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      if (font.widthOfTextAtSize(testLine, size) <= fieldW) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }

  // Draw each line, starting from top of field (highest y in PDF coords)
  const startY = field.y + fieldH - size - 2;
  for (let i = 0; i < lines.length; i++) {
    const lineY = startY - (i * size * lineSpacing);
    if (lineY < field.y - 2) break; // Don't draw below field bounds
    page.drawText(lines[i], {
      x: field.x + padding, y: lineY,
      size, font, color: rgb(0, 0, 0.4)
    });
  }
}

// --------------- Auth Helpers ---------------

function generateToken(user) {
  const jti = uuidv4();
  return jwt.sign({ id: user.id, email: user.email, jti }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    // Check blacklist
    const blacklisted = db.prepare('SELECT 1 FROM token_blacklist WHERE token_jti = ?').get(decoded.jti);
    if (blacklisted) return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

// Cleanup expired blacklist entries periodically
setInterval(() => {
  db.prepare("DELETE FROM token_blacklist WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')").run();
}, 60 * 60 * 1000); // every hour

// Reset monthly counters
function resetMonthlyCounters() {
  db.prepare("UPDATE users SET documents_sent_this_month = 0, monthly_reset_date = date('now', 'start of month', '+1 month') WHERE monthly_reset_date <= date('now')").run();
}

// --------------- Auth Middleware ---------------

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  const token = authHeader.slice(7);
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const user = db.prepare('SELECT id, email, name, plan_type, documents_sent_this_month, monthly_reset_date, created_at FROM users WHERE id = ?').get(decoded.id);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  req.user = user;
  next();
}

// --------------- Auth Routes ---------------

app.post('/api/auth/register', registerLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const name = sanitize(req.body.name || '');
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (name.length > 100) return res.status(400).json({ error: 'Name is too long' });
    const pwErr = validatePassword(password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const id = uuidv4();
    const password_hash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)').run(id, email.toLowerCase(), password_hash, name);

    const user = db.prepare('SELECT id, email, name, plan_type, documents_sent_this_month, created_at FROM users WHERE id = ?').get(id);
    const token = generateToken(user);

    // Send welcome email (non-blocking)
    sendEmail(user.email, 'Welcome to Penned', emailTemplates.welcome(user.name)).catch(e => console.error('Welcome email error:', e));

    res.json({ token, user });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);
    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
      if (decoded.jti && decoded.exp) {
        const expiresAt = new Date(decoded.exp * 1000).toISOString();
        db.prepare('INSERT OR IGNORE INTO token_blacklist (token_jti, expires_at) VALUES (?, ?)').run(decoded.jti, expiresAt);
      }
    } catch (e) { /* token already invalid, nothing to blacklist */ }
  }
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  resetMonthlyCounters();
  const user = db.prepare('SELECT id, email, name, plan_type, documents_sent_this_month, monthly_reset_date, created_at FROM users WHERE id = ?').get(req.user.id);
  res.json(user);
});

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  // Always return success to avoid leaking which emails exist
  const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user) {
    return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const id = uuidv4();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('INSERT INTO password_reset_tokens (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)').run(id, user.id, token, expiresAt);

  const resetUrl = `${BASE_URL}/login.html?reset=${token}`;
  await sendEmail(
    email,
    'Reset your Penned password',
    emailTemplates.passwordReset(user.name, resetUrl)
  );

  res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });

  const resetToken = db.prepare("SELECT * FROM password_reset_tokens WHERE token = ? AND used = 0 AND expires_at > datetime('now')").get(token);
  if (!resetToken) {
    return res.status(400).json({ error: 'Invalid or expired reset token' });
  }

  const password_hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(password_hash, resetToken.user_id);
  db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE id = ?').run(resetToken.id);

  res.json({ success: true, message: 'Password has been reset. You can now log in.' });
});

// --------------- Settings Routes ---------------

app.get('/api/settings', requireAuth, (req, res) => {
  resetMonthlyCounters();
  const user = db.prepare('SELECT id, email, name, plan_type, company_name, logo_path, notify_signed, notify_expired, documents_sent_this_month, monthly_reset_date, stripe_customer_id, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.put('/api/settings/profile', requireAuth, async (req, res) => {
  try {
    const name = sanitize(req.body.name || '');
    const email = (req.body.email || '').trim();
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    if (name.length > 100) return res.status(400).json({ error: 'Name is too long' });
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email) || email.length > 254) return res.status(400).json({ error: 'Invalid email address' });

    const normalizedEmail = email.toLowerCase();
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(normalizedEmail, req.user.id);
    if (existing) return res.status(409).json({ error: 'That email is already in use by another account' });

    db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, normalizedEmail, req.user.id);
    const user = db.prepare('SELECT id, email, name, plan_type, company_name, logo_path, notify_signed, notify_expired, created_at FROM users WHERE id = ?').get(req.user.id);
    res.json({ success: true, user });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

app.put('/api/settings/password', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
    const pwErr = validatePassword(newPassword);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

app.put('/api/settings/notifications', requireAuth, (req, res) => {
  const { notify_signed, notify_expired } = req.body;
  db.prepare('UPDATE users SET notify_signed = ?, notify_expired = ? WHERE id = ?').run(
    notify_signed ? 1 : 0, notify_expired ? 1 : 0, req.user.id
  );
  res.json({ success: true });
});

app.put('/api/settings/branding', requireAuth, (req, res) => {
  const company_name = sanitize(req.body.company_name || '');
  if (company_name.length > 200) return res.status(400).json({ error: 'Company name is too long' });
  db.prepare('UPDATE users SET company_name = ? WHERE id = ?').run(company_name || null, req.user.id);
  res.json({ success: true });
});

app.post('/api/settings/logo', requireAuth, logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Delete old logo if exists
  const user = db.prepare('SELECT logo_path FROM users WHERE id = ?').get(req.user.id);
  if (user.logo_path) {
    try { fs.unlinkSync(path.join(__dirname, user.logo_path)); } catch (e) { /* ignore */ }
  }

  const ext = path.extname(req.file.originalname) || '.png';
  const newPath = path.join('uploads', 'logos', req.user.id + ext);
  fs.renameSync(req.file.path, path.join(__dirname, newPath));
  db.prepare('UPDATE users SET logo_path = ? WHERE id = ?').run(newPath, req.user.id);
  res.json({ success: true, logo_path: newPath });
});

app.delete('/api/settings/logo', requireAuth, (req, res) => {
  const user = db.prepare('SELECT logo_path FROM users WHERE id = ?').get(req.user.id);
  if (user.logo_path) {
    try { fs.unlinkSync(path.join(__dirname, user.logo_path)); } catch (e) { /* ignore */ }
  }
  db.prepare('UPDATE users SET logo_path = NULL WHERE id = ?').run(req.user.id);
  res.json({ success: true });
});

app.delete('/api/settings/account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Password is required to delete your account' });

    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect password' });

    // Archive to deleted_accounts before wiping
    const archiveUser = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    const totalDocs   = db.prepare('SELECT COUNT(*) as n FROM documents WHERE user_id=?').get(req.user.id).n;
    const totalSpent  = db.prepare('SELECT COALESCE(SUM(amount_cents),0) as t FROM billing_history WHERE user_id=?').get(req.user.id).t;
    db.prepare(`INSERT OR REPLACE INTO deleted_accounts (id,name,email,plan_type,company_name,total_docs,total_spent_cents,joined_at,deleted_by)
      VALUES (?,?,?,?,?,?,?,?,'self')`).run(archiveUser.id, archiveUser.name, archiveUser.email, archiveUser.plan_type, archiveUser.company_name||null, totalDocs, totalSpent, archiveUser.created_at);

    // Delete user's documents and their files
    const docs = db.prepare('SELECT pdf_path, final_pdf_path FROM documents WHERE user_id = ?').all(req.user.id);
    for (const doc of docs) {
      try { if (doc.pdf_path && fs.existsSync(doc.pdf_path)) fs.unlinkSync(doc.pdf_path); } catch (e) { /* */ }
      try { if (doc.final_pdf_path && fs.existsSync(doc.final_pdf_path)) fs.unlinkSync(doc.final_pdf_path); } catch (e) { /* */ }
    }
    db.prepare('DELETE FROM documents WHERE user_id = ?').run(req.user.id);
    db.prepare('DELETE FROM saved_templates WHERE sender_email = ?').run(req.user.email);
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(req.user.id);

    // Delete logo
    const fullUser = db.prepare('SELECT logo_path FROM users WHERE id = ?').get(req.user.id);
    if (fullUser.logo_path) {
      try { fs.unlinkSync(path.join(__dirname, fullUser.logo_path)); } catch (e) { /* */ }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

// --------------- Protected API Routes ---------------
// Apply auth to all /api/ routes EXCEPT /api/auth/*, /api/documents/:id (GET for signing), /api/documents/:id/pdf, /api/documents/:id/sign-*

app.use('/api', (req, res, next) => {
  // Skip auth for auth routes, webhooks, CSRF token, and admin (admin has its own requireAdmin middleware)
  if (req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/webhooks/')) return next();
  if (req.path.startsWith('/admin/')) return next();
  if (req.path === '/csrf-token' && req.method === 'GET') return next();
  // Skip auth for public signing endpoints
  const docMatch = req.path.match(/^\/documents\/([^/]+)/);
  if (docMatch) {
    const subpath = req.path.slice(`/documents/${docMatch[1]}`.length);
    // Allow GET doc info and PDF (needed by signing page)
    if (req.method === 'GET' && (subpath === '' || subpath === '/pdf')) return next();
    // Allow POST sign-sender and sign-recipient (public signing)
    if (req.method === 'POST' && (subpath === '/sign-sender' || subpath === '/sign-recipient')) return next();
  }
  // Everything else requires auth
  requireAuth(req, res, next);
});

// CSRF protection on all state-changing API requests
app.use('/api', csrfProtection);

// --------------- API Routes ---------------

// Curated public template library
app.get('/api/library', (req, res) => {
  // Return manifest minus internal file paths — clients only need IDs to request PDFs.
  const safe = {
    version: libraryManifest.version,
    categories: (libraryManifest.categories || []).map(cat => ({
      id: cat.id,
      name: cat.name,
      description: cat.description || '',
      items: (cat.items || []).map(it => ({
        id: it.id,
        name: it.name,
        subtitle: it.subtitle || '',
        province: it.province || '',
        description: it.description || '',
        source: it.source || ''
      }))
    }))
  };
  res.json(safe);
});

app.get('/api/library/:itemId/pdf', (req, res) => {
  const item = libraryItemsById[req.params.itemId];
  if (!item) return res.status(404).json({ error: 'Library item not found' });
  const filePath = path.join(libraryDir, item.file);
  // Defence-in-depth: ensure resolved path is inside libraryDir.
  if (!path.resolve(filePath).startsWith(path.resolve(libraryDir))) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'PDF missing' });
  res.sendFile(filePath);
});

// Resolve a saved-template PDF on disk. Prefers the path computed from the
// current savedTemplatesDir (so the live config wins over a stored absolute
// path that may have gone stale across deploys/migrations); falls back to the
// path stored in the row for any legacy data.
function resolveSavedTemplatePdf(id, storedPath) {
  const computed = path.join(savedTemplatesDir, `${id}.pdf`);
  if (fs.existsSync(computed)) return computed;
  if (storedPath && fs.existsSync(storedPath)) return storedPath;
  return null;
}

// Serve user-saved template PDFs (per-user; ownership enforced below).
app.get('/api/saved-template-pdf/:id', (req, res) => {
  const t = db.prepare('SELECT user_id, uploaded_pdf_path FROM saved_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const filePath = resolveSavedTemplatePdf(req.params.id, t.uploaded_pdf_path);
  if (!filePath) {
    console.error(`[TEMPLATE-MISSING] saved_template ${req.params.id} has no PDF (stored=${t.uploaded_pdf_path || 'null'})`);
    return res.status(410).json({ error: "This template's PDF is no longer available. Please re-upload it." });
  }
  res.sendFile(path.resolve(filePath));
});

// --------------- Generate PDF from typed content ---------------
app.post('/api/generate-doc-pdf', requireAuth, async (req, res) => {
  try {
    const { blocks } = req.body;
    if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
      return res.status(400).json({ error: 'No content provided' });
    }

    const pdfDoc = await PDFDocument.create();
    const fonts = {
      normal:     await pdfDoc.embedFont(StandardFonts.Helvetica),
      bold:       await pdfDoc.embedFont(StandardFonts.HelveticaBold),
      italic:     await pdfDoc.embedFont(StandardFonts.HelveticaOblique),
      boldItalic: await pdfDoc.embedFont(StandardFonts.HelveticaBoldOblique),
    };

    function pickFont(bold, italic) {
      if (bold && italic) return fonts.boldItalic;
      if (bold) return fonts.bold;
      if (italic) return fonts.italic;
      return fonts.normal;
    }

    // US Letter
    const PW = 612, PH = 792, ML = 72, MR = 72, MT = 72, MB = 90;
    const CW = PW - ML - MR;
    const INK = rgb(0.08, 0.09, 0.11);

    let page = pdfDoc.addPage([PW, PH]);
    let y = PH - MT;

    function newPage() { page = pdfDoc.addPage([PW, PH]); y = PH - MT; }
    function ensureSpace(h) { if (y - h < MB) newPage(); }

    for (const block of blocks) {
      // Page break — start a new PDF page
      if (block.type === 'page_break') {
        newPage();
        continue;
      }

      // Signature line — underline + Signature / Date labels
      if (block.type === 'sig_line') {
        ensureSpace(80);
        y -= 20; // top breathing room
        const lineY = y - 30;
        page.drawLine({
          start: { x: ML, y: lineY },
          end:   { x: ML + CW, y: lineY },
          thickness: 0.75,
          color: rgb(0.3, 0.3, 0.3),
        });
        page.drawText('Signature', { x: ML, y: lineY - 13, size: 8, font: fonts.normal, color: rgb(0.5, 0.5, 0.5) });
        page.drawText('Date', { x: ML + CW - 22, y: lineY - 13, size: 8, font: fonts.normal, color: rgb(0.5, 0.5, 0.5) });
        y -= 60;
        continue;
      }

      const isH1 = block.type === 'h1';
      const isH2 = block.type === 'h2';
      const fontSize   = isH1 ? 22 : isH2 ? 16 : 11;
      const lineHeight = isH1 ? 30 : isH2 ? 24 : 17;
      const spaceBefore = isH1 ? 20 : isH2 ? 14 : 0;
      const spaceAfter  = isH1 ? 10 : isH2 ? 8  : 8;
      const defaultBold = isH1 || isH2;

      // Build word tokens with font info, respecting explicit line breaks
      const tokens = [];
      for (const seg of (block.segments || [])) {
        const font = pickFont(defaultBold || seg.bold, seg.italic);
        const lines = seg.text.split('\n');
        for (let li = 0; li < lines.length; li++) {
          if (li > 0) tokens.push({ isBreak: true });
          const parts = lines[li].split(/(\s+)/);
          for (const part of parts) {
            if (part) tokens.push({ text: part, font, isSpace: /^\s+$/.test(part) });
          }
        }
      }

      // Word-wrap into visual lines
      const wrappedLines = [[]];
      let lineW = 0;
      for (const tok of tokens) {
        if (tok.isBreak) { wrappedLines.push([]); lineW = 0; continue; }
        const w = tok.font.widthOfTextAtSize(tok.text, fontSize);
        if (!tok.isSpace && lineW + w > CW && wrappedLines[wrappedLines.length - 1].length > 0) {
          wrappedLines.push([]); lineW = 0;
        }
        wrappedLines[wrappedLines.length - 1].push({ ...tok, width: w });
        lineW += w;
      }

      ensureSpace(spaceBefore + lineHeight);
      y -= spaceBefore;

      for (const lineTokens of wrappedLines) {
        if (lineTokens.length === 0) { y -= lineHeight * 0.5; continue; }
        ensureSpace(lineHeight);
        let x = ML;
        for (const t of lineTokens) {
          if (t.text && t.text.trim()) {
            page.drawText(t.text, { x, y: y - fontSize, size: fontSize, font: t.font, color: INK });
          }
          x += t.width;
        }
        y -= lineHeight;
      }

      y -= spaceAfter;
    }

    const pdfBytes = await pdfDoc.save();
    const filename = `doc_${uuidv4()}.pdf`;
    const filepath = path.join(__dirname, 'uploads', filename);
    await fs.promises.writeFile(filepath, pdfBytes);
    res.json({ path: filepath, filename });
  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'Failed to generate PDF' });
  }
});

// --------------- Billing Helpers ---------------

// Check if user can send a document, and what action is needed
function checkBillingStatus(userId) {
  resetMonthlyCounters();
  const user = db.prepare('SELECT plan_type, documents_sent_this_month, monthly_reset_date, stripe_customer_id FROM users WHERE id = ?').get(userId);
  if (!user) return { allowed: false, reason: 'User not found' };

  if (user.plan_type === 'unlimited') {
    return { allowed: true, plan: 'unlimited' };
  }

  if (user.documents_sent_this_month < FREE_DOC_LIMIT) {
    return { allowed: true, plan: user.plan_type, used: user.documents_sent_this_month, limit: FREE_DOC_LIMIT, reset_date: user.monthly_reset_date };
  }

  return {
    allowed: false,
    plan: user.plan_type,
    used: user.documents_sent_this_month,
    limit: FREE_DOC_LIMIT,
    reset_date: user.monthly_reset_date,
    reason: 'limit_reached'
  };
}

// --------------- Billing Routes ---------------

// Check current billing status before sending
app.get('/api/billing/status', requireAuth, (req, res) => {
  const status = checkBillingStatus(req.user.id);
  res.json(status);
});

// Get billing history
app.get('/api/billing/history', requireAuth, (req, res) => {
  const history = db.prepare('SELECT id, type, amount_cents, currency, description, created_at FROM billing_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json(history);
});

// Create Stripe Checkout session for Unlimited plan
const STRIPE_PAYMENT_LINK_UNLIMITED = 'https://buy.stripe.com/eVq7sL8pVgkk46NanS0gw00';

app.post('/api/billing/create-checkout', requireAuth, (req, res) => {
  try {
    const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.user.id);
    const url = `${STRIPE_PAYMENT_LINK_UNLIMITED}?client_reference_id=${encodeURIComponent(user.id)}&prefilled_email=${encodeURIComponent(user.email)}`;
    res.json({ url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to generate checkout URL' });
  }
});

// Create a one-time Stripe Checkout session for pay-per-document ($1.99)
app.post('/api/billing/create-per-doc-checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured' });

  try {
    const user = db.prepare('SELECT id, email, name, stripe_customer_id FROM users WHERE id = ?').get(req.user.id);

    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: { user_id: user.id }
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: PAY_PER_DOC_PRICE,
          product_data: { name: 'Penned: Single Document', description: 'One-time charge for sending one document' }
        },
        quantity: 1
      }],
      allow_promotion_codes: true,
      success_url: `${BASE_URL}/dashboard?billing=per_doc_success`,
      cancel_url: `${BASE_URL}/dashboard?billing=cancelled`,
      metadata: { user_id: user.id, type: 'per_doc' }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe per-doc checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create Stripe Customer Portal session
app.get('/api/billing/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured' });

  try {
    const user = db.prepare('SELECT stripe_customer_id FROM users WHERE id = ?').get(req.user.id);
    if (!user.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found. Subscribe first.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: `${BASE_URL}/settings#account`
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal error:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Upload a new PDF
app.post('/api/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const newPath = req.file.path + '.pdf';
  fs.renameSync(req.file.path, newPath);
  res.json({ path: newPath, filename: req.file.originalname });
});

// Create a new document for signing
app.post('/api/documents', docSendLimiter, (req, res) => {
  const title = sanitize(req.body.title || '');
  const senderName = sanitize(req.body.senderName || '');
  const recipientName = sanitize(req.body.recipientName || '');
  const senderEmail = (req.body.senderEmail || '').trim().toLowerCase();
  const recipientEmail = (req.body.recipientEmail || '').trim().toLowerCase();
  const { pdfSource, templateName, libraryItemId, savedTemplatePdf, fields, extraSigners } = req.body;

  // Validate inputs
  if (title.length > 300) return res.status(400).json({ error: 'Title is too long' });
  if (senderName.length > 100 || recipientName.length > 100) return res.status(400).json({ error: 'Name is too long' });
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (senderEmail && !emailRegex.test(senderEmail)) return res.status(400).json({ error: 'Invalid sender email' });
  if (recipientEmail && !emailRegex.test(recipientEmail)) return res.status(400).json({ error: 'Invalid recipient email' });

  // Validate + normalize extra signers (signers beyond the primary recipient).
  // Cap at 4 extras (5 total signers including the primary). Each entry becomes
  // { name, email, signed_at: null, ip: null }.
  let normalizedExtraSigners = null;
  if (Array.isArray(extraSigners) && extraSigners.length > 0) {
    if (extraSigners.length > 4) return res.status(400).json({ error: 'Too many additional signers (max 4)' });
    normalizedExtraSigners = [];
    for (let i = 0; i < extraSigners.length; i++) {
      const s = extraSigners[i] || {};
      const sName = sanitize((s.name || '').toString());
      const sEmail = (s.email || '').toString().trim().toLowerCase();
      if (!sName || !sEmail) return res.status(400).json({ error: `Signer ${i + 2} is missing a name or email` });
      if (sName.length > 100) return res.status(400).json({ error: `Signer ${i + 2} name is too long` });
      if (!emailRegex.test(sEmail)) return res.status(400).json({ error: `Signer ${i + 2} has an invalid email` });
      normalizedExtraSigners.push({ name: sName, email: sEmail, signed_at: null, ip: null });
    }
  }

  // Billing check
  const userId = req.user ? req.user.id : null;
  if (userId) {
    const billing = checkBillingStatus(userId);
    if (!billing.allowed) {
      return res.status(402).json({
        error: 'Document limit reached',
        billing: billing
      });
    }
  }

  const id = uuidv4();

  let pdfPath;
  try {
    if (libraryItemId) {
      const item = libraryItemsById[libraryItemId];
      if (!item) return res.status(400).json({ error: 'Unknown library template' });
      const src = path.join(libraryDir, item.file);
      if (!fs.existsSync(src)) return res.status(400).json({ error: 'Library PDF missing' });
      pdfPath = path.join(__dirname, 'uploads', `${id}.pdf`);
      fs.copyFileSync(src, pdfPath);
    } else if (templateName) {
      // Backwards-compat: only allowed for files inside savedTemplatesDir (per-user)
      const src = path.join(savedTemplatesDir, path.basename(templateName));
      if (!fs.existsSync(src)) return res.status(400).json({ error: "Template PDF no longer available. Please re-upload the template." });
      pdfPath = path.join(__dirname, 'uploads', `${id}.pdf`);
      fs.copyFileSync(src, pdfPath);
    } else if (savedTemplatePdf) {
      if (!fs.existsSync(savedTemplatePdf)) return res.status(400).json({ error: "Template PDF no longer available. Please re-upload the template." });
      pdfPath = path.join(__dirname, 'uploads', `${id}.pdf`);
      fs.copyFileSync(savedTemplatePdf, pdfPath);
    } else if (pdfSource) {
      pdfPath = pdfSource;
    } else {
      return res.status(400).json({ error: 'No PDF source provided' });
    }
  } catch (err) {
    console.error('[DOC-CREATE] PDF copy failed:', err.message, { libraryItemId, templateName, savedTemplatePdf });
    return res.status(500).json({ error: "Could not prepare the document's PDF. Please try again or re-upload the source." });
  }

  db.prepare(`
    INSERT INTO documents (id, title, pdf_path, sender_name, sender_email, recipient_name, recipient_email, fields, template_name, user_id, extra_signers, current_signer_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id, title || 'Untitled Document', pdfPath,
    senderName, senderEmail, recipientName, recipientEmail,
    JSON.stringify(fields || []), templateName || null, userId,
    normalizedExtraSigners ? JSON.stringify(normalizedExtraSigners) : null
  );

  // Increment monthly counter
  if (userId) {
    resetMonthlyCounters();
    db.prepare('UPDATE users SET documents_sent_this_month = documents_sent_this_month + 1 WHERE id = ?').run(userId);
  }

  // Include pdf_path so the client can reference the freshly-created file
  // (e.g. to save as a template before sign-sender overwrites it).
  res.json({ id, url: `${BASE_URL}/sign/${id}?role=sender`, pdf_path: pdfPath });
});

// Dashboard stats
app.get('/api/stats', requireAuth, (req, res) => {
  try {
    resetMonthlyCounters();
    const user = db.prepare('SELECT documents_sent_this_month, plan_type FROM users WHERE id = ?').get(req.user.id);
    const awaiting = db.prepare("SELECT COUNT(*) as count FROM documents WHERE user_id = ? AND status = 'awaiting_recipient'").get(req.user.id);
    const completed = db.prepare("SELECT COUNT(*) as count FROM documents WHERE user_id = ? AND status = 'completed'").get(req.user.id);
    const total = db.prepare("SELECT COUNT(*) as count FROM documents WHERE user_id = ?").get(req.user.id);
    res.json({
      sent_this_month: user ? user.documents_sent_this_month : 0,
      plan_type: user ? user.plan_type : 'free',
      awaiting: awaiting.count,
      completed: completed.count,
      total: total.count
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// List all documents (scoped to authenticated user)
app.get('/api/documents', (req, res) => {
  const docs = db.prepare('SELECT id, title, status, sender_name, recipient_name, recipient_email, created_at, sender_completed_at, recipient_completed_at, expires_at, reminder_count, extra_signers, current_signer_index FROM documents WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  // Parse extra_signers JSON for the client (don't leak signer IPs).
  for (const d of docs) {
    if (d.extra_signers) {
      try {
        const parsed = JSON.parse(d.extra_signers);
        d.extra_signers = parsed.map(s => ({ name: s.name, email: s.email, signed_at: s.signed_at }));
      } catch (e) { d.extra_signers = null; }
    }
  }
  res.json(docs);
});

// Get document info
app.get('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  // Check if document should be expired on access
  if (doc.status === 'awaiting_recipient' && doc.expires_at && new Date(doc.expires_at) < new Date()) {
    db.prepare("UPDATE documents SET status = 'expired' WHERE id = ?").run(doc.id);
    doc.status = 'expired';
  }
  doc.fields = JSON.parse(doc.fields || '[]');
  // Parse extra_signers JSON for client; strip IPs (not needed by UI).
  if (doc.extra_signers) {
    try {
      const parsed = JSON.parse(doc.extra_signers);
      doc.extra_signers = parsed.map(s => ({ name: s.name, email: s.email, signed_at: s.signed_at }));
    } catch (e) { doc.extra_signers = null; }
  }
  res.json(doc);
});

// Get the PDF for a document
app.get('/api/documents/:id/pdf', (req, res) => {
  const doc = db.prepare('SELECT pdf_path, final_pdf_path, status FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  const filePath = doc.status === 'completed' && doc.final_pdf_path ? doc.final_pdf_path : doc.pdf_path;
  res.sendFile(path.resolve(filePath));
});

// Submit sender's fields and signature, then email to recipient
app.post('/api/documents/:id/sign-sender', async (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.status !== 'draft') return res.status(400).json({ error: 'Document has already been signed by sender' });

    const { fieldValues, signatureDataUrl, attestation, fields: clientFields } = req.body;
    if (!attestation) return res.status(400).json({ error: 'Attestation required' });

    // Build overlay PDF with sender fields, then stamp onto original
    const pdfBytes = fs.readFileSync(doc.pdf_path);
    const origPdf = await PDFDocument.load(pdfBytes);
    const overlay = await PDFDocument.create();
    const font = await overlay.embedFont(StandardFonts.Helvetica);

    // Create blank pages matching original dimensions
    for (let i = 0; i < origPdf.getPageCount(); i++) {
      const p = origPdf.getPage(i);
      overlay.addPage([p.getWidth(), p.getHeight()]);
    }

    const fields = JSON.parse(doc.fields || '[]');

    // Sender may resize their own text fields on the signing page. Merge in only the
    // dimensions (width/height) for fields the sender owns — never type/role/page/x/y/id/label.
    if (Array.isArray(clientFields)) {
      const byId = new Map(clientFields.map(f => [f && f.id, f]));
      for (const f of fields) {
        if (f.role !== 'sender') continue;
        const incoming = byId.get(f.id);
        if (!incoming) continue;
        if (typeof incoming.width === 'number' && incoming.width >= 20 && incoming.width <= 600) {
          f.width = incoming.width;
        }
        if (typeof incoming.height === 'number' && incoming.height >= 10 && incoming.height <= 400) {
          f.height = incoming.height;
        }
      }
    }
    console.log('[SENDER SIGN] fieldValues:', JSON.stringify(fieldValues));
    console.log('[SENDER SIGN] has signature:', !!signatureDataUrl);
    for (const field of fields) {
      if (field.role !== 'sender') continue;
      const page = overlay.getPage(field.page);
      if (field.type === 'signature') {
        if (!signatureDataUrl) continue;
        const sigBytes = Buffer.from(signatureDataUrl.split(',')[1], 'base64');
        const sigImage = await overlay.embedPng(sigBytes);
        const dims = sigImage.scale(Math.min(field.width / sigImage.width, field.height / sigImage.height));
        page.drawImage(sigImage, { x: field.x, y: field.y, width: dims.width, height: dims.height });
        console.log('[SENDER SIGN] Drew signature at', field.x, field.y);
      } else if (fieldValues[field.id]) {
        drawFieldText(page, font, fieldValues[field.id], field);
        console.log('[SENDER SIGN] Drew text "' + fieldValues[field.id] + '" in field at', field.x, field.y, 'w:', field.width, 'h:', field.height);
      }
    }

    // Attestation footer. In multi-signer mode push the sender line above where
    // each recipient's attestation will land (signer N at y = 10 + N*8).
    const senderExtras = doc.extra_signers ? JSON.parse(doc.extra_signers) : [];
    const senderAttestY = senderExtras.length > 0 ? (10 + senderExtras.length * 8 + 8) : 20;
    const lastPage = overlay.getPage(overlay.getPageCount() - 1);
    const attestText = `Digitally signed by ${doc.sender_name} on ${new Date().toISOString()} | IP: ${req.ip}`;
    lastPage.drawText(attestText, { x: 30, y: senderAttestY, size: 7, font, color: rgb(0.4, 0.4, 0.4) });

    // Save overlay and merge with original using qpdf
    const overlayPath = doc.pdf_path + '.overlay.pdf';
    const mergedPath = doc.pdf_path + '.merged.pdf';
    fs.writeFileSync(overlayPath, await overlay.save());
    execSync(`qpdf "${doc.pdf_path}" --overlay "${overlayPath}" -- "${mergedPath}"`);
    fs.renameSync(mergedPath, doc.pdf_path);
    fs.unlinkSync(overlayPath);

    // Update DB — set expiration to 30 days from now. current_signer_index
    // resets to 0 here in case the doc was re-prepared.
    const expiresAt = new Date(Date.now() + DOC_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE documents SET status = 'awaiting_recipient', sender_completed_at = datetime('now'), ip_sender = ?, fields = ?, expires_at = ?, current_signer_index = 0
      WHERE id = ?
    `).run(req.ip, JSON.stringify(fields), expiresAt, doc.id);

    // Email every signer in parallel — any of them can sign first, in any order.
    // Primary recipient gets the legacy URL shape (no `signer` param) for back-compat.
    const allSigners = [
      { name: doc.recipient_name, email: doc.recipient_email, idx: 0 },
      ...senderExtras.map((s, i) => ({ name: s.name, email: s.email, idx: i + 1 }))
    ];
    let mailErrors = 0;
    for (const sgn of allSigners) {
      const signUrl = sgn.idx === 0
        ? `${BASE_URL}/sign/${doc.id}?role=recipient`
        : `${BASE_URL}/sign/${doc.id}?role=recipient&signer=${sgn.idx}`;
      try {
        await sendEmail(
          sgn.email,
          `${doc.sender_name} sent you a document to sign`,
          emailTemplates.signingInvitation(doc.sender_name, doc.title, signUrl)
        );
      } catch (mailErr) {
        mailErrors++;
        console.error(`sign-sender: failed to email signer ${sgn.idx} (${sgn.email}):`, mailErr);
      }
    }

    const sendMsg = allSigners.length === 1
      ? 'Document sent to recipient for signing'
      : `Document sent to ${allSigners.length} signers — any of them can sign first.`;
    res.json({ success: true, message: sendMsg, mailErrors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Submit a signer's fields and signature.
//
// Single-signer mode (no extra_signers): unchanged — stamp the recipient's fields,
// finalize, email both parties.
//
// Multi-signer mode (extra_signers populated): PARALLEL signing — any signer can
// sign at any time, in any order. After signing, if all signers are now done the
// doc is finalized and everyone is emailed the completed PDF; otherwise the OTHER
// still-unsigned signers get an FYI email ("[X] just signed — you still need to").
app.post('/api/documents/:id/sign-recipient', async (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.status === 'expired') return res.status(410).json({ error: 'This document has expired and can no longer be signed' });
    if (doc.status !== 'awaiting_recipient') return res.status(400).json({ error: 'Document not ready for recipient signing' });
    if (doc.expires_at && new Date(doc.expires_at) < new Date()) {
      db.prepare("UPDATE documents SET status = 'expired' WHERE id = ?").run(doc.id);
      return res.status(410).json({ error: 'This document has expired and can no longer be signed' });
    }

    const extras = doc.extra_signers ? JSON.parse(doc.extra_signers) : [];
    const totalSigners = 1 + extras.length;
    const hasMultipleSigners = extras.length > 0;

    // Resolve signer index from body or query. Defaults to 0 for back-compat with
    // single-signer URLs that don't carry a `signer` param.
    let signerIdx = 0;
    if (req.body && typeof req.body.signerIndex === 'number') signerIdx = req.body.signerIndex;
    else if (req.query && req.query.signer != null) {
      const fromQuery = parseInt(req.query.signer, 10);
      if (!isNaN(fromQuery)) signerIdx = fromQuery;
    }
    if (signerIdx < 0 || signerIdx >= totalSigners) return res.status(400).json({ error: 'Invalid signer index' });

    // Already-signed guard.
    if (signerIdx === 0 && doc.recipient_completed_at) return res.status(400).json({ error: 'You have already signed this document' });
    if (signerIdx > 0 && extras[signerIdx - 1] && extras[signerIdx - 1].signed_at) {
      return res.status(400).json({ error: 'You have already signed this document' });
    }

    const { fieldValues, signatureDataUrl, attestation } = req.body;
    if (!attestation) return res.status(400).json({ error: 'Attestation required' });

    // Build overlay PDF
    const pdfBytes = fs.readFileSync(doc.pdf_path);
    const origPdf = await PDFDocument.load(pdfBytes);
    const overlay = await PDFDocument.create();
    const font = await overlay.embedFont(StandardFonts.Helvetica);

    for (let i = 0; i < origPdf.getPageCount(); i++) {
      const p = origPdf.getPage(i);
      overlay.addPage([p.getWidth(), p.getHeight()]);
    }

    const fields = JSON.parse(doc.fields || '[]');

    // Belongs to this signer? In single-signer mode, ALL recipient fields belong
    // to the only signer (back-compat — old fields lack signer_index).
    const fieldBelongsHere = (field) => {
      if (field.role !== 'recipient') return false;
      if (!hasMultipleSigners) return true;
      const fIdx = typeof field.signer_index === 'number' ? field.signer_index : 0;
      return fIdx === signerIdx;
    };

    console.log('[RECIPIENT SIGN] signerIdx:', signerIdx, 'of', totalSigners);

    for (const field of fields) {
      if (!fieldBelongsHere(field)) continue;
      const page = overlay.getPage(field.page);
      if (field.type === 'signature') {
        if (!signatureDataUrl) continue;
        const sigBytes = Buffer.from(signatureDataUrl.split(',')[1], 'base64');
        const sigImage = await overlay.embedPng(sigBytes);
        const dims = sigImage.scale(Math.min(field.width / sigImage.width, field.height / sigImage.height));
        page.drawImage(sigImage, { x: field.x, y: field.y, width: dims.width, height: dims.height });
      } else if (fieldValues[field.id]) {
        drawFieldText(page, font, fieldValues[field.id], field);
      }
    }

    // Attestation footer. Single-signer: y=10 (existing behavior). Multi-signer:
    // each signer gets a distinct line (y=10 + idx*8) so they don't overlap.
    const lastPage = overlay.getPage(overlay.getPageCount() - 1);
    const thisSignerName = signerIdx === 0 ? doc.recipient_name : extras[signerIdx - 1].name;
    const attestText = `Digitally signed by ${thisSignerName} on ${new Date().toISOString()} | IP: ${req.ip}`;
    const attestY = hasMultipleSigners ? (10 + signerIdx * 8) : 10;
    lastPage.drawText(attestText, { x: 30, y: attestY, size: 7, font, color: rgb(0.4, 0.4, 0.4) });

    // Build a snapshot of all signers' status, marking THIS one as just-signed.
    // Used to decide finalize-vs-notify-others without re-querying mid-flow.
    const signerStatus = [
      {
        idx: 0,
        name: doc.recipient_name,
        email: doc.recipient_email,
        signed: signerIdx === 0 ? true : !!doc.recipient_completed_at
      },
      ...extras.map((s, i) => ({
        idx: i + 1,
        name: s.name,
        email: s.email,
        signed: (signerIdx === i + 1) ? true : !!s.signed_at
      }))
    ];
    const isLastSigner = signerStatus.every(s => s.signed);
    const overlayPath = doc.pdf_path + '.overlay.pdf';
    fs.writeFileSync(overlayPath, await overlay.save());

    if (isLastSigner) {
      // Finalize: stamp into signed/{id}-final.pdf
      const finalPath = path.join(__dirname, 'signed', `${doc.id}-final.pdf`);
      execSync(`qpdf "${doc.pdf_path}" --overlay "${overlayPath}" -- "${finalPath}"`);
      fs.unlinkSync(overlayPath);

      if (signerIdx === 0) {
        db.prepare(`
          UPDATE documents SET status = 'completed', recipient_completed_at = datetime('now'), ip_recipient = ?, final_pdf_path = ?
          WHERE id = ?
        `).run(req.ip, finalPath, doc.id);
      } else {
        extras[signerIdx - 1].signed_at = new Date().toISOString();
        extras[signerIdx - 1].ip = req.ip;
        db.prepare(`
          UPDATE documents SET status = 'completed', extra_signers = ?, final_pdf_path = ?
          WHERE id = ?
        `).run(JSON.stringify(extras), finalPath, doc.id);
      }

      // Email all parties the completed document
      const attachment = { filename: `${doc.title} - Signed.pdf`, path: finalPath };
      const allRecipientNames = [doc.recipient_name, ...extras.map(s => s.name)].filter(Boolean).join(', ');

      try {
        await sendEmail(
          doc.sender_email,
          `Signed: ${doc.title}`,
          emailTemplates.documentSigned(doc.sender_name, allRecipientNames, doc.title),
          [attachment]
        );
      } catch (e) { console.error('Failed to email sender completion copy:', e); }
      try {
        await sendEmail(
          doc.recipient_email,
          `Signed: ${doc.title}`,
          emailTemplates.documentCompleteRecipient(doc.recipient_name, doc.title),
          [attachment]
        );
      } catch (e) { console.error('Failed to email primary recipient completion copy:', e); }
      for (const s of extras) {
        try {
          await sendEmail(
            s.email,
            `Signed: ${doc.title}`,
            emailTemplates.documentCompleteRecipient(s.name, doc.title),
            [attachment]
          );
        } catch (mailErr) {
          console.error(`Failed to email completion copy to ${s.email}:`, mailErr);
        }
      }

      const completionMsg = hasMultipleSigners
        ? 'Document fully executed. Copies sent to all parties.'
        : 'Document fully executed. Copies sent to both parties.';
      return res.json({ success: true, allSigned: true, message: completionMsg });
    }

    // Not the last signer — stamp in place, mark this signer signed, notify others.
    const mergedPath = doc.pdf_path + '.merged.pdf';
    execSync(`qpdf "${doc.pdf_path}" --overlay "${overlayPath}" -- "${mergedPath}"`);
    fs.renameSync(mergedPath, doc.pdf_path);
    fs.unlinkSync(overlayPath);

    if (signerIdx === 0) {
      db.prepare(`
        UPDATE documents SET recipient_completed_at = datetime('now'), ip_recipient = ?
        WHERE id = ?
      `).run(req.ip, doc.id);
    } else {
      extras[signerIdx - 1].signed_at = new Date().toISOString();
      extras[signerIdx - 1].ip = req.ip;
      db.prepare(`
        UPDATE documents SET extra_signers = ?
        WHERE id = ?
      `).run(JSON.stringify(extras), doc.id);
    }

    // Notify every OTHER signer who hasn't signed yet that this one just did.
    const stillUnsigned = signerStatus.filter(s => !s.signed && s.idx !== signerIdx);
    const totalSignedNow = signerStatus.filter(s => s.signed).length;
    for (const u of stillUnsigned) {
      const url = u.idx === 0
        ? `${BASE_URL}/sign/${doc.id}?role=recipient`
        : `${BASE_URL}/sign/${doc.id}?role=recipient&signer=${u.idx}`;
      try {
        await sendEmail(
          u.email,
          `${thisSignerName} just signed — your signature is still needed`,
          emailTemplates.coSignerSigned(u.name, thisSignerName, doc.sender_name, doc.title, url)
        );
      } catch (mailErr) {
        console.error(`Failed to notify ${u.email} that ${thisSignerName} signed:`, mailErr);
      }
    }

    res.json({
      success: true,
      allSigned: false,
      signedCount: totalSignedNow,
      totalSigners,
      remainingSigners: stillUnsigned.map(u => ({ name: u.name, idx: u.idx })),
      message: `Signature recorded. ${stillUnsigned.length === 1 ? `Waiting on ${stillUnsigned[0].name}` : `Waiting on ${stillUnsigned.length} more signer${stillUnsigned.length === 1 ? '' : 's'}`}.`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a document (owner only). Completed documents can be deleted too —
// the UI shows a stronger confirmation for those. Deletion is permanent and
// removes the underlying PDF files from disk.
app.delete('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.user_id && doc.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });

  // Delete associated PDF files
  try { if (doc.pdf_path && fs.existsSync(doc.pdf_path)) fs.unlinkSync(doc.pdf_path); } catch (e) { /* ignore */ }
  try { if (doc.final_pdf_path && fs.existsSync(doc.final_pdf_path)) fs.unlinkSync(doc.final_pdf_path); } catch (e) { /* ignore */ }

  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});


// Resend signing invitation / send manual reminder
app.post('/api/documents/:id/remind', requireAuth, async (req, res) => {
  try {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    if (doc.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
    if (doc.status !== 'awaiting_recipient') return res.status(400).json({ error: 'Document is not awaiting signature' });
    if (doc.expires_at && new Date(doc.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Document has expired' });
    }

    // Build the list of signers who haven't signed yet — remind all of them at once.
    // (Parallel signing means there's no single "next" signer.)
    const remindExtras = doc.extra_signers ? JSON.parse(doc.extra_signers) : [];
    const unsigned = [];
    if (!doc.recipient_completed_at) {
      unsigned.push({ idx: 0, name: doc.recipient_name, email: doc.recipient_email });
    }
    remindExtras.forEach((s, i) => {
      if (!s.signed_at) unsigned.push({ idx: i + 1, name: s.name, email: s.email });
    });

    if (unsigned.length === 0) {
      return res.status(400).json({ error: 'All signers have already signed' });
    }

    const daysSinceSent = Math.floor((Date.now() - new Date(doc.sender_completed_at).getTime()) / (1000 * 60 * 60 * 24));
    const expiresInDays = doc.expires_at ? Math.max(0, Math.ceil((new Date(doc.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : DOC_EXPIRY_DAYS;

    let sentCount = 0;
    for (const u of unsigned) {
      const signUrl = u.idx === 0
        ? `${BASE_URL}/sign/${doc.id}?role=recipient`
        : `${BASE_URL}/sign/${doc.id}?role=recipient&signer=${u.idx}`;
      try {
        await sendEmail(
          u.email,
          `Reminder: ${doc.sender_name} is waiting for your signature`,
          emailTemplates.signingReminder(doc.sender_name, doc.title, signUrl, daysSinceSent, expiresInDays)
        );
        sentCount++;
      } catch (e) {
        console.error(`Manual remind: failed to email ${u.email}:`, e);
      }
    }

    db.prepare("UPDATE documents SET last_reminder_at = datetime('now'), reminder_count = reminder_count + 1 WHERE id = ?").run(doc.id);

    const msg = sentCount === 1
      ? `Reminder sent to ${unsigned[0].email}`
      : `Reminders sent to ${sentCount} signer${sentCount === 1 ? '' : 's'}`;
    res.json({ success: true, message: msg });
  } catch (err) {
    console.error('Remind error:', err);
    res.status(500).json({ error: 'Failed to send reminder' });
  }
});

// --------------- Saved Templates ---------------

// List saved templates (scoped to current user)
app.get('/api/saved-templates', (req, res) => {
  const templates = db.prepare(
    'SELECT id, name, stage, template_name, doc_title, created_at, updated_at FROM saved_templates WHERE user_id = ? ORDER BY updated_at DESC'
  ).all(req.user.id);
  res.json(templates);
});

// Get single saved template (full data) — owner only
app.get('/api/saved-templates/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM saved_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  t.fields = JSON.parse(t.fields || '[]');
  t.sender_field_values = t.sender_field_values ? JSON.parse(t.sender_field_values) : null;
  res.json(t);
});

// Save a template — owned by current user
app.post('/api/saved-templates', (req, res) => {
  const { name, stage, templateName, uploadedPdfPath, fields, senderName, senderEmail, senderFieldValues, senderSignature, docTitle } = req.body;
  const id = uuidv4();

  // If using an uploaded PDF, copy it to templates/saved/ for persistence
  let savedPdfPath = null;
  if (uploadedPdfPath) {
    savedPdfPath = path.join(savedTemplatesDir, `${id}.pdf`);
    fs.copyFileSync(uploadedPdfPath, savedPdfPath);
  }

  db.prepare(`
    INSERT INTO saved_templates (id, user_id, name, stage, template_name, uploaded_pdf_path, fields, sender_name, sender_email, sender_field_values, sender_signature, doc_title)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.user.id, name, stage,
    templateName || null,
    savedPdfPath || null,
    JSON.stringify(fields || []),
    senderName || null, senderEmail || null,
    senderFieldValues ? JSON.stringify(senderFieldValues) : null,
    senderSignature || null,
    docTitle || null
  );

  res.json({ id, name, stage });
});

// Update a saved template — owner only
app.put('/api/saved-templates/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM saved_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  const { name, stage, senderName, senderEmail, senderFieldValues, senderSignature, docTitle, fields } = req.body;
  db.prepare(`
    UPDATE saved_templates SET
      name = COALESCE(?, name),
      stage = COALESCE(?, stage),
      sender_name = COALESCE(?, sender_name),
      sender_email = COALESCE(?, sender_email),
      sender_field_values = COALESCE(?, sender_field_values),
      sender_signature = COALESCE(?, sender_signature),
      doc_title = COALESCE(?, doc_title),
      fields = COALESCE(?, fields),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name || null, stage || null,
    senderName || null, senderEmail || null,
    senderFieldValues ? JSON.stringify(senderFieldValues) : null,
    senderSignature || null,
    docTitle || null,
    fields ? JSON.stringify(fields) : null,
    req.params.id
  );

  res.json({ success: true });
});

// Delete a saved template — owner only
app.delete('/api/saved-templates/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM saved_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  try { if (t.uploaded_pdf_path && fs.existsSync(t.uploaded_pdf_path)) fs.unlinkSync(t.uploaded_pdf_path); } catch (e) { /* ignore */ }
  db.prepare('DELETE FROM saved_templates WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// --------------- Admin Panel ---------------
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.admin) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

app.post('/api/admin/auth', (req, res) => {
  const { secret } = req.body || {};
  // If no ADMIN_SECRET is configured, allow open access
  if (ADMIN_SECRET && secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Invalid secret' });
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  const totalUsers   = db.prepare('SELECT COUNT(*) as n FROM users').get().n;
  const planCounts   = db.prepare('SELECT plan_type, COUNT(*) as n FROM users GROUP BY plan_type').all();
  const totalDocs    = db.prepare('SELECT COUNT(*) as n FROM documents').get().n;
  const docStatuses  = db.prepare('SELECT status, COUNT(*) as n FROM documents GROUP BY status').all();
  const newUsersMonth= db.prepare("SELECT COUNT(*) as n FROM users WHERE created_at >= date('now','start of month')").get().n;
  const docsMonth    = db.prepare("SELECT COUNT(*) as n FROM documents WHERE created_at >= date('now','start of month')").get().n;
  const revenue      = db.prepare('SELECT COALESCE(SUM(amount_cents),0) as t FROM billing_history').get().t;
  const revenueMonth = db.prepare("SELECT COALESCE(SUM(amount_cents),0) as t FROM billing_history WHERE created_at >= date('now','start of month')").get().t;
  const recentUsers  = db.prepare('SELECT id,name,email,plan_type,created_at FROM users ORDER BY created_at DESC LIMIT 8').all();
  const recentDocs   = db.prepare("SELECT d.id,d.title,d.status,d.created_at,u.name as user_name FROM documents d LEFT JOIN users u ON u.id=d.user_id ORDER BY d.created_at DESC LIMIT 8").all();
  res.json({ totalUsers, planCounts, totalDocs, docStatuses, newUsersMonth, docsMonth, revenue, revenueMonth, recentUsers, recentDocs });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const { search='', plan='all', sort='newest', page=1 } = req.query;
  const limit = 25, offset = (Number(page)-1)*limit;
  const conds = ['1=1'], params = [];
  if (search) { conds.push('(u.name LIKE ? OR u.email LIKE ?)'); params.push(`%${search}%`,`%${search}%`); }
  if (plan !== 'all') { conds.push('u.plan_type = ?'); params.push(plan); }
  const where = conds.join(' AND ');
  const orders = { newest:'u.created_at DESC', oldest:'u.created_at ASC', docs:'total_docs DESC', name:'u.name ASC', spent:'total_spent DESC' };
  const order = orders[sort] || 'u.created_at DESC';
  const users = db.prepare(`
    SELECT u.id,u.name,u.email,u.plan_type,u.documents_sent_this_month,u.created_at,u.stripe_subscription_id,
      COUNT(d.id) as total_docs,
      SUM(CASE WHEN d.status='completed' THEN 1 ELSE 0 END) as completed_docs,
      SUM(CASE WHEN d.status='awaiting_recipient' THEN 1 ELSE 0 END) as pending_docs,
      COALESCE((SELECT SUM(amount_cents) FROM billing_history WHERE user_id=u.id),0) as total_spent
    FROM users u LEFT JOIN documents d ON d.user_id=u.id
    WHERE ${where} GROUP BY u.id ORDER BY ${order} LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as n FROM users u WHERE ${where}`).get(...params).n;
  res.json({ users, total, page:Number(page), pages:Math.ceil(total/limit) });
});

app.get('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT id,name,email,plan_type,documents_sent_this_month,monthly_reset_date,created_at,company_name,stripe_customer_id,stripe_subscription_id FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const docs    = db.prepare('SELECT id,title,status,recipient_name,recipient_email,created_at,sender_completed_at,recipient_completed_at FROM documents WHERE user_id=? ORDER BY created_at DESC LIMIT 30').all(req.params.id);
  const billing = db.prepare('SELECT * FROM billing_history WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.params.id);
  const stats   = db.prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed, SUM(CASE WHEN status='awaiting_recipient' THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) as draft, SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) as expired FROM documents WHERE user_id=?`).get(req.params.id);
  res.json({ user, docs, billing, stats });
});

app.put('/api/admin/users/:id/plan', requireAdmin, (req, res) => {
  const { plan } = req.body || {};
  if (!['free','pay_per_doc','unlimited'].includes(plan)) return res.status(400).json({ error: 'Invalid plan' });
  db.prepare('UPDATE users SET plan_type=? WHERE id=?').run(plan, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (user) {
    const totalDocs  = db.prepare('SELECT COUNT(*) as n FROM documents WHERE user_id=?').get(req.params.id).n;
    const totalSpent = db.prepare('SELECT COALESCE(SUM(amount_cents),0) as t FROM billing_history WHERE user_id=?').get(req.params.id).t;
    db.prepare(`INSERT OR REPLACE INTO deleted_accounts (id,name,email,plan_type,company_name,total_docs,total_spent_cents,joined_at,deleted_by)
      VALUES (?,?,?,?,?,?,?,?,'admin')`).run(user.id, user.name, user.email, user.plan_type, user.company_name||null, totalDocs, totalSpent, user.created_at);
  }
  db.prepare('DELETE FROM billing_history WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM password_reset_tokens WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM documents WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/documents', requireAdmin, (req, res) => {
  const { status='all', search='', page=1 } = req.query;
  const limit = 25, offset = (Number(page)-1)*limit;
  const conds = ['1=1'], params = [];
  if (status !== 'all') { conds.push('d.status=?'); params.push(status); }
  if (search) { conds.push('(d.title LIKE ? OR d.sender_email LIKE ? OR d.recipient_email LIKE ?)'); params.push(`%${search}%`,`%${search}%`,`%${search}%`); }
  const where = conds.join(' AND ');
  const docs  = db.prepare(`SELECT d.id,d.title,d.status,d.sender_name,d.sender_email,d.recipient_name,d.recipient_email,d.created_at,d.recipient_completed_at,u.name as owner_name FROM documents d LEFT JOIN users u ON u.id=d.user_id WHERE ${where} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) as n FROM documents d WHERE ${where}`).get(...params).n;
  res.json({ docs, total, page:Number(page), pages:Math.ceil(total/limit) });
});

app.get('/api/admin/deleted-accounts', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM deleted_accounts ORDER BY deleted_at DESC').all();
  res.json({ rows });
});

app.get('/api/admin/billing', requireAdmin, (req, res) => {
  const { page=1 } = req.query;
  const limit = 25, offset = (Number(page)-1)*limit;
  const rows  = db.prepare('SELECT b.*,u.name as user_name,u.email as user_email FROM billing_history b LEFT JOIN users u ON u.id=b.user_id ORDER BY b.created_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) as n FROM billing_history').get().n;
  const sum   = db.prepare('SELECT COALESCE(SUM(amount_cents),0) as t FROM billing_history').get().t;
  res.json({ rows, total, sum, page:Number(page), pages:Math.ceil(total/limit) });
});

// --------------- Page Routes ---------------

// Login & register pages
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Contact page
app.get('/contact', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'contact.html'));
});

app.post('/api/contact', async (req, res) => {
  const { name, phone, email, message } = req.body || {};
  if (!name || !message) return res.status(400).json({ error: 'Name and message are required.' });

  const ownerEmail = process.env.CONTACT_EMAIL || process.env.FROM_EMAIL || process.env.SMTP_USER || '';
  if (!ownerEmail) {
    console.log('[CONTACT FORM]', { name, phone, email, message });
    return res.json({ ok: true });
  }

  const html = `
    <p><strong>Name:</strong> ${name}</p>
    <p><strong>Phone:</strong> ${phone || '—'}</p>
    <p><strong>Email:</strong> ${email || '—'}</p>
    <hr>
    <p>${message.replace(/\n/g, '<br>')}</p>
  `;

  try {
    await sendEmail(ownerEmail, `Contact form — ${name}`, html);
    res.json({ ok: true });
  } catch (err) {
    console.error('Contact email error:', err);
    res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
});

// Settings page
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// Billing page
app.get('/billing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'billing.html'));
});

// Public signing page — no auth required
app.get('/sign/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

// Dashboard page (authenticated only, served by client-side JS)
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Root: landing page for visitors, dashboard for logged-in users
// Auth check is lightweight — just verify the JWT from the Authorization header
// or a query param. Since we use localStorage JWTs (not cookies), the server
// can't read auth state on a plain GET. Instead, the landing page JS checks
// localStorage and redirects to /dashboard if a token exists.
app.get('/', (req, res) => {
  // Landing page is a self-unpacking bundle that needs permissive CSP
  // (creates blob: URLs for scripts and data: URLs for fonts at runtime)
  // Landing page is a self-unpacking bundle that creates blob: URLs for scripts,
  // data: URLs for fonts, and uses eval via Babel. Strip all restrictive CSP.
  res.setHeader('Content-Security-Policy', '');
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --------------- Daily Scheduled Tasks ---------------

async function runDailyTasks() {
  console.log(`[CRON] Running daily tasks at ${new Date().toISOString()}`);

  try {
    // 1. Reset monthly document counters
    resetMonthlyCounters();

    // 2. Mark expired documents
    const expiredDocs = db.prepare(`
      SELECT d.id, d.title, d.sender_name, d.sender_email, d.recipient_name, d.user_id
      FROM documents d
      WHERE d.status = 'awaiting_recipient'
        AND d.expires_at IS NOT NULL
        AND d.expires_at < datetime('now')
    `).all();

    for (const doc of expiredDocs) {
      db.prepare("UPDATE documents SET status = 'expired' WHERE id = ?").run(doc.id);
      console.log(`[CRON] Expired document: ${doc.id} (${doc.title})`);

      // Notify sender if they have notify_expired enabled
      if (doc.user_id) {
        const sender = db.prepare('SELECT notify_expired, email FROM users WHERE id = ?').get(doc.user_id);
        if (sender && sender.notify_expired) {
          sendEmail(
            doc.sender_email,
            `Document expired: ${doc.title}`,
            emailTemplates.documentExpiredSender(doc.sender_name, doc.recipient_name, doc.title)
          ).catch(e => console.error('[CRON] Expired notification error:', e));
        }
      }
    }
    if (expiredDocs.length > 0) console.log(`[CRON] Marked ${expiredDocs.length} document(s) as expired`);

    // 3. Send automatic reminders for documents at 3, 7, and 25 days
    const awaitingDocs = db.prepare(`
      SELECT d.id, d.title, d.sender_name, d.sender_email, d.recipient_name, d.recipient_email,
             d.sender_completed_at, d.expires_at, d.reminder_count, d.last_reminder_at,
             d.extra_signers, d.current_signer_index
      FROM documents d
      WHERE d.status = 'awaiting_recipient'
        AND d.sender_completed_at IS NOT NULL
    `).all();

    let remindersSent = 0;
    for (const doc of awaitingDocs) {
      const daysSinceSent = Math.floor((Date.now() - new Date(doc.sender_completed_at).getTime()) / (1000 * 60 * 60 * 24));
      const expiresInDays = doc.expires_at ? Math.max(0, Math.ceil((new Date(doc.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : DOC_EXPIRY_DAYS;

      // Check if we should send a reminder at this day threshold
      let shouldRemind = false;
      for (const threshold of REMINDER_DAYS) {
        if (daysSinceSent >= threshold && doc.reminder_count < REMINDER_DAYS.indexOf(threshold) + 1) {
          shouldRemind = true;
          break;
        }
      }

      // Don't send if we already reminded today
      if (shouldRemind && doc.last_reminder_at) {
        const lastReminder = new Date(doc.last_reminder_at);
        const hoursSinceLastReminder = (Date.now() - lastReminder.getTime()) / (1000 * 60 * 60);
        if (hoursSinceLastReminder < 20) shouldRemind = false;
      }

      if (shouldRemind) {
        // Fan out to every signer who hasn't signed yet (parallel signing).
        const cronExtras = doc.extra_signers ? (() => { try { return JSON.parse(doc.extra_signers); } catch (e) { return []; } })() : [];
        const cronUnsigned = [];
        if (!doc.recipient_completed_at) {
          cronUnsigned.push({ idx: 0, name: doc.recipient_name, email: doc.recipient_email });
        }
        cronExtras.forEach((s, i) => {
          if (!s.signed_at) cronUnsigned.push({ idx: i + 1, name: s.name, email: s.email });
        });
        if (cronUnsigned.length === 0) continue; // safety: shouldn't happen if status is awaiting_recipient

        let anySent = false;
        for (const u of cronUnsigned) {
          const signUrl = u.idx === 0
            ? `${BASE_URL}/sign/${doc.id}?role=recipient`
            : `${BASE_URL}/sign/${doc.id}?role=recipient&signer=${u.idx}`;
          try {
            await sendEmail(
              u.email,
              `Reminder: ${doc.sender_name} is waiting for your signature`,
              emailTemplates.signingReminder(doc.sender_name, doc.title, signUrl, daysSinceSent, expiresInDays)
            );
            anySent = true;
          } catch (e) {
            console.error(`[CRON] Reminder email error for doc ${doc.id} signer ${u.idx}:`, e);
          }
        }
        if (anySent) {
          db.prepare("UPDATE documents SET last_reminder_at = datetime('now'), reminder_count = reminder_count + 1 WHERE id = ?").run(doc.id);
          remindersSent++;
        }
      }
    }
    if (remindersSent > 0) console.log(`[CRON] Sent ${remindersSent} reminder(s)`);

    // 4. Clean up expired tokens
    db.prepare("DELETE FROM token_blacklist WHERE expires_at < datetime('now')").run();
    db.prepare("DELETE FROM password_reset_tokens WHERE expires_at < datetime('now')").run();

  } catch (err) {
    console.error('[CRON] Daily tasks error:', err);
  }
}

// Run daily tasks every 6 hours (catches any time zone edge cases)
setInterval(runDailyTasks, 6 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n  Penned running at ${BASE_URL}\n`);
  if (!config.resendApiKey && !config.smtp.auth.user) {
    console.log('  [!] Email not configured. Set RESEND_API_KEY or SMTP_USER/SMTP_PASS.\n');
  }
  // Run daily tasks on startup (after a short delay to let the server settle)
  setTimeout(runDailyTasks, 5000);
});
