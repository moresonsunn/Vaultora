/** Admin user management. */
'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { getDb, getSetting } = require('../db');
const { requireAdmin, audit } = require('../middleware');
const { storageRoot, userHomeRel, trashRel } = require('../fsutil');

const router = express.Router();
router.use(requireAdmin);

function pub(u) {
  return {
    id: u.id, username: u.username, role: u.role,
    disabled: !!u.disabled, quota_bytes: u.quota_bytes,
    totp_enabled: !!u.totp_enabled, created_at: u.created_at, updated_at: u.updated_at,
  };
}

router.get('/', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users ORDER BY username').all().map(pub);
  res.json({ users });
});

router.post('/', (req, res) => {
  const db = getDb();
  const { username, password, role = 'user', quota_bytes = null } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9._-]{2,48}$/.test(name)) {
    return res.status(400).json({ error: 'username must be 2-48 chars: letters, digits, . _ -' });
  }
  const minLen = parseInt(getSetting(db, 'password_min_length', '8'), 10) || 8;
  if (String(password || '').length < minLen) {
    return res.status(400).json({ error: `password must be at least ${minLen} characters` });
  }
  if (role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'invalid role' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) {
    return res.status(409).json({ error: 'username exists' });
  }
  const id = uuidv4();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO users(id, username, password_hash, role, quota_bytes, created_at, updated_at) VALUES(?,?,?,?,?,?,?)').run(
    id, name, bcrypt.hashSync(String(password), 12), role,
    quota_bytes === '' || quota_bytes == null ? null : Number(quota_bytes), now, now
  );
  // create home + trash dirs
  const root = storageRoot();
  fs.mkdirSync(path.join(root, userHomeRel(name)), { recursive: true });
  fs.mkdirSync(path.join(root, trashRel(name)), { recursive: true });
  audit(req, 'user_create', `user=${name} role=${role}`);
  res.status(201).json({ user: pub(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
});

router.put('/:id', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const { role, quota_bytes, disabled } = req.body || {};
  if (role && role !== 'admin' && role !== 'user') return res.status(400).json({ error: 'invalid role' });
  if (u.username === req.user.username && disabled) {
    return res.status(400).json({ error: 'cannot disable yourself' });
  }
  db.prepare("UPDATE users SET role = COALESCE(?, role), quota_bytes = ?, disabled = COALESCE(?, disabled), updated_at = datetime('now') WHERE id = ?").run(
    role || null,
    quota_bytes === undefined ? u.quota_bytes : (quota_bytes === '' || quota_bytes == null ? null : Number(quota_bytes)),
    disabled === undefined ? null : (disabled ? 1 : 0),
    u.id
  );
  audit(req, 'user_update', `user=${u.username}`);
  res.json({ user: pub(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

router.post('/:id/password', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const minLen = parseInt(getSetting(db, 'password_min_length', '8'), 10) || 8;
  const { password } = req.body || {};
  if (String(password || '').length < minLen) {
    return res.status(400).json({ error: `password must be at least ${minLen} characters` });
  }
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(bcrypt.hashSync(String(password), 12), u.id);
  // invalidate all sessions for that user (admin password reset)
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  audit(req, 'password_reset', `user=${u.username}`);
  res.json({ ok: true });
});

router.post('/:id/disable', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.username === req.user.username) return res.status(400).json({ error: 'cannot disable yourself' });
  db.prepare("UPDATE users SET disabled = 1, updated_at = datetime('now') WHERE id = ?").run(u.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  audit(req, 'user_disable', `user=${u.username}`);
  res.json({ ok: true });
});

router.post('/:id/enable', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE users SET disabled = 0, updated_at = datetime('now') WHERE id = ?").run(u.id);
  audit(req, 'user_enable', `user=${u.username}`);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.username === req.user.username) return res.status(400).json({ error: 'cannot delete yourself' });
  const admins = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").get().c;
  if (u.role === 'admin' && admins <= 1) return res.status(400).json({ error: 'cannot delete the last admin' });
  const keep = String((req.query || {}).keep_files || '1') !== '0';
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  audit(req, 'user_delete', `user=${u.username} keep_files=${keep}`);
  res.json({ ok: true, note: keep ? 'filesystem data retained under /users/<username>' : 'remove user data manually if desired' });
});

// usage per user (du of home dir, fast walk with cap)
router.get('/:id/usage', async (req, res) => {
  const db = getDb();
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return res.status(404).json({ error: 'not found' });
  const { duDir } = require('./files-shared');
  const root = storageRoot();
  const home = path.join(root, userHomeRel(u.username));
  const { bytes, files } = await duDir(home, 200000);
  const quota = u.quota_bytes != null ? u.quota_bytes : (getSetting(db, 'default_quota_bytes', '') === '' ? null : Number(getSetting(db, 'default_quota_bytes', '')));
  res.json({ username: u.username, bytes, files, quota_bytes: quota });
});

module.exports = router;
