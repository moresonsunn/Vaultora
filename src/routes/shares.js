/** Share links: create/list/update/delete + public access (no login). */
'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const bcrypt = require('bcryptjs');
const mime = require('mime-types');
const { v4: uuidv4 } = require('uuid');
const { getDb, getSetting } = require('../db');
const { requireAuth, audit } = require('../middleware');
const { storageRoot, resolveVPath, realpathGuard, statSafe, kindOf, randomToken } = require('../fsutil');

const router = express.Router();

function shareUrl(req, token) {
  const db = getDb();
  const base = (getSetting(db, 'app_url', '') || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  return `${base}/s/${token}`;
}

// ---- authed management ----
router.use('/api/shares', requireAuth);

async function listDirNames(abs) {
  const out = [];
  for (const e of await fsp.readdir(abs, { withFileTypes: true })) {
    const st = await fsp.stat(path.join(abs, e.name)).catch(() => null);
    if (!st) continue;
    out.push({ name: e.name, is_dir: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() });
  }
  return out;
}

// NOTE: routes are mounted at /api/shares (see index.js), paths below are relative.
const mgmt = express.Router();
mgmt.use(requireAuth);

mgmt.post('/', async (req, res) => {
  const db = getDb();
  try {
    const { path: vpath, password = null, expires_at = null, max_downloads = null } = req.body || {};
    if (!vpath) return res.status(400).json({ error: 'path required' });
    const r = resolveVPath(db, req.user, vpath);
    const abs = await realpathGuard(r.physAbs);
    const st = await statSafe(abs);
    if (!st) return res.status(404).json({ error: 'not found' });
    // share creation requires read access (resolve already enforces); write not needed
    let exp = null;
    if (expires_at) {
      exp = new Date(expires_at);
      if (Number.isNaN(exp.getTime())) return res.status(400).json({ error: 'invalid expires_at' });
      if (exp.getTime() < Date.now()) return res.status(400).json({ error: 'expiration must be in the future' });
    } else {
      const defDays = getSetting(db, 'share_default_expiry_days', '');
      if (defDays !== '' && Number.isFinite(Number(defDays)) && Number(defDays) > 0) {
        exp = new Date(Date.now() + Number(defDays) * 86400 * 1000);
      }
    }
    const requirePw = getSetting(db, 'share_require_password', '0') === '1';
    if (requirePw && !password) return res.status(400).json({ error: 'password required by policy' });
    const id = uuidv4();
    const token = randomToken(12);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO shares(id, token, owner_id, vpath, phys_rel, is_dir, password_hash, expires_at, max_downloads, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      id, token, req.user.id, r.vpath, r.physRel, st.isDirectory() ? 1 : 0,
      password ? bcrypt.hashSync(String(password), 10) : null,
      exp ? exp.toISOString() : null,
      max_downloads != null && max_downloads !== '' ? Number(max_downloads) : null,
      now
    );
    audit(req, 'share_create', `${r.vpath} token=${token}`);
    const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(id);
    res.status(201).json({ share: toJson(req, row) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'share failed' });
  }
});

function toJson(req, row) {
  return {
    id: row.id, token: row.token, url: shareUrl(req, row.token),
    vpath: row.vpath, is_dir: !!row.is_dir,
    has_password: !!row.password_hash,
    expires_at: row.expires_at, max_downloads: row.max_downloads,
    download_count: row.download_count, disabled: !!row.disabled,
    created_at: row.created_at,
  };
}

mgmt.get('/', (req, res) => {
  const db = getDb();
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT s.*, u.username AS owner FROM shares s JOIN users u ON u.id = s.owner_id ORDER BY s.created_at DESC').all()
    : db.prepare('SELECT s.*, u.username AS owner FROM shares s JOIN users u ON u.id = s.owner_id WHERE s.owner_id = ? ORDER BY s.created_at DESC').all(req.user.id);
  res.json({ shares: rows.map((r) => ({ ...toJson(req, r), owner: r.owner })) });
});

mgmt.patch('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'admin' && row.owner_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const { disabled, max_downloads, expires_at, password } = req.body || {};
  db.prepare('UPDATE shares SET disabled = COALESCE(?, disabled), max_downloads = ?, expires_at = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?').run(
    disabled === undefined ? null : (disabled ? 1 : 0),
    max_downloads === undefined ? row.max_downloads : (max_downloads === '' || max_downloads == null ? null : Number(max_downloads)),
    expires_at === undefined ? row.expires_at : (expires_at ? new Date(expires_at).toISOString() : null),
    password ? bcrypt.hashSync(String(password), 10) : null,
    row.id
  );
  if (password === '') db.prepare('UPDATE shares SET password_hash = NULL WHERE id = ?').run(row.id);
  audit(req, 'share_update', row.token);
  res.json({ share: toJson(req, db.prepare('SELECT * FROM shares WHERE id = ?').get(row.id)) });
});

