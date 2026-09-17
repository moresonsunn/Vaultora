/** Auth routes: login/logout/me/password/2FA/sessions. */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDb, getSetting } = require('../db');
const { SESSION_COOKIE, CSRF_COOKIE, requireAuth, audit, clientIp } = require('../middleware');
const { randomSecret, verifyTotp, otpauthUrl } = require('../totp');

const router = express.Router();

function sessionTtlMs(db) {
  const h = parseFloat(getSetting(db, 'session_ttl_hours', '72')) || 72;
  return Math.max(1, Math.min(24 * 30, h)) * 3600 * 1000;
}

function issueSession(db, res, user, req) {
  const sid = crypto.randomUUID();
  const ttl = sessionTtlMs(db);
  const expires = new Date(Date.now() + ttl).toISOString();
  db.prepare('INSERT INTO sessions(id, user_id, created_at, expires_at, ip, user_agent) VALUES(?,?,datetime(\'now\'),?,?,?)').run(
    sid, user.id, expires, clientIp(req), String(req.get('user-agent') || '').slice(0, 300)
  );
  const secure = process.env.COOKIE_SECURE === '1' || (process.env.APP_URL || '').startsWith('https://');
  const base = { httpOnly: true, sameSite: 'strict', path: '/', secure, maxAge: ttl };
  res.cookie(SESSION_COOKIE, sid, base);
  const csrf = crypto.randomBytes(24).toString('base64url');
  res.cookie(CSRF_COOKIE, csrf, { ...base, httpOnly: false });
  return { sid, csrf, expires };
}

function publicUser(u) {
  return {
    id: u.id, username: u.username, role: u.role,
    quota_bytes: u.quota_bytes, totp_enabled: !!u.totp_enabled,
    created_at: u.created_at,
  };
}

// POST /api/auth/login {username, password, totp?}
router.post('/login', (req, res) => {
  const db = getDb();
  const { username, password, totp } = req.body || {};
  const dbUser = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!dbUser || dbUser.disabled) {
    audit(req, 'login_failed', `user=${username}`);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const ok = bcrypt.compareSync(String(password || ''), dbUser.password_hash);
  if (!ok) {
    audit(req, 'login_failed', `user=${username}`);
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (dbUser.totp_enabled) {
    if (!totp || !verifyTotp(dbUser.totp_secret, String(totp))) {
      audit(req, 'login_failed', `user=${username} totp`);
      return res.status(401).json({ error: 'invalid two-factor code', need_totp: true });
    }
  }
  const { csrf, expires } = issueSession(db, res, dbUser, req);
  audit({ ...req, user: dbUser }, 'login', `user=${dbUser.username}`);
  res.json({ user: publicUser(dbUser), csrf, expires_at: expires });
});

router.post('/logout', (req, res) => {
  const db = getDb();
  const sid = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (sid) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
  audit(req, 'logout', '');
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const db = getDb();
  const sid = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  if (!sid) return res.status(401).json({ error: 'unauthorized' });
  const sess = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid);
  if (!sess || new Date(sess.expires_at).getTime() < Date.now()) return res.status(401).json({ error: 'unauthorized' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id);
  if (!u || u.disabled) return res.status(401).json({ error: 'unauthorized' });
  // refresh CSRF cookie if missing
  if (!req.cookies[CSRF_COOKIE]) {
    res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString('base64url'), { sameSite: 'strict', path: '/' });
  }
  res.json({ user: publicUser(u), csrf: req.cookies[CSRF_COOKIE] || null });
});

router.post('/password', requireAuth, (req, res) => {
  const db = getDb();
  const { current, next } = req.body || {};
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), full.password_hash)) {
    return res.status(400).json({ error: 'current password is incorrect' });
  }
  const minLen = parseInt(getSetting(db, 'password_min_length', '8'), 10) || 8;
  if (String(next || '').length < minLen) {
    return res.status(400).json({ error: `password must be at least ${minLen} characters` });
  }
  const hash = bcrypt.hashSync(String(next), 12);
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, req.user.id);
  audit(req, 'password_change', '');
  res.json({ ok: true });
});

// 2FA setup: step 1 -> secret+url; step 2 confirm with code
router.post('/2fa/setup', requireAuth, (req, res) => {
  const db = getDb();
  const secret = randomSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.user.id);
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ secret, otpauth_url: otpauthUrl({ secret, account: full.username }), enabled: !!full.totp_enabled });
});

router.post('/2fa/enable', requireAuth, (req, res) => {
  const db = getDb();
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!full.totp_secret) return res.status(400).json({ error: 'run setup first' });
  if (!verifyTotp(full.totp_secret, String((req.body || {}).code || ''))) {
    return res.status(400).json({ error: 'invalid code' });
  }
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
  audit(req, '2fa_enable', '');
  res.json({ ok: true });
});

router.post('/2fa/disable', requireAuth, (req, res) => {
  const db = getDb();
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (full.totp_enabled && !verifyTotp(full.totp_secret, String((req.body || {}).code || ''))) {
    // allow password fallback
    if (!bcrypt.compareSync(String((req.body || {}).password || ''), full.password_hash)) {
      return res.status(400).json({ error: 'code or password required' });
    }
  }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user.id);
  audit(req, '2fa_disable', '');
  res.json({ ok: true });
});

// Own sessions
router.get('/sessions', requireAuth, (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ sessions: rows.map((r) => ({ ...r, current: r.id === req.sessionId })) });
});

router.delete('/sessions/:id', requireAuth, (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  audit(req, 'session_revoke', req.params.id);
  res.json({ ok: true });
});

module.exports = router;
