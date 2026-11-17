const express = require('express');
const router = express.Router();
const db = require('../db');
const { getDateInTimeZone, DEFAULT_TIME_ZONE } = require('../dateTime');
const { buildParticipantListFilter } = require('../services/participantListFilter');

function boundedInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

async function getEventTimeZone() {
  const result = await db.query("SELECT value FROM settings WHERE key = 'event_timezone'");
  return result.rows[0] ? result.rows[0].value : DEFAULT_TIME_ZONE;
}

router.get('/stats', async (req, res) => {
  try {
    const timeZone = await getEventTimeZone();
    const today = getDateInTimeZone(new Date(), timeZone);
    const [totalResult, byTypeResult, checkedInResult, checkedOutResult, lunchResult, kitResult] = await Promise.all([
      db.query('SELECT COUNT(*) AS count FROM participants WHERE archived_at IS NULL'),
      db.query('SELECT type, COUNT(*) AS count FROM participants WHERE archived_at IS NULL GROUP BY type'),
      db.query(`SELECT COUNT(DISTINCT s.participant_id) AS count FROM scans s
        JOIN participants p ON p.id = s.participant_id
        WHERE p.archived_at IS NULL AND s.station = 'checkin' AND s.result = 'ALLOW'`),
      db.query(`SELECT COUNT(DISTINCT s.participant_id) AS count FROM scans s
        JOIN participants p ON p.id = s.participant_id
        WHERE p.archived_at IS NULL AND s.station = 'checkout' AND s.result IN ('ALLOW','CAUTION')`),
      db.query(`SELECT COUNT(DISTINCT s.participant_id) AS count FROM scans s
        JOIN participants p ON p.id = s.participant_id
        WHERE p.archived_at IS NULL AND s.station = 'lunch' AND s.result = 'ALLOW' AND s.scan_day = ?`, [today]),
      db.query(`SELECT COUNT(DISTINCT s.participant_id) AS count FROM scans s
        JOIN participants p ON p.id = s.participant_id
        WHERE p.archived_at IS NULL AND s.station = 'kit' AND s.result = 'ALLOW'`)
    ]);

    res.json({
      total: Number(totalResult.rows[0].count),
      byType: byTypeResult.rows.map(row => ({ ...row, count: Number(row.count) })),
      checkedIn: Number(checkedInResult.rows[0].count),
      checkedOut: Number(checkedOutResult.rows[0].count),
      lunchDone: Number(lunchResult.rows[0].count),
      kitDone: Number(kitResult.rows[0].count)
    });
  } catch (error) {
    console.error('Participant stats failed:', error);
    res.status(500).json({ error: 'Could not load participant statistics.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const q = String(req.query.q || '');
    const type = String(req.query.type || '');
    const limit = boundedInteger(req.query.limit, 50, 1000) || 50;
    const offset = boundedInteger(req.query.offset, 0, 1000000);
    const archived = req.query.archived === 'true';
    const { where, params } = buildParticipantListFilter(q, type, archived);

    const total = await db.query(`SELECT COUNT(*) AS count FROM participants WHERE ${where}`, params);
    const rows = await db.query(
      `SELECT * FROM participants WHERE ${where} ORDER BY name NULLS LAST, id LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    res.json({ rows: rows.rows, total: Number(total.rows[0].count) });
  } catch (error) {
    console.error('Participant list failed:', error);
    res.status(500).json({ error: 'Could not load participants.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM participants WHERE id = ?', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Participant not found' });
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Participant lookup failed:', error);
    res.status(500).json({ error: 'Could not load participant.' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, email, phone, type, company, tnmc_no } = req.body;
    const result = await db.query(`
      UPDATE participants SET name=?, email=?, phone=?, type=?, company=?, tnmc_no=?
      WHERE id=? AND archived_at IS NULL
      RETURNING id
    `, [name, email, phone, type, company, tnmc_no, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Active participant not found' });
    res.json({ success: true });
  } catch (error) {
    console.error('Participant update failed:', error);
    res.status(500).json({ error: 'Could not update participant.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE participants SET archived_at = COALESCE(archived_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND archived_at IS NULL
      RETURNING id
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Active participant not found' });
    res.json({ success: true, archived: true });
  } catch (error) {
    console.error('Participant archive failed:', error);
    res.status(500).json({ error: 'Could not archive participant.' });
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE participants SET archived_at = NULL
      WHERE id = ? AND archived_at IS NOT NULL
      RETURNING id
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Archived participant not found' });
    res.json({ success: true, restored: true });
  } catch (error) {
    console.error('Participant restore failed:', error);
    res.status(500).json({ error: 'Could not restore participant.' });
  }
});

module.exports = router;