mgmt.post('/:id/regenerate', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'admin' && row.owner_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const token = randomToken(12);
  db.prepare('UPDATE shares SET token = ?, download_count = 0 WHERE id = ?').run(token, row.id);
  audit(req, 'share_regenerate', `${row.token} -> ${token}`);
  res.json({ share: toJson(req, db.prepare('SELECT * FROM shares WHERE id = ?').get(row.id)) });
});

mgmt.delete('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  if (req.user.role !== 'admin' && row.owner_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM shares WHERE id = ?').run(row.id);
  audit(req, 'share_delete', row.token);
  res.json({ ok: true });
});

// ---- public access (no auth, token in URL; filesystem path never exposed) ----
function getValidShare(token) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
  if (!row || row.disabled) return { error: 'link disabled or not found', status: 404 };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return { error: 'link expired', status: 410 };
  if (row.max_downloads != null && row.download_count >= row.max_downloads) return { error: 'download limit reached', status: 410 };
  return { row, db };
}

function checkSharePassword(row, req) {
  if (!row.password_hash) return true;
  const pw = req.query.password ?? req.body?.password ?? req.get('x-share-password') ?? '';
  if (!pw) return false;
  return bcrypt.compareSync(String(pw), row.password_hash);
}

const pub = express.Router();
// JSON metadata for the /s/ page
pub.get('/api/public/:token', async (req, res) => {
  const { row, db, error, status } = getValidShare(req.params.token);
  if (error) return res.status(status).json({ error });
  if (!checkSharePassword(row, req)) return res.status(401).json({ error: 'password required', need_password: true });
  const abs = path.join(storageRoot(), row.phys_rel);
  const st = await statSafe(abs);
  if (!st) return res.status(410).json({ error: 'source removed' });
  const isDir = !!row.is_dir;
  let children = [];
  if (isDir) {
    try { children = await listDirNames(abs); } catch { /* ignore */ }
  }
  res.json({
    name: path.basename(row.vpath),
    is_dir: isDir,
    size: isDir ? 0 : st.size,
    mtime: st.mtime.toISOString(),
    kind: kindOf(path.basename(row.vpath), isDir),
    mime: isDir ? null : (mime.lookup(row.vpath) || 'application/octet-stream'),
    children: children.slice(0, 500),
    has_password: !!row.password_hash,
  });
});

// Download file OR single file inside a folder share (?file=name)
pub.get('/api/public/:token/download', async (req, res) => {
  const { row, db, error, status } = getValidShare(req.params.token);
  if (error) return res.status(status).json({ error });
  if (!checkSharePassword(row, req)) return res.status(401).json({ error: 'password required' });
  let abs = path.join(storageRoot(), row.phys_rel);
  if (row.is_dir) {
    const sub = String(req.query.file || '');
    if (!sub || sub.includes('/') || sub.includes('\\') || sub.includes('\0') || sub === '..') {
      return res.status(400).json({ error: 'file query required for folder shares' });
    }
    abs = path.join(abs, sub);
  }
  let guarded;
  try { guarded = await realpathGuard(abs); } catch { return res.status(404).json({ error: 'not found' }); }
  // must stay inside the shared root
  const shareBase = await realpathGuard(path.join(storageRoot(), row.phys_rel)).catch(() => null);
  if (!shareBase || !(guarded === shareBase || guarded.startsWith(shareBase + path.sep))) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const st = await statSafe(guarded);
  if (!st || st.isDirectory()) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE shares SET download_count = download_count + 1 WHERE id = ?').run(row.id);
  try {
    db.prepare("INSERT INTO audit_log(at, user_id, username, action, detail) VALUES(datetime('now'), ?, (SELECT username FROM users WHERE id = ?), 'share_access', ?)").run(row.owner_id, row.owner_id, `token=${row.token} file=${path.basename(guarded)}`);
  } catch { /* ignore */ }
  res.setHeader('Content-Type', mime.lookup(guarded) || 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(guarded))}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(guarded).pipe(res);
});

// Inline preview for public shares (images/video/pdf stream; text capped)
pub.get('/api/public/:token/preview', async (req, res) => {
  const { row, error, status } = getValidShare(req.params.token);
  if (error) return res.status(status).json({ error });
  if (!checkSharePassword(row, req)) return res.status(401).json({ error: 'password required' });
  let abs = path.join(storageRoot(), row.phys_rel);
  if (row.is_dir) {
    const sub = String(req.query.file || '');
    if (!sub || /[/\\]/.test(sub)) return res.status(400).json({ error: 'file query required' });
    abs = path.join(abs, sub);
  }
  let guarded;
  try { guarded = await realpathGuard(abs); } catch { return res.status(404).json({ error: 'not found' }); }
  const st = await statSafe(guarded);
  if (!st || st.isDirectory()) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', mime.lookup(guarded) || 'application/octet-stream');
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(guarded))}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(guarded).pipe(res);
});

module.exports = { mgmt, pub };
