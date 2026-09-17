/**
 * Vaultora server — single container, serves API + static frontend.
 * Storage: bind-mounted STORAGE_ROOT (/data). Metadata: SQLite in APP_DATA (/app/data).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const { getDb, getSetting } = require('./db');
const { ensureStorageLayout, storageRoot } = require('./fsutil');
const { csrfProtect } = require('./middleware');

const PORT = parseInt(process.env.PORT || '8090', 10) || 8090;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers. Static frontend needs inline scripts -> allow 'unsafe-inline' for script/style only.
// Uploaded files are NEVER served from the frontend static mount, so this does not execute uploads.
// NOTE: HSTS is deliberately OFF, and the CSP has NO upgrade-insecure-requests.
// Vaultora is typically served as plain HTTP on a LAN IP (possibly behind an
// SSL-terminating reverse proxy). Either directive makes browsers rewrite all
// http:// subresource/API requests to https://, which dies against a plain-HTTP
// server as net::ERR_SSL_PROTOCOL_ERROR (and poisons HSTS per host for months).
app.use(
  helmet({
    hsts: false,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

// Request log (tiny)
app.use((req, res, next) => {
  const t = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      // eslint-disable-next-line no-console
      console.log(`${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - t}ms`);
    }
  });
  next();
});

// Login rate limiting (configurable-ish; values re-read per window is overkill — env + sane default)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // outer guard; strict per-user check below uses DB settings
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many requests, try again later' },
});

// Strict per-username login throttle honoring settings
const loginAttempts = new Map(); // username -> {count, resetAt}
function loginThrottle(req, res, next) {
  try {
    const db = getDb();
    const max = parseInt(getSetting(db, 'login_max_attempts', '10'), 10) || 10;
    const winMin = parseInt(getSetting(db, 'login_window_minutes', '15'), 10) || 15;
    const u = String((req.body || {}).username || '').toLowerCase();
    if (!u) return next();
    const now = Date.now();
    const rec = loginAttempts.get(u);
    if (rec && rec.resetAt < now) loginAttempts.delete(u);
    const cur = loginAttempts.get(u) || { count: 0, resetAt: now + winMin * 60 * 1000 };
    if (cur.count >= max) {
      return res.status(429).json({ error: `too many login attempts — try again in ${winMin} minutes` });
    }
    res.on('finish', () => {
      if (res.statusCode === 401) {
        const r = loginAttempts.get(u) || { count: 0, resetAt: now + winMin * 60 * 1000 };
        r.count += 1;
        loginAttempts.set(u, r);
      } else if (res.statusCode === 200) {
        loginAttempts.delete(u);
      }
    });
    next();
  } catch {
    next();
  }
}

app.use(csrfProtect);

// Health (no auth; for Docker HEALTHCHECK + CasaOS)
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'vaultora', time: new Date().toISOString() });
});
app.get('/api/health', (req, res) => {
  let dbOk = true;
  try {
    getDb().prepare('SELECT 1').get();
  } catch {
    dbOk = false;
  }
  const root = storageRoot();
  const writable = (() => {
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.accessSync(root, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  })();
  res.json({ ok: dbOk && writable, db: dbOk, storage_root: root, storage_writable: writable });
});

// Build version (stamped by CI; use it to confirm an update applied)
app.get('/api/version', (req, res) => {
  res.json({
    service: 'vaultora',
    version: process.env.APP_VERSION || 'dev',
    commit: (process.env.GIT_COMMIT || '').slice(0, 12) || null,
  });
});

// API routes
app.use('/api/auth/login', loginLimiter, loginThrottle);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/files', require('./routes/files'));
app.use('/api/uploads', require('./routes/uploads'));
const shares = require('./routes/shares');
app.use('/api/shares', shares.mgmt);
app.use('/', shares.pub); // public share endpoints live under /api/public/...
const admin = require('./routes/admin');
app.use('/api/admin', admin.router);

// CSRF token endpoint (session-less safe: issues cookie for logged-in users)
app.get('/api/csrf', (req, res) => {
  const crypto = require('crypto');
  const tok = crypto.randomBytes(24).toString('base64url');
  res.cookie('vid_csrf', tok, { sameSite: 'strict', path: '/' });
  res.json({ csrf: tok });
});

// OpenAPI spec
app.get('/api/openapi.yaml', (req, res) => {
  const p = path.join(__dirname, '..', 'openapi.yaml');
  if (fs.existsSync(p)) res.type('text/yaml').send(fs.readFileSync(p, 'utf8'));
  else res.status(404).json({ error: 'no spec' });
});

// Share page + app shell (static). Short cache so clients pick up fixes fast.
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '15m', dotfiles: 'ignore' }));

// /s/:token share landing is rendered by the SPA (public build, no inline
// scripts — hence script-src needs no 'unsafe-inline').
app.get('/s/:token', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.get('/s/:token/download', (req, res) => {
  res.redirect(307, `/api/public/${encodeURIComponent(req.params.token)}/download${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`);
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => (err ? next(err) : null));
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'request too large' });
  // eslint-disable-next-line no-console
  console.error('unhandled:', err && err.message);
  res.status(500).json({ error: 'internal error' });
});

function boot() {
  ensureStorageLayout();
  const db = getDb();
  // Trash cleanup timer: every 6h
  const { runTrashCleanup } = require('./routes/admin');
  const sixH = 6 * 3600 * 1000;
  setInterval(() => {
    runTrashCleanup(db).then(
      (r) => r.cleaned && console.log(`trash cleanup: removed ${r.cleaned}`),
      (e) => console.error('trash cleanup failed:', e.message)
    );
  }, sixH).unref?.();
  // Run once at boot (async)
  runTrashCleanup(db).catch(() => {});
  // Expired upload tmp cleanup: every hour
  setInterval(() => {
    try {
      const stale = db.prepare("SELECT * FROM uploads WHERE status = 'active' AND datetime(updated_at) < datetime('now', '-24 hours')").all();
      for (const u of stale) {
        db.prepare("UPDATE uploads SET status = 'expired' WHERE id = ?").run(u.id);
        try { fs.rmSync(path.join(storageRoot(), u.tmp_rel), { force: true }); } catch {}
      }
      if (stale.length) console.log(`expired ${stale.length} stale uploads`);
    } catch {}
  }, 3600 * 1000).unref?.();

  app.listen(PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`Vaultora listening on :${PORT} | storage=${storageRoot()} | tz=${process.env.TZ || 'unset'}`);
  });
}

if (require.main === module) boot();
module.exports = app;
