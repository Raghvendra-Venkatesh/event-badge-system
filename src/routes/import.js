// src/routes/import.js — CSV/Excel import + QR code generation
const express = require('express');
const router  = express.Router();
const QRCode  = require('qrcode');
const db      = require('../db');
const { parseParticipantRows, createImportTemplate } = require('../services/participantSpreadsheet');

const VALID_TYPES = ['delegate','faculty','sponsor','stall','av','event team'];

function normaliseType(val) {
  const t = (val || 'delegate').toLowerCase().trim();
  return VALID_TYPES.includes(t) ? t : 'delegate';
}

async function generateQR(text) {
  return QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 200 });
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
    rows = await parseParticipantRows(file.data, file.name);
  } catch {
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

  // ── Step 1: Reserve unique badge numbers before generating QR codes. ───────
  const pendingRows = [];
  let generatedBadgeCount = 0;

  for (const row of rows) {
    const idFromExcel    = getValue(row, ['id']);
    const badgeFromExcel = getValue(row, ['badge_id', 'badge id']);
    const name           = getValue(row, ['name', 'participant name']) || '';

    // Always import data; if not provided, auto-generate sequential ID and badge_id.
    const parsedId = idFromExcel ? parseInt(idFromExcel, 10) : null;
    const pId = Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;
    const badge_id = badgeFromExcel || null;
    const email     = getValue(row, ['email']);
    const phone     = getValue(row, ['phone number', 'phone', 'mobile', 'contact number', 'mobile number', 'contact', 'telephone', 'cell', 'cell phone', 'phone no', 'mobile no']);
    const company   = getValue(row, ['company', 'place of work', 'organisation', 'organization', 'workplace']);
    const tnmc_no   = getValue(row, ['tnmc no', 'tnmc_no', 'tnmc number', 'tnmc']);
    const typeRaw   = getValue(row, ['participant type', 'type', 'role']);
    const type      = normaliseType(typeRaw);
    if (!badge_id) generatedBadgeCount++;
    pendingRows.push({ id: pId, badge_id, name, email, phone, type, company, tnmc_no });
  }

  try {
    const badgeNumbers = generatedBadgeCount
      ? await db.query(
          'SELECT nextval(\'participant_badge_counter_seq\') AS value FROM generate_series(1, ?) ORDER BY value',
          [generatedBadgeCount]
        )
      : { rows: [] };
    let badgeNumberIndex = 0;
    for (const participant of pendingRows) {
      if (!participant.badge_id) {
        participant.badge_id = makeBadgeId(Number(badgeNumbers.rows[badgeNumberIndex++].value));
      }
      participant.qr_base64 = await generateQR(participant.badge_id);
    }

    // Insert the entire import in one transaction.
    await db.transaction(async tx => {
      await tx.query('LOCK TABLE participants IN SHARE ROW EXCLUSIVE MODE');
      for (const p of pendingRows) {
        const parameters = [p.badge_id, p.name, p.email, p.phone, p.type, p.company, p.tnmc_no, p.qr_base64];
        const sql = p.id === null
          ? `INSERT INTO participants(badge_id, name, email, phone, type, company, tnmc_no, qr_base64)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(badge_id) DO UPDATE SET
               name=EXCLUDED.name, email=EXCLUDED.email, phone=EXCLUDED.phone, type=EXCLUDED.type,
               company=EXCLUDED.company, tnmc_no=EXCLUDED.tnmc_no, qr_base64=EXCLUDED.qr_base64,
               archived_at=NULL`
          : `INSERT INTO participants(id, badge_id, name, email, phone, type, company, tnmc_no, qr_base64)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               badge_id=EXCLUDED.badge_id, name=EXCLUDED.name, email=EXCLUDED.email, phone=EXCLUDED.phone,
               type=EXCLUDED.type, company=EXCLUDED.company, tnmc_no=EXCLUDED.tnmc_no,
               qr_base64=EXCLUDED.qr_base64, archived_at=NULL`;
        const values = p.id === null ? parameters : [p.id, ...parameters];
        await tx.query(sql, values);
        imported++;
      }
      await tx.query(`
        SELECT setval(
          pg_get_serial_sequence('participants', 'id'),
          GREATEST(COALESCE((SELECT MAX(id) FROM participants), 1), 1),
          EXISTS (SELECT 1 FROM participants)
        )
      `);
      const badgeMax = await tx.query(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(badge_id FROM 5) AS INTEGER)), 0) AS max FROM participants WHERE badge_id ~ '^BDG-[0-9]+$'"
      );
      const sequence = await tx.query("SELECT last_value, is_called FROM participant_badge_counter_seq");
      const maxBadge = Number(badgeMax.rows[0].max);
      if (maxBadge > 0 && (!sequence.rows[0].is_called || Number(sequence.rows[0].last_value) < maxBadge)) {
        await tx.query("SELECT setval('participant_badge_counter_seq', ?, true)", [maxBadge]);
      }
    });
  } catch (e) {
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

// GET /api/import/template — download XLSX template
router.get('/template', async (req, res, next) => {
  try {
    const xlsxBuffer = await createImportTemplate();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="import_template.xlsx"');
    res.send(xlsxBuffer);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
