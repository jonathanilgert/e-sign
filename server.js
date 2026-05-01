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

// Ensure saved templates directory exists
const savedTemplatesDir = path.join(__dirname, 'templates', 'saved');
if (!fs.existsSync(savedTemplatesDir)) fs.mkdirSync(savedTemplatesDir, { recursive: true });

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
        const userId = session.metadata?.user_id;
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
  if (req.path.startsWith('/api/webhooks/')) return next();
  if (req.path.startsWith('/api/auth/')) return next();

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
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.06)">

<!-- Header -->
<tr><td style="background:#1a1a2e;padding:24px 32px">
  <span style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.5px">Penned</span>
</td></tr>

<!-- Body -->
<tr><td style="padding:32px 32px 24px">
${content}
</td></tr>

<!-- Footer -->
<tr><td style="padding:20px 32px 28px;border-top:1px solid #e5e7eb">
  <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6">
    Sent by Penned${config.fromEmail ? ' &middot; ' + config.fromEmail : ''}
  </p>
  ${options.hideUnsubscribe ? '' : `<p style="margin:6px 0 0;font-size:12px;color:#9ca3af">
    <a href="${settingsUrl}" style="color:#6b7280;text-decoration:underline">Email preferences</a>
  </p>`}
  <p style="margin:6px 0 0;font-size:11px;color:#d1d5db">&copy; ${year} Penned</p>
</td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function emailButton(text, url) {
  return `<table cellpadding="0" cellspacing="0" style="margin:24px 0"><tr><td>
  <a href="${url}" style="display:inline-block;background:#4361ee;color:#ffffff;padding:14px 36px;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;font-family:inherit">${text}</a>
</td></tr></table>`;
}

