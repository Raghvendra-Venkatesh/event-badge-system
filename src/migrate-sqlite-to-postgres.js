require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Database } = require('node-sqlite3-wasm');
const db = require('./db');
const setupDatabase = require('./setup-db');
const { DATA_DIR } = require('./storagePaths');
const {
  DEFAULT_TIME_ZONE,
  getDateInTimeZone,
  isValidTimeZone,
  normalizeLegacyTimestamp
} = require('./dateTime');

function makeValues(rows, columns) {
  const placeholders = `(${columns.map(() => '?').join(',')})`;
  const sql = `(${rows.map(() => placeholders).join(',')})`;
  return {
    sql,
    values: rows.flatMap(row => columns.map(column => row[column]))
  };
}

async function insertRows(tx, table, columns, rows, conflictClause = '') {
  const batchSize = 250;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const values = makeValues(batch, columns);
    await tx.query(
      `INSERT INTO ${table}(${columns.join(',')}) VALUES ${values.sql} ${conflictClause}`,
      values.values
    );
  }
}

function copyAssets(settings, sourceDirectory) {
  const migratedSettings = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!key.endsWith('_path') || !value) {
      migratedSettings[key] = value;
      continue;
    }

    const filename = path.basename(String(value).replace(/\\/g, '/'));
    const sourcePath = path.join(sourceDirectory, filename);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Asset for setting "${key}" is missing: ${sourcePath}`);
    }
    const destination = path.join(DATA_DIR, filename);
    if (path.resolve(sourcePath) !== path.resolve(destination)) {
      fs.copyFileSync(sourcePath, destination);
    }
    migratedSettings[key] = filename;
  }
  return migratedSettings;
}

async function migrate(sourcePath) {
  const absoluteSource = path.resolve(sourcePath);
  if (!fs.existsSync(absoluteSource)) {
    throw new Error(`SQLite database not found: ${absoluteSource}`);
  }

  await setupDatabase();
  const counts = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM participants) AS participants,
      (SELECT COUNT(*) FROM scans) AS scans
  `);
  if (Number(counts.rows[0].participants) || Number(counts.rows[0].scans)) {
    throw new Error('Target PostgreSQL database already has participants or scans; migration stopped without overwriting data.');
  }

  const sqlite = new Database(absoluteSource);
  const participants = sqlite.all(`
    SELECT id, badge_id, name, email, phone, type, company, tnmc_no, qr_base64, created_at
    FROM participants ORDER BY id
  `);
  const scans = sqlite.all(`
    SELECT id, participant_id, badge_id, station, result, operator_id, scanned_at
    FROM scans ORDER BY id
  `);
  const sourceSettings = sqlite.all('SELECT key, value FROM settings');
  const settings = Object.fromEntries(sourceSettings.map(row => [row.key, row.value]));
  const timeZone = settings.event_timezone || process.env.EVENT_TIME_ZONE || DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) throw new Error(`Invalid event time zone in SQLite settings: ${timeZone}`);
  settings.event_timezone = timeZone;
  const migratedSettings = copyAssets(settings, path.dirname(absoluteSource));

  const migratedParticipants = participants.map(row => ({
    ...row,
    created_at: normalizeLegacyTimestamp(row.created_at)
  }));
  const migratedScans = scans.map(row => {
    const scannedAt = normalizeLegacyTimestamp(row.scanned_at);
    return {
      ...row,
      scanned_at: scannedAt,
      scan_day: getDateInTimeZone(new Date(scannedAt), timeZone)
    };
  });

  await db.transaction(async tx => {
    await insertRows(tx, 'participants',
      ['id', 'badge_id', 'name', 'email', 'phone', 'type', 'company', 'tnmc_no', 'qr_base64', 'created_at'],
      migratedParticipants);
    await insertRows(tx, 'scans',
      ['id', 'participant_id', 'badge_id', 'station', 'result', 'operator_id', 'scanned_at', 'scan_day'],
      migratedScans);
    for (const [key, value] of Object.entries(migratedSettings)) {
      await tx.query(`
        INSERT INTO settings(key,value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value
      `, [key, value]);
    }
  });

  await db.query(`
    SELECT setval(
      pg_get_serial_sequence('participants', 'id'),
      GREATEST(COALESCE((SELECT MAX(id) FROM participants), 1), 1),
      EXISTS (SELECT 1 FROM participants)
    )
  `);
  const badgeMax = await db.query(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(badge_id FROM 5) AS INTEGER)), 0) AS max FROM participants WHERE badge_id ~ '^BDG-[0-9]+$'"
  );
  if (Number(badgeMax.rows[0].max) > 0) {
    await db.query("SELECT setval('participant_badge_counter_seq', ?, true)", [Number(badgeMax.rows[0].max)]);
  }

  console.log(`Migrated ${participants.length} participants and ${scans.length} scan records.`);
}

if (require.main === module) {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Usage: node src/migrate-sqlite-to-postgres.js <path-to-event.db>');
    process.exitCode = 1;
  } else {
    migrate(sourcePath)
      .then(() => db.close())
      .catch(async error => {
        console.error('SQLite migration failed:', error);
        await db.close();
        process.exitCode = 1;
      });
  }
}

module.exports = { migrate };
