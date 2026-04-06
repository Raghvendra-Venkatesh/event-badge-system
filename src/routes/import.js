// src/routes/import.js — CSV/Excel import + QR code generation
const express = require('express');
const router  = express.Router();
const XLSX    = require('xlsx');
const QRCode  = require('qrcode');
const db      = require('../db');

const VALID_TYPES = ['delegate','faculty','sponsor','stall','av','event team'];

function normaliseType(val) {
  const t = (val || 'delegate').toLowerCase().trim();
  return VALID_TYPES.includes(t) ? t : 'delegate';
}

async function generateQR(text) {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 200 });
}

// Read MAX badge number ONCE — callers increment in memory to avoid repeated DB hits
function getStartBadgeCounter() {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(badge_id,5) AS INTEGER)) as max FROM participants WHERE badge_id LIKE 'BDG-%'").get();
  return (row && row.max ? row.max : 0) + 1;
}

function getNextParticipantId() {
  const row = db.prepare('SELECT MAX(id) as max FROM participants').get();
  return (row && row.max ? row.max : 0) + 1;
}

function makeBadgeId(n) {
  return `BDG-${String(n).padStart(4, '0')}`;
}

// POST /api/import — multipart upload of CSV or XLSX
router.post('/', async (req, res) => {
  if (!req.files || !req.files.file) {
    return res.status(400).json({ error: 'No file uploaded. Field name must be "file".' });
  }

  const file = req.files.file;

  let rows;
  try {
    const workbook = XLSX.read(file.data, { type: 'buffer' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Could not parse file. Please use CSV or XLSX format.' });
  }

  if (!rows.length) {
    return res.status(400).json({ error: 'File is empty.' });
  }

  // Normalise column headers (case-insensitive)
  rows = rows.map(r => {
    const norm = {};
    for (const [k, v] of Object.entries(r)) {
      norm[k.toLowerCase().trim()] = v;
    }
    return norm;
  });

  // Keep importing all rows; allow missing ID/badge_id and fill automatically.
  const getValue = (row, aliases) => {
    const normalized = (key) => String(key || '').toLowerCase().trim();

    // exact field names first (using normalized keys already in parsed row)
    for (const key of aliases) {
      if (row[key] != null && String(row[key]).trim() !== '') {
        return String(row[key]).trim();
      }
    }

    // fuzzy fallback for common variations (e.g. 'PHONE', 'phone no', 'Mobile number')
    const candidate = Object.keys(row).find(k => {
      const kNorm = normalized(k);
      if (aliases.some(a => a.toLowerCase().includes('phone') || a.toLowerCase().includes('mobile'))) {
        return kNorm.includes('phone') || kNorm.includes('mobile') || kNorm.includes('contact');
      }
      if (aliases.some(a => a.toLowerCase().includes('company') || a.toLowerCase().includes('work'))) {
        return kNorm.includes('company') || kNorm.includes('place') || kNorm.includes('org');
      }
      if (aliases.some(a => a.toLowerCase().includes('tnmc'))) {
        return kNorm.includes('tnmc') || kNorm.includes('tmnc');
      }
      if (aliases.some(a => a.toLowerCase().includes('badge'))) {
        return kNorm.includes('badge');
      }
      if (aliases.some(a => a.toLowerCase().includes('type'))) {
        return kNorm.includes('type') || kNorm.includes('role');
      }
      return false;
    });

    if (candidate && row[candidate] != null && String(row[candidate]).trim() !== '') {
      return String(row[candidate]).trim();
    }

    return '';
  };

  let imported = 0;
  let skipped  = 0;

  // ── Step 1: Read MAX badge counter ONCE, then increment in-memory ─────────
  let badgeCounter = getStartBadgeCounter();

  // ── Step 2: Generate all badge IDs + QR codes BEFORE touching the DB ──────
  const pendingRows = [];
  let nextParticipantId = getNextParticipantId();

  for (const row of rows) {
    const idFromExcel    = getValue(row, ['id']);
    const badgeFromExcel = getValue(row, ['badge_id', 'badge id']);
    const name           = getValue(row, ['name', 'participant name']) || '';

    // Always import data; if not provided, auto-generate sequential ID and badge_id.
    const parsedId = idFromExcel ? parseInt(idFromExcel, 10) : null;
    const pId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : nextParticipantId++;
    const badge_id = badgeFromExcel || makeBadgeId(badgeCounter++);
    const email     = getValue(row, ['email']);
    const phone     = getValue(row, ['phone number', 'phone', 'mobile', 'contact number', 'mobile number', 'contact', 'telephone', 'cell', 'cell phone', 'phone no', 'mobile no']);
    const company   = getValue(row, ['company', 'place of work', 'organisation', 'organization', 'workplace']);
    const tnmc_no   = getValue(row, ['tnmc no', 'tnmc_no', 'tnmc number', 'tnmc']);
    const typeRaw   = getValue(row, ['participant type', 'type', 'role']);
    const type      = normaliseType(typeRaw);
    const qr_base64 = await generateQR(badge_id);

    pendingRows.push({ id: pId, badge_id, name, email, phone, type, company, tnmc_no, qr_base64 });
  }

  // ── Step 3: Insert ALL rows in ONE transaction (prevents disk I/O errors) ──
  const insert = db.prepare(`
    INSERT INTO participants(id, badge_id, name, email, phone, type, company, tnmc_no, qr_base64)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      badge_id = excluded.badge_id,
      name = excluded.name,
      email = excluded.email,
      phone = excluded.phone,
      type = excluded.type,
      company = excluded.company,
      tnmc_no = excluded.tnmc_no
  `);

  try {
    db.exec('BEGIN');
    for (const p of pendingRows) {
      const info = insert.run(p.id, p.badge_id, p.name, p.email, p.phone, p.type, p.company, p.tnmc_no, p.qr_base64);
      if (info.changes > 0) imported++;
      else skipped++;
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('Import transaction failed:', e.message);
    return res.status(500).json({ error: 'Database error during import. Please try again.' });
  }

  // Broadcast update
  if (req.app.broadcast) {
    req.app.broadcast({ type: 'import_complete', imported });
  }

  res.json({
    success: true,
    imported,
    skipped: 0,
    errors: [],
    message: `Imported ${imported} participants.`
  });
});

// GET /api/import/template — download XLSX template with 100 sample rows
router.get('/template', (req, res) => {
  const firstNames = [
    'Aarav','Ananya','Arjun','Aisha','Bhavna','Chandan','Deepa','Dhruv','Esha','Farhan',
    'Gayatri','Harsh','Ishaan','Jaya','Kabir','Lakshmi','Manav','Nisha','Om','Priya',
    'Rahul','Sanya','Tarun','Uma','Vikram','Waqar','Yogesh','Zara','Aditya','Bharat',
    'Chitra','Dinesh','Ekta','Firoz','Geeta','Hemant','Ira','Jai','Kiran','Lata',
    'Mohan','Neha','Ojas','Puja','Rajan','Savita','Tejas','Urmila','Varun','Swati'
  ];
  const lastNames = [
    'Sharma','Verma','Patel','Singh','Kumar','Nair','Mehta','Das','Rao','Iyer',
    'Gupta','Joshi','Malhotra','Chauhan','Shah','Bose','Kapoor','Reddy','Pillai','Khanna',
    'Saxena','Mishra','Dubey','Srivastava','Thakur','Menon','Pandey','Chatterjee','Bhat','Agarwal'
  ];
  const companies = [
    'Techmen Solutions','InnovateTech','GlobalSoft','NextGen Systems','CloudBase India',
    'DataDriven Co','AlphaCorp','ByteWave','NeuralNet Ltd','PixelForge',
    'IIT Madras','NIT Trichy','Anna University','VIT Vellore','BITS Pilani',
    'Acme Enterprises','Synapse Labs','Quantum Works','Zenith Digital','FusionMind',
    'Freelancer','Startup Hub','EduTech India','MedTech Pvt Ltd','FinServ Group'
  ];
  const types   = ['delegate','faculty','sponsor','stall','av','event team'];
  const domains = ['gmail.com','yahoo.com','outlook.com','techmen.in','example.org','hotmail.com'];

  const rows = [];
  rows.push({
    'id': '',
    'badge id': '',
    'name': '',
    'participant type': '',
    'place of work': '',
    'tnmc number': '',
    'email': '',
    'phone number': ''
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 10 }, { wch: 28 }, { wch: 28 }, { wch: 18 }, { wch: 36 }, { wch: 18 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Participants');

  const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="import_template.xlsx"');
  res.send(xlsxBuffer);
});

module.exports = router;
