/** Admin: storage roots, settings, activity, sessions, maintenance. */
'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { getDb, getSetting, setSetting } = require('../db');
const { requireAdmin, audit } = require('../middleware');
const { storageRoot, sanitizeRel, assertInside } = require('../fsutil');
const { duDir } = require('./files-shared');

const router = express.Router();
router.use(requireAdmin);

// ---- Storage roots ----
router.get('/roots', (req, res) => {
  const db = getDb();
  const roots = db.prepare('SELECT * FROM storage_roots ORDER BY name').all();
  const out = roots.map((r) => ({
    ...r,
    users: db.prepare('SELECT x.user_id, u.username, x.permission FROM root_access x JOIN users u ON u.id = x.user_id WHERE x.root_id = ?').all(r.id),
  }));
  res.json({ roots: out, storage_root: storageRoot() });
});

router.post('/roots', async (req, res) => {
  const db = getDb();
  try {
    const { name, user_ids = [], permission = 'write' } = req.body || {};
    const clean = String(name || '').trim().replace(/[\\/]+/g, '');
    if (!/^[A-Za-z0-9 _.-]{2,64}$/.test(clean)) {
      return res.status(400).json({ error: 'name must be 2-64 chars (letters, digits, space, _ . -)' });
    }
    if (clean === 'My Files' || clean === 'users' || clean.startsWith('.')) {
      return res.status(400).json({ error: 'reserved name' });
    }
    if (!['read', 'write'].includes(permission)) return res.status(400).json({ error: 'invalid permission' });
    const rel = sanitizeRel(clean);
    const root = storageRoot();
    assertInside(root, path.join(root, rel));
    await fsp.mkdir(path.join(root, rel), { recursive: true });
    const { v4: uuidv4 } = require('uuid');
    const id = uuidv4();
    db.prepare('INSERT INTO storage_roots(id, name, rel_path, created_at) VALUES(?,?,?,datetime(\'now\'))').run(id, clean, rel);
    const grant = db.prepare('INSERT INTO root_access(root_id, user_id, permission) VALUES(?,?,?) ON CONFLICT(root_id, user_id) DO UPDATE SET permission=excluded.permission');
    for (const uid of user_ids) {
      if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) grant.run(id, uid, permission);
    }
    audit(req, 'root_create', clean);
    res.status(201).json({ root: db.prepare('SELECT * FROM storage_roots WHERE id = ?').get(id) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'name exists' });
    res.status(500).json({ error: e.message || 'create failed' });
  }
});

router.put('/roots/:id/access', (req, res) => {
  const db = getDb();
  const root = db.prepare('SELECT * FROM storage_roots WHERE id = ?').get(req.params.id);
  if (!root) return res.status(404).json({ error: 'not found' });
  const { user_ids = [], permission = 'write' } = req.body || {};
  if (!['read', 'write'].includes(permission)) return res.status(400).json({ error: 'invalid permission' });
  db.prepare('DELETE FROM root_access WHERE root_id = ?').run(root.id);
  const grant = db.prepare('INSERT INTO root_access(root_id, user_id, permission) VALUES(?,?,?)');
  for (const uid of user_ids) {
    if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(uid)) grant.run(root.id, uid, permission);
  }
  audit(req, 'root_access', `${root.name} users=${user_ids.length}`);
  res.json({ ok: true });
});

router.delete('/roots/:id', async (req, res) => {
  const db = getDb();
  const root = db.prepare('SELECT * FROM storage_roots WHERE id = ?').get(req.params.id);
  if (!root) return res.status(404).json({ error: 'not found' });
  const keep = String((req.query || {}).keep_files || '1') !== '0';
  db.prepare('DELETE FROM storage_roots WHERE id = ?').run(root.id);
  audit(req, 'root_delete', `${root.name} keep_files=${keep}`);
  res.json({ ok: true, note: keep ? `files retained on disk at ${root.rel_path}` : 'DB entry removed; files untouched (delete manually if desired)' });
});

