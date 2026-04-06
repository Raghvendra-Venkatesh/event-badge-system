// src/routes/badges.js
const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const archiver = require('archiver');
const db       = require('../db');
const { generateBadges } = require('../services/badgeService');

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

const TYPE_BG_KEYS = {
  'delegate': 'badge_bg_delegate_path',
  'faculty': 'badge_bg_faculty_path',
  'sponsor': 'badge_bg_sponsor_path',
  'event team': 'badge_bg_event_team_path',
  'event-team': 'badge_bg_event_team_path'
};

function mapTypeToBgKey(type) {
  return TYPE_BG_KEYS[type && String(type).trim().toLowerCase()];
}

function mapTypeToFileName(type) {
  const normalized = (type && String(type).trim().toLowerCase() === 'event team') ? 'event-team' : String(type || '').trim().toLowerCase();
  if (normalized === 'eventteam') return 'event-team';
  return ['delegate','faculty','sponsor','event-team'].includes(normalized) ? normalized : null;
}

// POST /api/badges/generate
// Body: { ids: [1,2,3] }  — omit ids to generate all
router.post('/generate', async (req, res) => {
  try {
    const settings = getSettings();
    let participants;

    if (req.body.ids && req.body.ids.length) {
      const placeholders = req.body.ids.map(() => '?').join(',');
      participants = db.prepare(
        `SELECT id,badge_id,name,type,company,qr_base64 FROM participants WHERE id IN (${placeholders})`
      ).all(...req.body.ids);
    } else {
      participants = db.prepare(
        'SELECT id,badge_id,name,type,company,qr_base64 FROM participants ORDER BY name'
      ).all();
    }

    if (!participants.length) {
      return res.status(400).json({ error: 'No participants found to generate badges for.' });
    }

    // Stream progress via WebSocket while generating
    const onProgress = (done, total, name) => {
      req.app.broadcast({ type: 'badge_progress', done, total, name });
    };

    const result = await generateBadges(participants, settings, onProgress);

    req.app.broadcast({ type: 'badge_complete', count: result.count });

    res.json({
      success: true,
      count:        result.count,
      bulkFile:     `/exports/bulk/${result.bulkFilename}`,
      individualDir: `/exports/individual/`
    });
  } catch (err) {
    console.error('Badge generation error:', err);
    res.status(500).json({ error: 'Badge generation failed: ' + err.message });
  }
});

// GET /api/badges/download/bulk — latest bulk PDF
router.get('/download/bulk', (req, res) => {
  const bulkDir = path.join(__dirname, '../../exports/bulk');
  const files   = fs.readdirSync(bulkDir).filter(f => f.endsWith('.pdf')).sort().reverse();
  if (!files.length) return res.status(404).json({ error: 'No bulk PDF found. Generate badges first.' });
  res.download(path.join(bulkDir, files[0]), files[0]);
});

// GET /api/badges/download/zip — disabled (not used)
router.get('/download/zip', (req, res) => {
  res.status(404).json({ error: 'Individual ZIP download is disabled' });
});

// GET /api/badges/download/individual/:filename
router.get('/download/individual/:filename', (req, res) => {
  const filePath = path.join(__dirname, '../../exports/individual', req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

// POST /api/badges/upload-logo — upload event logo
router.post('/upload-logo', (req, res) => {
  if (!req.files || !req.files.logo) return res.status(400).json({ error: 'No logo file uploaded' });

  const logo   = req.files.logo;
  const ext    = logo.name.split('.').pop().toLowerCase();
  if (!['png','jpg','jpeg','svg'].includes(ext)) {
    return res.status(400).json({ error: 'Logo must be PNG, JPG, or SVG' });
  }

  const logoDir  = path.join(__dirname, '../../data');
  const logoPath = path.join(logoDir, `logo.${ext}`);
  fs.mkdirSync(logoDir, { recursive: true });
  logo.mv(logoPath, (err) => {
    if (err) return res.status(500).json({ error: 'Logo save failed' });
    // Update settings
    db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('logo_path',?)`).run(logoPath);
    res.json({ success: true, message: 'Logo uploaded', path: logoPath });
  });
});

// POST /api/badges/upload-bg — upload custom badge background PNG (global)
router.post('/upload-bg', (req, res) => {
  if (!req.files || !req.files.file) return res.status(400).json({ error: 'No background file uploaded' });

  const bg = req.files.file;
  const ext = bg.name.split('.').pop().toLowerCase();
  if (ext !== 'png') return res.status(400).json({ error: 'Background must be a PNG file' });

  const dataDir = path.join(__dirname, '../../data');
  const bgPath = path.join(dataDir, 'badge_bg.png');
  fs.mkdirSync(dataDir, { recursive: true });

  bg.mv(bgPath, (err) => {
    if (err) return res.status(500).json({ error: 'Background save failed' });
    db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES('badge_bg_path',?)`).run(bgPath);
    res.json({ success: true, message: 'Background uploaded', path: bgPath });
  });
});

// POST /api/badges/upload-bg/:type — upload type-specific badge background PNG
router.post('/upload-bg/:type', (req, res) => {
  const type = req.params.type;
  const key = mapTypeToBgKey(type);
  const fileType = mapTypeToFileName(type);

  if (!key || !fileType) return res.status(400).json({ error: 'Invalid type for background upload' });
  if (!req.files || !req.files.file) return res.status(400).json({ error: 'No background file uploaded' });

  const bg = req.files.file;
  const ext = bg.name.split('.').pop().toLowerCase();
  if (ext !== 'png') return res.status(400).json({ error: 'Background must be a PNG file' });

  const dataDir = path.join(__dirname, '../../data');
  const bgPath = path.join(dataDir, `badge_bg_${fileType}.png`);
  fs.mkdirSync(dataDir, { recursive: true });

  bg.mv(bgPath, (err) => {
    if (err) return res.status(500).json({ error: 'Background save failed' });
    db.prepare(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`).run(key, bgPath);
    res.json({ success: true, message: 'Background uploaded', path: bgPath, type: type });
  });
});

// POST /api/badges/clear-bg — revert global default background
router.post('/clear-bg', (req, res) => {
  db.prepare(`DELETE FROM settings WHERE key = 'badge_bg_path'`).run();
  res.json({ success: true, message: 'Reverted to default' });
});

// POST /api/badges/clear-bg/:type — revert type-specific background
router.post('/clear-bg/:type', (req, res) => {
  const type = req.params.type;
  const key = mapTypeToBgKey(type);
  if (!key) return res.status(400).json({ error: 'Invalid type for background clear' });

  db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  res.json({ success: true, message: `Cleared background for ${type}` });
});

module.exports = router;
