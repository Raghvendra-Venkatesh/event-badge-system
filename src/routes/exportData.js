const express = require('express');
const router = express.Router();
const db = require('../db');

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = rows.map(row =>
    headers.map(header => {
      const value = row[header] == null
        ? ''
        : row[header] instanceof Date
          ? row[header].toISOString()
          : String(row[header]);
      return `"${value.replace(/"/g, '""')}"`;
    }).join(',')
  );
  return [headers.join(','), ...lines].join('\r\n');
}

function sendCSV(res, filename, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCSV(rows));
}

const scanColumns = `
  SELECT s.id, s.badge_id, p.name, p.company, p.tnmc_no, p.email, p.phone, p.type,
    s.station, s.result, s.operator_id, s.scanned_at
  FROM scans s LEFT JOIN participants p ON s.participant_id = p.id
`;

const scanExports = [
  ['/full', 'full_log.csv', `${scanColumns} ORDER BY s.scanned_at, s.id`],
  ['/checkins', 'checkins.csv', `${scanColumns} WHERE s.station = 'checkin' ORDER BY s.scanned_at, s.id`],
  ['/checkouts', 'checkouts.csv', `${scanColumns} WHERE s.station = 'checkout' ORDER BY s.scanned_at, s.id`],
  ['/lunch', 'lunch_log.csv', `${scanColumns} WHERE s.station = 'lunch' ORDER BY s.scanned_at, s.id`],
  ['/kit', 'kit_log.csv', `${scanColumns} WHERE s.station = 'kit' ORDER BY s.scanned_at, s.id`]
];

for (const [route, filename, sql] of scanExports) {
  router.get(route, async (req, res) => {
    try {
      const result = await db.query(sql);
      sendCSV(res, filename, result.rows);
    } catch (error) {
      console.error(`Export ${filename} failed:`, error);
      res.status(500).json({ error: 'Could not export scan data.' });
    }
  });
}

router.get('/participants', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, badge_id, name, company, tnmc_no, email, phone, type, created_at, archived_at
      FROM participants ORDER BY name NULLS LAST, id
    `);
    sendCSV(res, 'participants.csv', result.rows);
  } catch (error) {
    console.error('Participant export failed:', error);
    res.status(500).json({ error: 'Could not export participant data.' });
  }
});

module.exports = router;
