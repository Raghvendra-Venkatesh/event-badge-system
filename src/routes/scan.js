const express = require('express');
const router = express.Router();
const db = require('../db');
const { DEFAULT_TIME_ZONE, getDateInTimeZone } = require('../dateTime');

router.post('/', async (req, res) => {
  const badgeId = req.body.uuid || req.body.badge_id;
  const station = req.body.station_type || req.body.station;
  if (!badgeId || !station) {
    return res.status(400).json({ error: 'badge_id (uuid) and station (station_type) are required' });
  }

  const operatorId = req.body.operator_id || 'System';

  try {
    const scannedAt = new Date();
    const scan = await db.transaction(async tx => {
      const timeZoneResult = await tx.query(
        "SELECT value FROM settings WHERE key = 'event_timezone' FOR SHARE"
      );
      const timeZone = timeZoneResult.rows[0] ? timeZoneResult.rows[0].value : DEFAULT_TIME_ZONE;
      const scanDay = getDateInTimeZone(scannedAt, timeZone);
      const lookup = await tx.query(
        'SELECT * FROM participants WHERE badge_id = ? FOR UPDATE',
        [badgeId]
      );
      const participant = lookup.rows[0];

      if (!participant) {
        const inserted = await tx.query(`
          INSERT INTO scans(badge_id, station, result, operator_id, scan_day, scanned_at)
          VALUES(?, ?, 'DENY', ?, ?, ?) RETURNING scanned_at
        `, [badgeId, station, operatorId, scanDay, scannedAt]);
        return {
          result: 'DENY',
          message: 'Unknown QR code — not registered.',
          scanned_at: inserted.rows[0].scanned_at
        };
      }

      let result = 'ALLOW';
      let message = '';
      if (participant.archived_at) {
        result = 'DENY';
        message = 'Participant is archived.';
      } else if (station === 'lunch') {
        const existing = await tx.query(`
          SELECT id FROM scans
          WHERE participant_id = ? AND station = 'lunch' AND result = 'ALLOW' AND scan_day = ?
          LIMIT 1
        `, [participant.id, scanDay]);
        if (existing.rows.length) {
          result = 'DENY';
          message = 'Lunch already collected today.';
        } else {
          message = 'Lunch — enjoy your meal!';
        }
      } else if (station === 'kit') {
        const existing = await tx.query(`
          SELECT id FROM scans
          WHERE participant_id = ? AND station = 'kit' AND result = 'ALLOW'
          LIMIT 1
        `, [participant.id]);
        if (existing.rows.length) {
          result = 'DENY';
          message = 'Kit already collected.';
        } else {
          message = 'Kit collected.';
        }
      } else if (station === 'checkin') {
        const lastAttendance = await tx.query(`
          SELECT station FROM scans
          WHERE participant_id=? AND station IN ('checkin', 'checkout')
          ORDER BY scanned_at DESC, id DESC LIMIT 1
        `, [participant.id]);
        if (lastAttendance.rows[0] && lastAttendance.rows[0].station === 'checkin') {
          result = 'CAUTION';
          message = 'Already checked in (re-entry).';
        } else {
          message = `Welcome, ${participant.name}!`;
        }
      } else if (station === 'checkout') {
        const lastAttendance = await tx.query(`
          SELECT station FROM scans
          WHERE participant_id=? AND station IN ('checkin', 'checkout')
          ORDER BY scanned_at DESC, id DESC LIMIT 1
        `, [participant.id]);
        if (!lastAttendance.rows[0] || lastAttendance.rows[0].station === 'checkout') {
          result = 'CAUTION';
          message = lastAttendance.rows[0]
            ? 'Already checked out.'
            : 'No check-in recorded — checking out anyway.';
        } else {
          message = `Goodbye, ${participant.name}!`;
        }
      } else {
        message = 'Scanned at unknown station.';
      }

      const parameters = [participant.id, badgeId, station, result, operatorId, scanDay, scannedAt];
      let inserted = await tx.query(`
        INSERT INTO scans(participant_id, badge_id, station, result, operator_id, scan_day, scanned_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ${station === 'lunch' && result === 'ALLOW' ? 'ON CONFLICT DO NOTHING' : ''}
        RETURNING scanned_at
      `, parameters);

      if (!inserted.rows.length) {
        result = 'DENY';
        message = 'Lunch already collected today.';
        inserted = await tx.query(`
          INSERT INTO scans(participant_id, badge_id, station, result, operator_id, scan_day, scanned_at)
          VALUES(?, ?, ?, ?, ?, ?, ?) RETURNING scanned_at
        `, [participant.id, badgeId, station, result, operatorId, scanDay, scannedAt]);
      }

      return {
        result,
        message,
        scanned_at: inserted.rows[0].scanned_at,
        participant: {
          name: participant.name,
          type: participant.type,
          company: participant.company,
          badge_id: participant.badge_id
        }
      };
    });

    const response = {
      result: scan.result.toLowerCase(),
      message: scan.message || `${station} scanned.`,
      participant: scan.participant,
      scanned_at: scan.scanned_at
    };
    if (req.app.broadcast) {
      req.app.broadcast({
        type: 'scan',
        badge_id: badgeId,
        station_type: station,
        result: response.result,
        message: response.message,
        operator_id: operatorId,
        scanned_at: response.scanned_at,
        participant: response.participant
      });
    }
    res.json(response);
  } catch (error) {
    console.error('Scan failed:', error);
    res.status(500).json({ error: 'Could not record scan. Please retry.' });
  }
});

router.get('/log', async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 10000)
      : 1000;
    const station = String(req.query.station_type || '');
    const params = [];
    let where = '';
    if (station) {
      where = 'WHERE s.station = ?';
      params.push(station);
    }
    params.push(limit);
    const logs = await db.query(`
      SELECT s.id, s.badge_id, s.station AS station_type, s.result, s.scanned_at, s.operator_id,
        p.id AS participant_id, p.name, p.company, p.tnmc_no, p.email, p.phone, p.type
      FROM scans s
      LEFT JOIN participants p ON s.participant_id = p.id
      ${where}
      ORDER BY s.scanned_at DESC, s.id DESC
      LIMIT ?
    `, params);
    res.json(logs.rows);
  } catch (error) {
    console.error('Scan log read failed:', error);
    res.status(500).json({ error: 'Could not load scan logs.' });
  }
});

module.exports = router;