const emailTemplates = {

  welcome(name) {
    return emailLayout(`
      <h2 style="margin:0 0 8px;font-size:22px;color:#1a1a2e">Welcome to Penned</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6">Hi ${name},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6">
        Your account is ready. Penned lets you send documents for signature in minutes &mdash; no printing, scanning, or mailing.
      </p>
      <p style="margin:0 0 4px;font-size:15px;color:#374151;line-height:1.6">Here's how to get started:</p>
      <ol style="margin:8px 0 20px;padding-left:20px;font-size:14px;color:#374151;line-height:1.8">
        <li>Upload a PDF or choose a template</li>
        <li>Place signature and text fields</li>
        <li>Send &mdash; your recipient signs from any device</li>
      </ol>
      ${emailButton('Go to Dashboard', BASE_URL + '/dashboard')}
      <p style="margin:0;font-size:13px;color:#9ca3af">You have 3 free documents per month on your current plan.</p>
    `);
  },

  signingInvitation(senderName, docTitle, signUrl) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1a1a2e">${senderName} sent you a document to sign</h2>
      <p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6">
        You've been asked to review and sign the following document:
      </p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin:16px 0">
        <p style="margin:0;font-size:16px;font-weight:600;color:#1a1a2e">${docTitle}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#6b7280">From: ${senderName}</p>
      </div>
      ${emailButton('Review & Sign Document', signUrl)}
      <p style="margin:0 0 6px;font-size:13px;color:#9ca3af">This is a secure signing link. Only use it if you were expecting this document.</p>
      <p style="margin:0;font-size:13px;color:#9ca3af">If you weren't expecting this, you can safely ignore this email.</p>
    `, { hideUnsubscribe: true });
  },

  documentSigned(senderName, recipientName, docTitle) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1a1a2e">Document Signed</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6">
        Hi ${senderName},
      </p>
      <p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6">
        <strong>${recipientName}</strong> has signed <strong>${docTitle}</strong>.
      </p>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">
        Both parties have now completed the document. A copy of the fully executed PDF is attached to this email.
      </p>
      ${emailButton('View in Dashboard', BASE_URL + '/dashboard')}
    `);
  },

  documentCompleteRecipient(recipientName, docTitle) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1a1a2e">Document Complete</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6">
        Hi ${recipientName},
      </p>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">
        <strong>${docTitle}</strong> has been fully signed by both parties. A copy of the executed document is attached for your records.
      </p>
      <p style="margin:0;font-size:13px;color:#9ca3af">This document was digitally signed via Penned. Both parties attested that this electronic signature is legally binding.</p>
    `, { hideUnsubscribe: true });
  },

  passwordReset(name, resetUrl) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1a1a2e">Reset Your Password</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6">Hi ${name},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">
        We received a request to reset your password. Click the button below to choose a new one:
      </p>
      ${emailButton('Reset Password', resetUrl)}
      <p style="margin:0 0 6px;font-size:13px;color:#9ca3af">This link expires in 1 hour.</p>
      <p style="margin:0;font-size:13px;color:#9ca3af">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
    `);
  },

  signingReminder(senderName, docTitle, signUrl, daysWaiting, expiresInDays) {
    const urgency = expiresInDays <= 5
      ? `<p style="margin:0 0 16px;font-size:14px;color:#dc2626;font-weight:500">This document expires in ${expiresInDays} day${expiresInDays === 1 ? '' : 's'}.</p>`
      : '';
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1a1a2e">Reminder: Document awaiting your signature</h2>
      <p style="margin:0 0 8px;font-size:15px;color:#374151;line-height:1.6">
        ${senderName} sent you a document ${daysWaiting} day${daysWaiting === 1 ? '' : 's'} ago that still needs your signature:
      </p>
      <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 20px;margin:16px 0">
        <p style="margin:0;font-size:16px;font-weight:600;color:#1a1a2e">${docTitle}</p>
        <p style="margin:4px 0 0;font-size:13px;color:#6b7280">From: ${senderName}</p>
      </div>
      ${urgency}
      ${emailButton('Review & Sign Document', signUrl)}
      <p style="margin:0;font-size:13px;color:#9ca3af">If you've already signed this document, please disregard this reminder.</p>
    `, { hideUnsubscribe: true });
  },

  documentExpiredSender(senderName, recipientName, docTitle) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1a1a2e">Document Expired</h2>
      <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6">Hi ${senderName},</p>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">
        <strong>${docTitle}</strong> sent to ${recipientName} has expired after ${DOC_EXPIRY_DAYS} days without being signed.
      </p>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">
        You can create a new document and resend it from your dashboard.
      </p>
      ${emailButton('Go to Dashboard', BASE_URL + '/dashboard')}
    `);
  },

  paymentReceipt(name, amount, description, date) {
    return emailLayout(`
      <h2 style="margin:0 0 16px;font-size:22px;color:#1a1a2e">Payment Receipt</h2>
      <p style="margin:0 0 20px;font-size:15px;color:#374151;line-height:1.6">Hi ${name},</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;margin:0 0 24px;font-size:14px;color:#374151">
        <tr><td style="padding:14px 20px;border-bottom:1px solid #e5e7eb"><strong>Description</strong></td><td style="padding:14px 20px;border-bottom:1px solid #e5e7eb;text-align:right">${description}</td></tr>
        <tr><td style="padding:14px 20px;border-bottom:1px solid #e5e7eb"><strong>Amount</strong></td><td style="padding:14px 20px;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:700;font-size:16px">${amount}</td></tr>
        <tr><td style="padding:14px 20px"><strong>Date</strong></td><td style="padding:14px 20px;text-align:right">${date}</td></tr>
      </table>
      <p style="margin:0;font-size:13px;color:#9ca3af">If you have questions about this charge, visit your <a href="${BASE_URL}/settings#account" style="color:#4361ee;text-decoration:underline">billing settings</a>.</p>
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
  // Skip auth for auth routes, webhooks, and CSRF token endpoint
  if (req.path.startsWith('/auth/')) return next();
  if (req.path.startsWith('/webhooks/')) return next();
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

// Serve user-saved template PDFs (per-user; ownership enforced below).
app.get('/api/saved-template-pdf/:id', (req, res) => {
  const t = db.prepare('SELECT user_id, uploaded_pdf_path FROM saved_templates WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  if (!t.uploaded_pdf_path || !fs.existsSync(t.uploaded_pdf_path)) return res.status(404).json({ error: 'PDF missing' });
  res.sendFile(path.resolve(t.uploaded_pdf_path));
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
app.post('/api/billing/create-checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured' });
  if (!STRIPE_PRICE_ID_UNLIMITED) return res.status(500).json({ error: 'Unlimited plan price not configured' });

  try {
    const user = db.prepare('SELECT id, email, name, stripe_customer_id FROM users WHERE id = ?').get(req.user.id);

    // Create or reuse Stripe customer
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
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID_UNLIMITED, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${BASE_URL}/dashboard?billing=unlimited_success`,
      cancel_url: `${BASE_URL}/dashboard?billing=cancelled`,
      metadata: { user_id: user.id, type: 'unlimited' }
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
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
  const { pdfSource, templateName, libraryItemId, savedTemplatePdf, fields } = req.body;

  // Validate inputs
  if (title.length > 300) return res.status(400).json({ error: 'Title is too long' });
  if (senderName.length > 100 || recipientName.length > 100) return res.status(400).json({ error: 'Name is too long' });
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (senderEmail && !emailRegex.test(senderEmail)) return res.status(400).json({ error: 'Invalid sender email' });
  if (recipientEmail && !emailRegex.test(recipientEmail)) return res.status(400).json({ error: 'Invalid recipient email' });

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
  if (libraryItemId) {
    const item = libraryItemsById[libraryItemId];
    if (!item) return res.status(400).json({ error: 'Unknown library template' });
    const src = path.join(libraryDir, item.file);
    if (!fs.existsSync(src)) return res.status(400).json({ error: 'Library PDF missing' });
    pdfPath = path.join(__dirname, 'uploads', `${id}.pdf`);
    fs.copyFileSync(src, pdfPath);
  } else if (templateName) {
    // Backwards-compat: only allowed for files inside templates/saved/ (per-user)
    const src = path.join(__dirname, 'templates', 'saved', path.basename(templateName));
    if (!fs.existsSync(src)) return res.status(400).json({ error: 'Template not found' });
    pdfPath = path.join(__dirname, 'uploads', `${id}.pdf`);
    fs.copyFileSync(src, pdfPath);
  } else if (savedTemplatePdf) {
    pdfPath = path.join(__dirname, 'uploads', `${id}.pdf`);
    fs.copyFileSync(savedTemplatePdf, pdfPath);
  } else if (pdfSource) {
    pdfPath = pdfSource;
  } else {
    return res.status(400).json({ error: 'No PDF source provided' });
  }

  db.prepare(`
    INSERT INTO documents (id, title, pdf_path, sender_name, sender_email, recipient_name, recipient_email, fields, template_name, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title || 'Untitled Document', pdfPath, senderName, senderEmail, recipientName, recipientEmail, JSON.stringify(fields || []), templateName || null, userId);

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
  const docs = db.prepare('SELECT id, title, status, sender_name, recipient_name, recipient_email, created_at, sender_completed_at, recipient_completed_at, expires_at, reminder_count FROM documents WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
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

    // Attestation footer
    const lastPage = overlay.getPage(overlay.getPageCount() - 1);
    const attestText = `Digitally signed by ${doc.sender_name} on ${new Date().toISOString()} | IP: ${req.ip}`;
    lastPage.drawText(attestText, { x: 30, y: 20, size: 7, font, color: rgb(0.4, 0.4, 0.4) });

    // Save overlay and merge with original using qpdf
    const overlayPath = doc.pdf_path + '.overlay.pdf';
    const mergedPath = doc.pdf_path + '.merged.pdf';
    fs.writeFileSync(overlayPath, await overlay.save());
    execSync(`qpdf "${doc.pdf_path}" --overlay "${overlayPath}" -- "${mergedPath}"`);
    fs.renameSync(mergedPath, doc.pdf_path);
    fs.unlinkSync(overlayPath);

    // Update DB — set expiration to 30 days from now
    const expiresAt = new Date(Date.now() + DOC_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(`
      UPDATE documents SET status = 'awaiting_recipient', sender_completed_at = datetime('now'), ip_sender = ?, fields = ?, expires_at = ?
      WHERE id = ?
    `).run(req.ip, JSON.stringify(fields), expiresAt, doc.id);

    // Email recipient
    const signUrl = `${BASE_URL}/sign/${doc.id}?role=recipient`;
    await sendEmail(
      doc.recipient_email,
      `${doc.sender_name} sent you a document to sign`,
      emailTemplates.signingInvitation(doc.sender_name, doc.title, signUrl)
    );

    res.json({ success: true, message: 'Document sent to recipient for signing' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Submit recipient's fields and signature, generate final PDF, email both parties
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

    const { fieldValues, signatureDataUrl, attestation } = req.body;
    if (!attestation) return res.status(400).json({ error: 'Attestation required' });

    // Build overlay PDF with recipient fields, then stamp onto original
    const pdfBytes = fs.readFileSync(doc.pdf_path);
    const origPdf = await PDFDocument.load(pdfBytes);
    const overlay = await PDFDocument.create();
    const font = await overlay.embedFont(StandardFonts.Helvetica);

    for (let i = 0; i < origPdf.getPageCount(); i++) {
      const p = origPdf.getPage(i);
      overlay.addPage([p.getWidth(), p.getHeight()]);
    }

    const fields = JSON.parse(doc.fields || '[]');
    console.log('[RECIPIENT SIGN] fieldValues:', JSON.stringify(fieldValues));
    console.log('[RECIPIENT SIGN] has signature:', !!signatureDataUrl);
    for (const field of fields) {
      if (field.role !== 'recipient') continue;
      const page = overlay.getPage(field.page);
      if (field.type === 'signature') {
        if (!signatureDataUrl) continue;
        const sigBytes = Buffer.from(signatureDataUrl.split(',')[1], 'base64');
        const sigImage = await overlay.embedPng(sigBytes);
        const dims = sigImage.scale(Math.min(field.width / sigImage.width, field.height / sigImage.height));
        page.drawImage(sigImage, { x: field.x, y: field.y, width: dims.width, height: dims.height });
        console.log('[RECIPIENT SIGN] Drew signature at', field.x, field.y);
      } else if (fieldValues[field.id]) {
        drawFieldText(page, font, fieldValues[field.id], field);
        console.log('[RECIPIENT SIGN] Drew text "' + fieldValues[field.id] + '" in field at', field.x, field.y, 'w:', field.width, 'h:', field.height);
      }
    }

    // Attestation footer
    const lastPage = overlay.getPage(overlay.getPageCount() - 1);
    const attestText = `Digitally signed by ${doc.recipient_name} on ${new Date().toISOString()} | IP: ${req.ip}`;
    lastPage.drawText(attestText, { x: 30, y: 10, size: 7, font, color: rgb(0.4, 0.4, 0.4) });

    // Save overlay and merge with original using qpdf
    const overlayPath = doc.pdf_path + '.overlay.pdf';
    const finalPath = path.join(__dirname, 'signed', `${doc.id}-final.pdf`);
    fs.writeFileSync(overlayPath, await overlay.save());
    execSync(`qpdf "${doc.pdf_path}" --overlay "${overlayPath}" -- "${finalPath}"`);
    fs.unlinkSync(overlayPath);

    // Update DB
    db.prepare(`
      UPDATE documents SET status = 'completed', recipient_completed_at = datetime('now'), ip_recipient = ?, final_pdf_path = ?
      WHERE id = ?
    `).run(req.ip, finalPath, doc.id);

    // Email both parties the completed document
    const attachment = { filename: `${doc.title} - Signed.pdf`, path: finalPath };

    await sendEmail(
      doc.sender_email,
      `Signed: ${doc.title}`,
      emailTemplates.documentSigned(doc.sender_name, doc.recipient_name, doc.title),
      [attachment]
    );

    await sendEmail(
      doc.recipient_email,
      `Signed: ${doc.title}`,
      emailTemplates.documentCompleteRecipient(doc.recipient_name, doc.title),
      [attachment]
    );

    res.json({ success: true, message: 'Document fully executed. Copies sent to both parties.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a document (owner only, not if completed)
app.delete('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.user_id && doc.user_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
  if (doc.status === 'completed') return res.status(400).json({ error: 'Completed documents cannot be deleted' });

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

    const signUrl = `${BASE_URL}/sign/${doc.id}?role=recipient`;
    const daysSinceSent = Math.floor((Date.now() - new Date(doc.sender_completed_at).getTime()) / (1000 * 60 * 60 * 24));
    const expiresInDays = doc.expires_at ? Math.max(0, Math.ceil((new Date(doc.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24))) : DOC_EXPIRY_DAYS;

    await sendEmail(
      doc.recipient_email,
      `Reminder: ${doc.sender_name} is waiting for your signature`,
      emailTemplates.signingReminder(doc.sender_name, doc.title, signUrl, daysSinceSent, expiresInDays)
    );

    db.prepare("UPDATE documents SET last_reminder_at = datetime('now'), reminder_count = reminder_count + 1 WHERE id = ?").run(doc.id);

    res.json({ success: true, message: `Reminder sent to ${doc.recipient_email}` });
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

// Settings page
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
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
             d.sender_completed_at, d.expires_at, d.reminder_count, d.last_reminder_at
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
        const signUrl = `${BASE_URL}/sign/${doc.id}?role=recipient`;
        try {
          await sendEmail(
            doc.recipient_email,
            `Reminder: ${doc.sender_name} is waiting for your signature`,
            emailTemplates.signingReminder(doc.sender_name, doc.title, signUrl, daysSinceSent, expiresInDays)
          );
          db.prepare("UPDATE documents SET last_reminder_at = datetime('now'), reminder_count = reminder_count + 1 WHERE id = ?").run(doc.id);
          remindersSent++;
        } catch (e) {
          console.error(`[CRON] Reminder email error for doc ${doc.id}:`, e);
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
