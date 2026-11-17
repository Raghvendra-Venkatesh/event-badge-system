const crypto = require('crypto');

const SESSION_COOKIE = 'event_session';
const SESSION_DURATION_SECONDS = 8 * 60 * 60;

function validateAuthConfig() {
  const { OPERATOR_PASSWORD, SESSION_SECRET } = process.env;
  if (!OPERATOR_PASSWORD || OPERATOR_PASSWORD.length < 12) {
    throw new Error('OPERATOR_PASSWORD must be set to at least 12 characters.');
  }
  if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters.');
  }
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash('sha256').update(String(left)).digest();
  const rightHash = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function sign(expiry, secret) {
  return crypto.createHmac('sha256', secret).update(String(expiry)).digest('base64url');
}

function createSessionToken(secret, now = Date.now()) {
  const expiry = Math.floor(now / 1000) + SESSION_DURATION_SECONDS;
  return `${expiry}.${sign(expiry, secret)}`;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

function hasValidSession(cookieHeader, secret, now = Date.now()) {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return false;
  const separator = token.indexOf('.');
  if (separator < 1) return false;

  const expiry = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^\d+$/.test(expiry) || Number(expiry) <= Math.floor(now / 1000)) return false;

  const expected = sign(expiry, secret);
  return safeEqual(signature, expected);
}

module.exports = {
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS,
  createSessionToken,
  hasValidSession,
  safeEqual,
  validateAuthConfig
};
