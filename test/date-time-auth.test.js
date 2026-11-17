const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getDateInTimeZone,
  isValidDateOnly,
  isValidTimeZone,
  normalizeLegacyTimestamp
} = require('../src/dateTime');
const {
  createSessionToken,
  hasValidSession,
  safeEqual
} = require('../src/auth');
const { buildBadgeHTML } = require('../src/services/badgeService');

test('event day follows the configured time zone across UTC midnight', () => {
  const timestamp = new Date('2026-11-17T20:00:00.000Z');
  assert.equal(getDateInTimeZone(timestamp, 'Asia/Kolkata'), '2026-11-18');
  assert.equal(getDateInTimeZone(timestamp, 'America/Los_Angeles'), '2026-11-17');
});

test('date-only event settings reject impossible calendar dates', () => {
  assert.equal(isValidDateOnly('2024-02-29'), true);
  assert.equal(isValidDateOnly('2025-02-29'), false);
  assert.equal(isValidDateOnly('2025-2-03'), false);
});

test('time zone names must be valid IANA zones', () => {
  assert.equal(isValidTimeZone('Asia/Kolkata'), true);
  assert.equal(isValidTimeZone('Not/A_Timezone'), false);
  assert.equal(isValidTimeZone(''), false);
});

test('legacy SQLite timestamps are migrated as UTC unless they have an offset', () => {
  assert.equal(
    normalizeLegacyTimestamp('2026-11-17 20:00:00'),
    '2026-11-17T20:00:00.000Z'
  );
  assert.equal(
    normalizeLegacyTimestamp('2026-11-17T20:00:00-05:00'),
    '2026-11-18T01:00:00.000Z'
  );
});

test('operator sessions are signed, expire, and reject tampering', () => {
  const secret = 'a-test-secret-that-is-long-enough-to-use';
  const now = Date.UTC(2026, 0, 1);
  const token = createSessionToken(secret, now);
  assert.equal(hasValidSession(`event_session=${token}`, secret, now), true);
  assert.equal(hasValidSession(`event_session=${token}`, 'a-different-secret-long-enough-to-use', now), false);
  assert.equal(hasValidSession(`event_session=${token}`, secret, now + 9 * 60 * 60 * 1000), false);
  const [expiry, signature] = token.split('.');
  assert.equal(hasValidSession(`event_session=${Number(expiry) + 1}.${signature}`, secret, now), false);
});

test('password equality helper compares values without accepting mismatches', () => {
  assert.equal(safeEqual('correct horse battery staple', 'correct horse battery staple'), true);
  assert.equal(safeEqual('correct horse battery staple', 'wrong password'), false);
});

test('badge text is escaped and user text cannot inject another template token', () => {
  const html = buildBadgeHTML(
    '<div>{{PARTICIPANT_NAME}}</div><div>{{LOGO_HTML}}</div>',
    { name: '<img src=x onerror=alert(1)> {{PHONE}}' },
    { event_name: 'Event <script>alert(1)</script>' }
  );
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; \{\{PHONE\}\}/);
  assert.doesNotMatch(html, /<img src=x onerror=/);
  assert.match(html, /Event &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
