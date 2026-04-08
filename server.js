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

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --------------- Config ---------------
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
  fromName: process.env.FROM_NAME || 'E-Sign'
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

// --------------- Middleware ---------------
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
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

// --------------- Helpers ---------------

// Auto-fit text into a field: shrink font size until it fits, return size + width
function fitText(font, text, maxWidth, maxFontSize) {
  let size = maxFontSize;
  const minSize = 6;
  while (size > minSize) {
    const width = font.widthOfTextAtSize(text, size);
    if (width <= maxWidth - 4) break; // 4pt padding
    size -= 0.5;
  }
  const textWidth = font.widthOfTextAtSize(text, size);
  return { size, textWidth };
}

// --------------- API Routes ---------------

// List templates
app.get('/api/templates', (req, res) => {
  const dir = path.join(__dirname, 'templates');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
  res.json(files.map(f => ({ name: f, path: `/api/templates/${encodeURIComponent(f)}` })));
});

// Serve template PDF
app.get('/api/templates/:name', (req, res) => {
  const filePath = path.join(__dirname, 'templates', req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// Upload a new PDF
app.post('/api/upload', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const newPath = req.file.path + '.pdf';
  fs.renameSync(req.file.path, newPath);
  res.json({ path: newPath, filename: req.file.originalname });
});

// Create a new document for signing
app.post('/api/documents', (req, res) => {
  const { title, pdfSource, templateName, senderName, senderEmail, recipientName, recipientEmail, fields } = req.body;
  const id = uuidv4();

  let pdfPath;
  if (templateName) {
    const src = path.join(__dirname, 'templates', templateName);
    pdfPath = path.join(__dirname, 'uploads', `${id}.pdf`);
    fs.copyFileSync(src, pdfPath);
  } else if (pdfSource) {
    pdfPath = pdfSource;
  } else {
    return res.status(400).json({ error: 'No PDF source provided' });
  }

  db.prepare(`
    INSERT INTO documents (id, title, pdf_path, sender_name, sender_email, recipient_name, recipient_email, fields)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title || 'Untitled Document', pdfPath, senderName, senderEmail, recipientName, recipientEmail, JSON.stringify(fields || []));

  res.json({ id, url: `${BASE_URL}/sign/${id}?role=sender` });
});

// Get document info
app.get('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
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

    const { fieldValues, signatureDataUrl, attestation } = req.body;
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
        const maxSize = field.fontSize || 11;
        const { size: fittedSize, textWidth } = fitText(font, fieldValues[field.id], field.width, maxSize);
        // Center text horizontally within the field so it appears near where the user clicked
        const textX = field.x + (field.width - textWidth) / 2;
        page.drawText(fieldValues[field.id], {
          x: textX, y: field.y + 4,
          size: fittedSize, font, color: rgb(0, 0, 0.4)
        });
        console.log('[SENDER SIGN] Drew text "' + fieldValues[field.id] + '" at', textX, field.y, 'size:', fittedSize);
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

    // Update DB
    db.prepare(`
      UPDATE documents SET status = 'awaiting_recipient', sender_completed_at = datetime('now'), ip_sender = ?, fields = ?
      WHERE id = ?
    `).run(req.ip, JSON.stringify(fields), doc.id);

    // Email recipient
    const signUrl = `${BASE_URL}/sign/${doc.id}?role=recipient`;
    await sendEmail(
      doc.recipient_email,
      `Document for your signature: ${doc.title}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#1a1a2e">Document Ready for Your Signature</h2>
        <p>${doc.sender_name} has sent you a document to review and sign:</p>
        <p style="font-weight:bold;font-size:16px">${doc.title}</p>
        <a href="${signUrl}" style="display:inline-block;background:#1a1a2e;color:white;padding:12px 30px;text-decoration:none;border-radius:6px;margin:20px 0">Review & Sign Document</a>
        <p style="color:#666;font-size:12px">This is a secure signing link. Do not share it with others.</p>
      </div>`
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
    if (doc.status !== 'awaiting_recipient') return res.status(400).json({ error: 'Document not ready for recipient signing' });

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
        const maxSize = field.fontSize || 11;
        const { size: fittedSize, textWidth } = fitText(font, fieldValues[field.id], field.width, maxSize);
        // Center text horizontally within the field so it appears near where the user clicked
        const textX = field.x + (field.width - textWidth) / 2;
        page.drawText(fieldValues[field.id], {
          x: textX, y: field.y + 4,
          size: fittedSize, font, color: rgb(0, 0, 0.4)
        });
        console.log('[RECIPIENT SIGN] Drew text "' + fieldValues[field.id] + '" at', textX, field.y, 'size:', fittedSize);
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
      `Fully Executed: ${doc.title}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#1a1a2e">Document Fully Executed</h2>
        <p>Both parties have signed <strong>${doc.title}</strong>.</p>
        <p>${doc.recipient_name} completed their signature on ${new Date().toLocaleString()}.</p>
        <p>A copy of the fully executed document is attached for your records.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#666;font-size:12px">This document was digitally signed via E-Sign. Both parties attested that this digital copy is binding as if completed in person.</p>
      </div>`,
      [attachment]
    );

    await sendEmail(
      doc.recipient_email,
      `Fully Executed: ${doc.title}`,
      `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
        <h2 style="color:#1a1a2e">Document Fully Executed</h2>
        <p>Both parties have signed <strong>${doc.title}</strong>.</p>
        <p>A copy of the fully executed document is attached for your records.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
        <p style="color:#666;font-size:12px">This document was digitally signed via E-Sign. Both parties attested that this digital copy is binding as if completed in person.</p>
      </div>`,
      [attachment]
    );

    res.json({ success: true, message: 'Document fully executed. Copies sent to both parties.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Delete a document
app.delete('/api/documents/:id', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });

  // Delete associated PDF files
  try { if (doc.pdf_path && fs.existsSync(doc.pdf_path)) fs.unlinkSync(doc.pdf_path); } catch (e) { /* ignore */ }
  try { if (doc.final_pdf_path && fs.existsSync(doc.final_pdf_path)) fs.unlinkSync(doc.final_pdf_path); } catch (e) { /* ignore */ }

  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// List all documents
app.get('/api/documents', (req, res) => {
  const docs = db.prepare('SELECT id, title, status, sender_name, recipient_name, created_at, sender_completed_at, recipient_completed_at FROM documents ORDER BY created_at DESC').all();
  res.json(docs);
});

// --------------- Page Routes ---------------
app.get('/sign/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sign.html'));
});

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  E-Sign running at ${BASE_URL}\n`);
  if (!config.smtp.auth.user) {
    console.log('  [!] Email not configured. Set SMTP_USER and SMTP_PASS environment variables.');
    console.log('      For Gmail: SMTP_USER=you@gmail.com SMTP_PASS=your-app-password\n');
  }
});