// ---- Settings ----
const EDITABLE = new Set([
  'app_url', 'session_ttl_hours', 'max_file_size_bytes', 'default_quota_bytes',
  'trash_retention_days', 'trash_enabled', 'share_default_expiry_days',
  'share_require_password', 'password_min_length', 'login_max_attempts',
  'login_window_minutes', 'clamav_enabled', 'clamav_host', 'clamav_port',
]);

router.get('/settings', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) obj[r.key] = r.value;
  res.json({ settings: obj, storage_root: storageRoot(), port: process.env.PORT || '8080', uid: process.env.PUID || '', gid: process.env.PGID || '', tz: process.env.TZ || '', version: process.env.APP_VERSION || 'dev', commit: (process.env.GIT_COMMIT || '').slice(0, 12) || null });
});

router.put('/settings', (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const updated = [];
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE.has(k)) continue;
    setSetting(db, k, v === null || v === undefined ? '' : String(v));
    updated.push(k);
  }
  audit(req, 'settings_update', updated.join(','));
  res.json({ ok: true, updated });
});

// ---- Activity / audit ----
router.get('/activity', (req, res) => {
  const db = getDb();
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const action = req.query.action ? String(req.query.action) : null;
  let rows;
  if (action) {
    rows = db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(action, limit, offset);
  } else {
    rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  }
  const total = db.prepare('SELECT COUNT(*) AS c FROM audit_log').get().c;
  res.json({ items: rows, total });
});

// ---- Sessions (all users) ----
router.get('/sessions', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT s.id, s.user_id, u.username, s.created_at, s.expires_at, s.ip FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC LIMIT 200').all();
  res.json({ sessions: rows });
});

router.delete('/sessions/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.params.id);
  audit(req, 'session_revoke_admin', req.params.id);
  res.json({ ok: true });
});

// ---- Storage overview ----
router.get('/storage', async (req, res) => {
  const db = getDb();
  const root = storageRoot();
  const roots = db.prepare('SELECT * FROM storage_roots ORDER BY name').all();
  const out = [];
  for (const r of roots) {
    const du = await duDir(path.join(root, r.rel_path), 50000);
    out.push({ name: r.name, rel_path: r.rel_path, bytes: du.bytes, files: du.files, truncated: !!du.truncated });
  }
  // users dir
  const usersDu = await duDir(path.join(root, 'users'), 50000).catch(() => ({ bytes: 0, files: 0 }));
  res.json({ storage_root: root, roots: out, users_total: usersDu });
});

// ---- Maintenance: trash auto-cleanup (also runs on a timer in index.js) ----
async function runTrashCleanup(db) {
  const days = parseInt(getSetting(db, 'trash_retention_days', '30'), 10);
  if (!Number.isFinite(days) || days < 0) return { cleaned: 0 };
  if (getSetting(db, 'trash_enabled', '1') !== '1') return { cleaned: 0, disabled: true };
  const cutoff = Date.now() - days * 86400 * 1000;
  const root = storageRoot();
  const trashBase = path.join(root, '.trash');
  let cleaned = 0;
  let users;
  try { users = await fsp.readdir(trashBase); } catch { return { cleaned: 0 }; }
  for (const u of users) {
    const udir = path.join(trashBase, u);
    let entries;
    try { entries = await fsp.readdir(udir); } catch { continue; }
    for (const e of entries) {
      if (e.endsWith('.origin.json')) continue;
      const p = path.join(udir, e);
      try {
        const st = await fsp.stat(p);
        if (st.mtime.getTime() < cutoff) {
          await fsp.rm(p, { recursive: true, force: true });
          await fsp.rm(p + '.origin.json', { force: true });
          cleaned++;
        }
      } catch { /* ignore */ }
    }
  }
  return { cleaned };
}

router.post('/maintenance/trash-cleanup', async (req, res) => {
  const db = getDb();
  const r = await runTrashCleanup(db);
  audit(req, 'trash_cleanup', `cleaned=${r.cleaned}`);
  res.json(r);
});

module.exports = { router, runTrashCleanup };
