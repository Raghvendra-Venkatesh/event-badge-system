require('dotenv').config();

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const db = require('./db');
const setupDatabase = require('./setup-db');
const { DATA_DIR, EXPORTS_DIR } = require('./storagePaths');
const { hasValidSession, validateAuthConfig } = require('./auth');

validateAuthConfig();

const app = express();
const publicDir = path.join(__dirname, '../public');
const tlsKeyPath = process.env.TLS_KEY_PATH;
const tlsCertPath = process.env.TLS_CERT_PATH;

if (Boolean(tlsKeyPath) !== Boolean(tlsCertPath)) {
  throw new Error('Set both TLS_KEY_PATH and TLS_CERT_PATH, or neither.');
}

app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } }));

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || !req.headers.origin) {
    return next();
  }
  try {
    const origin = new URL(req.headers.origin);
    const expectedProtocol = req.secure ? 'https:' : 'http:';
    if (origin.host !== req.headers.host || origin.protocol !== expectedProtocol) {
      return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    }
    return next();
  } catch {
    return res.status(403).json({ error: 'Invalid request origin.' });
  }
});

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use('/api/auth', require('./routes/auth'));

app.use((req, res, next) => {
  if (req.path === '/login.html') return next();
  if (hasValidSession(req.headers.cookie, process.env.SESSION_SECRET)) {
    res.setHeader('Cache-Control', 'no-store');
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).send('Authentication required.');
});

app.use(express.static(publicDir));
app.use('/exports', express.static(EXPORTS_DIR));

app.broadcast = (data) => {
  const message = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  });
};

app.use('/api/participants', require('./routes/participants'));
app.use('/api/import', require('./routes/import'));
app.use('/api/scan', require('./routes/scan'));
app.use('/api/badges', require('./routes/badges'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/export', require('./routes/exportData'));

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = tlsKeyPath
  ? https.createServer({
      key: fs.readFileSync(tlsKeyPath),
      cert: fs.readFileSync(tlsCertPath)
    }, app)
  : http.createServer(app);

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let validOrigin = true;
  if (req.headers.origin) {
    try {
      validOrigin = new URL(req.headers.origin).host === req.headers.host;
    } catch {
      validOrigin = false;
    }
  }

  if (!validOrigin || !hasValidSession(req.headers.cookie, process.env.SESSION_SECRET)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected', message: 'Live updates active' }));
});

const PORT = Number(process.env.PORT || 3000);

async function start() {
  await setupDatabase();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Event badge system listening on port ${PORT}`);
    console.log(`Persistent data directory: ${DATA_DIR}`);
    console.log(`Persistent exports directory: ${EXPORTS_DIR}`);
    if (!tlsKeyPath && process.env.NODE_ENV !== 'production') {
      console.log('Local HTTP is enabled; use HTTPS for camera access from other devices.');
    }
  });
}

server.on('error', error => {
  console.error('Server failed:', error);
  process.exitCode = 1;
});

async function shutdown() {
  server.close();
  wss.close();
  await db.close();
}

process.on('SIGTERM', () => shutdown().catch(error => {
  console.error('Shutdown failed:', error);
  process.exitCode = 1;
}));
process.on('SIGINT', () => shutdown().catch(error => {
  console.error('Shutdown failed:', error);
  process.exitCode = 1;
}));

start().catch(async error => {
  console.error('Application startup failed:', error);
  await db.close();
  process.exitCode = 1;
});
