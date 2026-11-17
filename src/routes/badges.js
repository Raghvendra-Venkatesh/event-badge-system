const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { DATA_DIR, EXPORTS_DIR } = require('../storagePaths');
const { generateBadges } = require('../services/badgeService');

async function getSettings() {
  const result = await db.query('SELECT key, value FROM settings');
  return Object.fromEntries(result.rows.map(row => [
    row.key,
    row.key.endsWith('_path') && row.value
      ? path.join(DATA_DIR, path.basename(String(row.value).replace(/\\/g, '/')))
      : row.value
  ]));
}

const TYPE_BG_KEYS = {
  delegate: 'badge_bg_delegate_path',
  faculty: 'badge_bg_faculty_path',
  sponsor: 'badge_bg_sponsor_path',
  'event team': 'badge_bg_event_team_path',
  'event-team': 'badge_bg_event_team_path'
};

function mapTypeToBgKey(type) {
  return TYPE_BG_KEYS[type && String(type).trim().toLowerCase()];
}

function mapTypeToFileName(type) {
  const normalized = (type && String(type).trim().toLowerCase() === 'event team')
    ? 'event-team'
    : String(type || '').trim().toLowerCase();
  if (normalized === 'eventteam') return 'event-team';
  return ['delegate', 'faculty', 'sponsor', 'event-team'].includes(normalized) ? normalized : null;
}

async function saveSetting(key, value) {
  await db.query(`
    INSERT INTO settings(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value
  `, [key, value]);
}

router.post('/generate', async (req, res) => {
  try {
    const settings = await getSettings();
    let result;
    if (req.body.ids !== undefined) {
      if (!Array.isArray(req.body.ids) || req.body.ids.length > 1000 ||
          req.body.ids.some(id => !Number.isInteger(Number(id)))) {
        return res.status(400).json({ error: 'Participant IDs must be an array of up to 1000 integers.' });
      }
      if (!req.body.ids.length) {
        return res.status(400).json({ error: 'Select at least one participant.' });
      }
      const placeholders = req.body.ids.map(() => '?').join(',');
      result = await db.query(`
        SELECT id,badge_id,name,type,company,qr_base64 FROM participants
        WHERE archived_at IS NULL AND id IN (${placeholders})
      `, req.body.ids);
    } else {
      result = await db.query(`
        SELECT id,badge_id,name,type,company,qr_base64 FROM participants
        WHERE archived_at IS NULL ORDER BY name
      `);
    }

    if (!result.rows.length) {
      return res.status(400).json({ error: 'No active participants found to generate badges for.' });
    }

    const onProgress = (done, total, name) => {
      req.app.broadcast({ type: 'badge_progress', done, total, name });
    };
    const generated = await generateBadges(result.rows, settings, onProgress);
    req.app.broadcast({ type: 'badge_complete', count: generated.count });
    res.json({
      success: true,
      count: generated.count,
      bulkFile: `/exports/bulk/${generated.bulkFilename}`,
      individualDir: '/exports/individual/'
    });
  } catch (error) {
    console.error('Badge generation failed:', error);
    res.status(500).json({ error: 'Badge generation failed.' });
  }
});

router.get('/download/bulk', (req, res) => {
  const bulkDir = path.join(EXPORTS_DIR, 'bulk');
  const files = fs.existsSync(bulkDir)
    ? fs.readdirSync(bulkDir).filter(file => file.endsWith('.pdf')).sort().reverse()
    : [];
  if (!files.length) return res.status(404).json({ error: 'No bulk PDF found. Generate badges first.' });
  res.download(path.join(bulkDir, files[0]), files[0]);
});

router.get('/download/zip', (req, res) => {
  res.status(404).json({ error: 'Individual ZIP download is disabled' });
});

router.get('/download/individual/:filename', (req, res) => {
  const filePath = path.join(EXPORTS_DIR, 'individual', path.basename(req.params.filename));
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  res.download(filePath);
});

router.post('/upload-logo', async (req, res) => {
  if (!req.files || !req.files.logo) return res.status(400).json({ error: 'No logo file uploaded' });
  const logo = req.files.logo;
  const ext = path.extname(logo.name).slice(1).toLowerCase();
  if (!['png', 'jpg', 'jpeg', 'svg'].includes(ext)) {
    return res.status(400).json({ error: 'Logo must be PNG, JPG, JPEG, or SVG.' });
  }

  const logoPath = path.join(DATA_DIR, `logo.${ext}`);
  try {
    await logo.mv(logoPath);
    await saveSetting('logo_path', path.basename(logoPath));
    res.json({ success: true, message: 'Logo uploaded' });
  } catch (error) {
    console.error('Logo upload failed:', error);
    res.status(500).json({ error: 'Logo save failed.' });
  }
});

router.post('/upload-bg', async (req, res) => {
  if (!req.files || !req.files.file) return res.status(400).json({ error: 'No background file uploaded' });
  const background = req.files.file;
  if (path.extname(background.name).toLowerCase() !== '.png') {
    return res.status(400).json({ error: 'Background must be a PNG file.' });
  }

  const backgroundPath = path.join(DATA_DIR, 'badge_bg.png');
  try {
    await background.mv(backgroundPath);
    await saveSetting('badge_bg_path', path.basename(backgroundPath));
    res.json({ success: true, message: 'Background saved' });
  } catch (error) {
    console.error('Background upload failed:', error);
    res.status(500).json({ error: 'Background save failed.' });
  }
});

router.post('/upload-bg/:type', async (req, res) => {
  const type = req.params.type;
  const key = mapTypeToBgKey(type);
  const fileType = mapTypeToFileName(type);
  if (!key || !fileType) return res.status(400).json({ error: 'Invalid type for background upload.' });
  if (!req.files || !req.files.file) return res.status(400).json({ error: 'No background file uploaded' });
  const background = req.files.file;
  if (path.extname(background.name).toLowerCase() !== '.png') {
    return res.status(400).json({ error: 'Background must be a PNG file.' });
  }

  const backgroundPath = path.join(DATA_DIR, `badge_bg_${fileType}.png`);
  try {
    await background.mv(backgroundPath);
    await saveSetting(key, path.basename(backgroundPath));
    res.json({ success: true, message: 'Background saved', type });
  } catch (error) {
    console.error('Type background upload failed:', error);
    res.status(500).json({ error: 'Background save failed.' });
  }
});

router.post('/clear-bg', async (req, res) => {
  try {
    await db.query("DELETE FROM settings WHERE key = 'badge_bg_path'");
    res.json({ success: true, message: 'Reverted to default' });
  } catch (error) {
    console.error('Background clear failed:', error);
    res.status(500).json({ error: 'Could not clear background.' });
  }
});

router.post('/clear-bg/:type', async (req, res) => {
  const key = mapTypeToBgKey(req.params.type);
  if (!key) return res.status(400).json({ error: 'Invalid type for background clear' });
  try {
    await db.query('DELETE FROM settings WHERE key = ?', [key]);
    res.json({ success: true, message: `Cleared background for ${req.params.type}` });
  } catch (error) {
    console.error('Type background clear failed:', error);
    res.status(500).json({ error: 'Could not clear type background.' });
  }
});

module.exports = router;
