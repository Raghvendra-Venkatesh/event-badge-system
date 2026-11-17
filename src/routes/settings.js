const express = require('express');
const router = express.Router();
const db = require('../db');
const { DEFAULT_TIME_ZONE, isValidDateOnly, isValidTimeZone } = require('../dateTime');

router.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT key, value FROM settings');
    const settings = Object.fromEntries(result.rows.map(row => [row.key, row.value]));
    settings.event_timezone = settings.event_timezone || DEFAULT_TIME_ZONE;
    res.json(settings);
  } catch (error) {
    console.error('Settings read failed:', error);
    res.status(500).json({ error: 'Could not load event settings.' });
  }
});

router.post('/', async (req, res) => {
  const updates = {};
  if (Object.prototype.hasOwnProperty.call(req.body, 'event_name')) {
    if (typeof req.body.event_name !== 'string' || req.body.event_name.length > 200) {
      return res.status(400).json({ error: 'Event name must be 200 characters or fewer.' });
    }
    updates.event_name = req.body.event_name.trim();
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'event_date')) {
    const value = req.body.event_date;
    if (value !== '' && !isValidDateOnly(value)) {
      return res.status(400).json({ error: 'Event date must be a valid YYYY-MM-DD date.' });
    }
    updates.event_date = value;
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'event_timezone')) {
    const value = req.body.event_timezone;
    if (typeof value !== 'string' || !isValidTimeZone(value.trim())) {
      return res.status(400).json({ error: 'Enter a valid IANA time zone, such as Asia/Kolkata.' });
    }
    updates.event_timezone = value.trim();
  }
  if (!Object.keys(updates).length) {
    return res.status(400).json({ error: 'No supported event settings were provided.' });
  }

  try {
    await db.transaction(async tx => {
      for (const [key, value] of Object.entries(updates)) {
        await tx.query(`
          INSERT INTO settings(key, value) VALUES(?, ?)
          ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value
        `, [key, value]);
      }
      if (updates.event_timezone) {
        await tx.query(
          'UPDATE scans SET scan_day = (scanned_at AT TIME ZONE ?)::date',
          [updates.event_timezone]
        );
      }
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Settings update failed:', error);
    res.status(500).json({ error: 'Could not save event settings.' });
  }
});

module.exports = router;
