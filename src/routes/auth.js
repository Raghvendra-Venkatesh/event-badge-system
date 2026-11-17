const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  SESSION_COOKIE,
  SESSION_DURATION_SECONDS,
  createSessionToken,
  safeEqual
} = require('../auth');

const router = express.Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' }
});

router.post('/login', loginLimiter, (req, res) => {
  const password = req.body && req.body.password;
  if (typeof password !== 'string' || !safeEqual(password, process.env.OPERATOR_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }

  const token = createSessionToken(process.env.SESSION_SECRET);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION_SECONDS}${secure}`
  );
  res.json({ success: true });
});

router.post('/logout', (req, res) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  );
  res.json({ success: true });
});

module.exports = router;
