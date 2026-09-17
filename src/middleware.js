/**
 * Shared Express middleware: session auth, CSRF, audit helper, error shape.
 */
'use strict';

const { getDb } = require('./db');

const SESSION_COOKIE = 'vid_session';
const CSRF_COOKIE = 'vid_csrf';
const CSRF_HEADER = 'x-csrf-token';

function getSession(req) {
  const db = getDb();
  const sid = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (!sid) return { user: null, sessionId: null };
  const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!sess) return { user: null, sessionId: null };
  if (new Date(sess.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    return { user: null, sessionId: null };
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
  if (!user || user.disabled) return { user: null, sessionId: null };
  delete user.password_hash;
  delete user.totp_secret;
  return { user, sessionId: sid, session: sess };
}

function requireAuth(req, res, next) {
  const { user, sessionId, session } = getSession(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  req.sessionId = sessionId;
  req.sessionRow = session;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    next();
  });
}

/** CSRF: mutating requests must carry the token matching the cookie. Safe methods + share-public GETs skip. */
function csrfProtect(req, res, next) {
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (safe) return next();
  // Chunked upload PUTs and all API POST/PUT/PATCH/DELETE require token when logged in.
  if (!req.cookies || !req.cookies[SESSION_COOKIE]) return next(); // login itself uses rate-limit, no session yet
  const cookieTok = req.cookies[CSRF_COOKIE];
  const headerTok = req.get(CSRF_HEADER);
  if (!cookieTok || !headerTok || cookieTok !== headerTok) {
    return res.status(403).json({ error: 'csrf validation failed' });
  }
  next();
}

function audit(req, action, detail) {
  try {
    const db = getDb();
    db.prepare('INSERT INTO audit_log(at, user_id, username, action, detail, ip) VALUES(datetime(\'now\'),?,?,?,?,?)').run(
      req.user ? req.user.id : null,
      req.user ? req.user.username : req.body && req.body.username ? String(req.body.username) : null,
      action,
      detail ? String(detail).slice(0, 2000) : null,
      req.ip || null
    );
  } catch {
    /* audit must never break the request */
  }
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '';
}

module.exports = { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, getSession, requireAuth, requireAdmin, csrfProtect, audit, clientIp };
