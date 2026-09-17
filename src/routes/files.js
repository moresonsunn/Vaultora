/** File manager routes: list/mkdir/rename/move/copy/delete/download/preview/bulk/trash/starred/recent. */
'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const mime = require('mime-types');
const { getDb, getSetting } = require('../db');
const { requireAuth, audit } = require('../middleware');
const {
  storageRoot, ensureStorageLayout, userHomeRel, trashRel,
  safeSegment, sanitizeRel, resolveVPath, assertCanWrite, realpathGuard, statSafe, kindOf,
} = require('../fsutil');
const { effectiveQuota, userUsageBytes, duDir } = require('./files-shared');

const router = express.Router();
router.use(requireAuth);

// Ensure home dirs exist lazily
router.use((req, res, next) => {
  try {
    ensureStorageLayout();
    const root = storageRoot();
    fs.mkdirSync(path.join(root, userHomeRel(req.user.username)), { recursive: true });
    fs.mkdirSync(path.join(root, trashRel(req.user.username)), { recursive: true });
  } catch { /* ignore */ }
  next();
});

async function listDir(abs) {
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name === '.DS_Store' || e.name === 'Thumbs.db') continue;
    const p = path.join(abs, e.name);
    let st = null;
    try { st = await fsp.stat(p); } catch { continue; }
    const isDir = st.isDirectory();
    out.push({
      name: e.name,
      is_dir: isDir,
      size: isDir ? 0 : st.size,
      mtime: st.mtime.toISOString(),
      kind: kindOf(e.name, isDir),
      mime: isDir ? null : (mime.lookup(e.name) || 'application/octet-stream'),
    });
  }
  return out;
}

function sortEntries(items, sort = 'name', order = 'asc') {
  const dir = order === 'desc' ? -1 : 1;
  const key = {
    name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
    size: (a, b) => a.size - b.size,
    date: (a, b) => new Date(a.mtime) - new Date(b.mtime),
    type: (a, b) => String(a.kind).localeCompare(String(b.kind)) || a.name.localeCompare(b.name),
  }[sort] || ((a, b) => a.name.localeCompare(b.name));
  // folders first (like Drive)
  return items.sort((a, b) => (Number(b.is_dir) - Number(a.is_dir)) || dir * key(a, b));
}

// GET /api/files/shared-roots — names of shared roots visible to the caller
router.get('/shared-roots', (req, res) => {
  const db = getDb();
  const rows = req.user.role === 'admin'
    ? db.prepare('SELECT name FROM storage_roots ORDER BY name').all()
    : db.prepare('SELECT r.name FROM storage_roots r JOIN root_access x ON x.root_id = r.id WHERE x.user_id = ? ORDER BY r.name').all(req.user.id);
  res.json({ roots: rows.map((r) => r.name) });
});

// GET /api/files?path=/My Files/a&sort=name&order=asc
router.get('/', async (req, res) => {
  const db = getDb();
  try {
    const r = resolveVPath(db, req.user, req.query.path || '/My Files');
    const abs = await realpathGuard(r.physAbs);
    const st = await statSafe(abs);
    if (!st) {
      // auto-create home root listing as empty
      await fsp.mkdir(abs, { recursive: true });
      return res.json({ path: r.vpath, items: [], writable: true });
    }
    if (!st.isDirectory()) return res.status(400).json({ error: 'not a folder' });
    let items = await listDir(abs);
    // annotate starred
    const stars = new Set(
      db.prepare('SELECT vpath FROM starred WHERE user_id = ?').all(req.user.id).map((x) => x.vpath)
    );
    items = items.map((it) => ({
      ...it,
      vpath: path.posix.join(r.vpath, it.name),
      starred: stars.has(path.posix.join(r.vpath, it.name)),
    }));
    items = sortEntries(items, req.query.sort, req.query.order);
    let writable = true;
    try { assertCanWrite(db, req.user, r); } catch { writable = false; }
    res.json({ path: r.vpath, items, writable });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'list failed' });
  }
});

// POST /api/files/mkdir {path, name}
router.post('/mkdir', async (req, res) => {
  const db = getDb();
  try {
    const { path: dirPath, name } = req.body || {};
    const r = resolveVPath(db, req.user, dirPath || '/My Files');
    assertCanWrite(db, req.user, r);
    const seg = safeSegment(name);
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    const abs = await realpathGuard(path.join(r.physAbs, seg));
    await fsp.mkdir(abs, { recursive: true });
    audit(req, 'mkdir', `${r.vpath}/${seg}`);
    res.status(201).json({ ok: true, name: seg });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'mkdir failed' });
  }
});

async function moveToTrash(db, user, vpath) {
  const r = resolveVPath(db, user, vpath);
  assertCanWrite(db, user, r);
  const abs = await realpathGuard(r.physAbs);
  const st = await statSafe(abs);
  if (!st) { const e = new Error('not found'); e.status = 404; throw e; }
  const root = storageRoot();
  const trashBase = path.join(root, trashRel(user.username));
  await fsp.mkdir(trashBase, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trashBase, `${path.basename(abs)}.__del_${stamp}`);
  await fsp.rename(abs, dest);
  // sidecar with original location for restore
  await fsp.writeFile(dest + '.origin.json', JSON.stringify({ vpath: r.vpath, at: new Date().toISOString() }));
  return { trashed: path.basename(dest), origin: r.vpath };
}

// POST /api/files/rename {path, name}
router.post('/rename', async (req, res) => {
  const db = getDb();
  try {
    const { path: src, name } = req.body || {};
    if (!src || !name) return res.status(400).json({ error: 'path and name required' });
    const r = resolveVPath(db, req.user, src);
    assertCanWrite(db, req.user, r);
    const seg = safeSegment(name);
    const abs = await realpathGuard(r.physAbs);
    if (!(await statSafe(abs))) return res.status(404).json({ error: 'not found' });
    const destAbs = await realpathGuard(path.join(path.dirname(abs), seg));
    if (await statSafe(destAbs)) return res.status(409).json({ error: 'destination exists' });
    await fsp.rename(abs, destAbs);
    // fix stars pointing at old path
    db.prepare('UPDATE starred SET vpath = ? WHERE user_id = ? AND vpath = ?').run(
      path.posix.join(path.posix.dirname(r.vpath), seg), req.user.id, r.vpath
    );
    audit(req, 'rename', `${r.vpath} -> ${seg}`);
    res.json({ ok: true, name: seg });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'rename failed' });
  }
});

// POST /api/files/move {paths[], dest}  POST /api/files/copy {paths[], dest}
async function copyRecursive(src, dest) {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    for (const e of await fsp.readdir(src)) {
      await copyRecursive(path.join(src, e), path.join(dest, e));
    }
  } else {
    await fsp.copyFile(src, dest);
  }
}

async function handleMoveCopy(db, user, req, res, mode) {
  try {
    const { paths = [], dest } = req.body || {};
    if (!Array.isArray(paths) || !paths.length || !dest) {
      return res.status(400).json({ error: 'paths[] and dest required' });
    }
    if (paths.length > 200) return res.status(400).json({ error: 'too many items (max 200)' });
    const d = resolveVPath(db, user, dest);
    assertCanWrite(db, user, d);
    const destAbs = await realpathGuard(d.physAbs);
    await fsp.mkdir(destAbs, { recursive: true });
    const results = [];
    for (const p of paths) {
      try {
        const s = resolveVPath(db, user, p);
        // moving across permission boundaries requires write on source too
        assertCanWrite(db, user, s);
        const sAbs = await realpathGuard(s.physAbs);
        const base = path.basename(sAbs);
        const tAbs = await realpathGuard(path.join(destAbs, base));
        // prevent moving a folder into itself
        if (tAbs === sAbs || tAbs.startsWith(sAbs + path.sep)) {
          results.push({ path: p, ok: false, error: 'cannot move a folder into itself' });
          continue;
        }
        if (await statSafe(tAbs)) {
          results.push({ path: p, ok: false, error: 'destination exists' });
          continue;
        }
        if (mode === 'move') await fsp.rename(sAbs, tAbs);
        else await copyRecursive(sAbs, tAbs);
        results.push({ path: p, ok: true });
      } catch (e) {
        results.push({ path: p, ok: false, error: e.message });
      }
    }
    audit(req, mode, `${paths.length} items -> ${d.vpath}`);
    res.json({ results });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || `${mode} failed` });
  }
}
router.post('/move', (req, res) => handleMoveCopy(getDb(), req.user, req, res, 'move'));
router.post('/copy', (req, res) => handleMoveCopy(getDb(), req.user, req, res, 'copy'));

// POST /api/files/delete {paths[], permanent?}
router.post('/delete', async (req, res) => {
  const db = getDb();
  try {
    const { paths = [], permanent = false } = req.body || {};
    if (!Array.isArray(paths) || !paths.length) return res.status(400).json({ error: 'paths[] required' });
    const trashEnabled = getSetting(db, 'trash_enabled', '1') === '1';
    const results = [];
    for (const p of paths.slice(0, 200)) {
      try {
        if (trashEnabled && !permanent) {
          const t = await moveToTrash(db, req.user, p);
          results.push({ path: p, ok: true, trash: t.trashed });
        } else {
          const r = resolveVPath(db, req.user, p);
          assertCanWrite(db, req.user, r);
          const abs = await realpathGuard(r.physAbs);
          await fsp.rm(abs, { recursive: true, force: true });
          db.prepare('DELETE FROM starred WHERE user_id = ? AND vpath = ?').run(req.user.id, r.vpath);
          results.push({ path: p, ok: true, permanent: true });
        }
      } catch (e) {
        results.push({ path: p, ok: false, error: e.message });
      }
    }
    audit(req, 'delete', `${paths.length} items permanent=${!!permanent}`);
    res.json({ results });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'delete failed' });
  }
});

// ---- Trash ----
router.get('/trash', async (req, res) => {
  try {
    const root = storageRoot();
    const base = path.join(root, trashRel(req.user.username));
    await fsp.mkdir(base, { recursive: true });
    const entries = await fsp.readdir(base, { withFileTypes: true });
    const items = [];
    for (const e of entries) {
      if (e.name.endsWith('.origin.json')) continue;
      const p = path.join(base, e.name);
      let st = null;
      try { st = await fsp.stat(p); } catch { continue; }
      let origin = null;
      try { origin = JSON.parse(await fsp.readFile(p + '.origin.json', 'utf8')); } catch { /* ignore */ }
      // original display name strips the .__del_ suffix
      const display = e.name.replace(/\.__del_.*$/, '');
      items.push({
        name: display, trash_id: e.name, is_dir: st.isDirectory(),
        size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString(),
        origin: origin ? origin.vpath : null, deleted_at: origin ? origin.at : st.mtime.toISOString(),
      });
    }
    items.sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: 'trash list failed' });
  }
});

router.post('/trash/restore', async (req, res) => {
  const db = getDb();
  try {
    const { ids = [] } = req.body || {};
    const root = storageRoot();
    const base = path.join(root, trashRel(req.user.username));
    const results = [];
    for (const id of ids.slice(0, 200)) {
      try {
        if (String(id).includes('/') || String(id).includes('\\') || String(id).includes('\0')) {
          throw new Error('invalid trash id');
        }
        const src = path.join(base, String(id));
        if (!(await statSafe(src))) throw new Error('not found');
        let origin = null;
        try { origin = JSON.parse(await fsp.readFile(src + '.origin.json', 'utf8')); } catch { /* ignore */ }
        let destAbs;
        if (origin && origin.vpath) {
          try {
            const r = resolveVPath(db, req.user, path.posix.dirname(origin.vpath));
            assertCanWrite(db, req.user, r);
            destAbs = await realpathGuard(path.join(r.physAbs, safeSegment(path.basename(origin.vpath))));
          } catch {
            const home = resolveVPath(db, req.user, '/My Files');
            destAbs = await realpathGuard(path.join(home.physAbs, safeSegment(String(id).replace(/\.__del_.*$/, ''))));
          }
        } else {
          const home = resolveVPath(db, req.user, '/My Files');
          destAbs = await realpathGuard(path.join(home.physAbs, safeSegment(String(id).replace(/\.__del_.*$/, ''))));
        }
        // avoid overwrite: suffix (restored)
        let finalDest = destAbs;
        let n = 1;
        while (await statSafe(finalDest)) {
          const ext = path.extname(destAbs);
          finalDest = destAbs.slice(0, destAbs.length - ext.length) + ` (restored ${n++})` + ext;
        }
        await fsp.rename(src, finalDest);
        await fsp.rm(src + '.origin.json', { force: true });
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    audit(req, 'trash_restore', `${ids.length} items`);
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: 'restore failed' });
  }
});

router.post('/trash/empty', async (req, res) => {
  try {
    const root = storageRoot();
    const base = path.join(root, trashRel(req.user.username));
    await fsp.mkdir(base, { recursive: true });
    for (const e of await fsp.readdir(base)) {
      await fsp.rm(path.join(base, e), { recursive: true, force: true });
    }
    audit(req, 'trash_empty', '');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'empty trash failed' });
  }
});

router.post('/trash/delete', async (req, res) => {
  try {
    const { ids = [] } = req.body || {};
    const root = storageRoot();
    const base = path.join(root, trashRel(req.user.username));
    for (const id of ids.slice(0, 200)) {
      if (String(id).includes('/') || String(id).includes('\\')) continue;
      await fsp.rm(path.join(base, String(id)), { recursive: true, force: true });
      await fsp.rm(path.join(base, String(id)) + '.origin.json', { force: true });
    }
    audit(req, 'trash_delete', `${ids.length} items`);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'delete failed' });
  }
});

// ---- Starred ----
router.get('/starred', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT vpath, created_at FROM starred WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({ items: rows });
});

router.post('/star', (req, res) => {
  const db = getDb();
  const { path: p, starred } = req.body || {};
  if (!p) return res.status(400).json({ error: 'path required' });
  // validate the path resolves (permission check)
  try { resolveVPath(db, req.user, p); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (starred === false) {
    db.prepare('DELETE FROM starred WHERE user_id = ? AND vpath = ?').run(req.user.id, p);
  } else {
    db.prepare('INSERT INTO starred(user_id, vpath, created_at) VALUES(?,?,datetime(\'now\')) ON CONFLICT(user_id, vpath) DO NOTHING').run(req.user.id, p);
  }
  res.json({ ok: true });
});

// ---- Recent (mtime-ordered walk, capped — no full-filesystem scan daemon) ----
router.get('/recent', async (req, res) => {
  const db = getDb();
  try {
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const candidates = [];
    const home = resolveVPath(db, req.user, '/My Files');
    candidates.push({ vbase: '/My Files', abs: home.physAbs });
    if (req.user.role === 'admin') {
      for (const r of db.prepare('SELECT * FROM storage_roots').all()) {
        candidates.push({ vbase: '/' + r.name, abs: path.join(storageRoot(), r.rel_path) });
      }
    } else {
      for (const a of db.prepare('SELECT r.* FROM storage_roots r JOIN root_access x ON x.root_id = r.id WHERE x.user_id = ?').all(req.user.id)) {
        candidates.push({ vbase: '/' + a.name, abs: path.join(storageRoot(), a.rel_path) });
      }
    }
    const found = [];
    for (const c of candidates) {
      // shallow-ish walk: depth 4, cap 3000 files per root
      const stack = [{ abs: c.abs, depth: 0 }];
      let seen = 0;
      while (stack.length && found.length < limit * 4 && seen < 3000) {
        const { abs, depth } = stack.pop();
        let entries;
        try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (++seen > 3000) break;
          const p = path.join(abs, e.name);
          try {
            const st = await fsp.stat(p);
            const rel = path.relative(c.abs, p).split(path.sep).join('/');
            const vpath = rel ? c.vbase + '/' + rel : c.vbase;
            if (st.isDirectory()) {
              if (depth < 4) stack.push({ abs: p, depth: depth + 1 });
            } else {
              found.push({ vpath, name: e.name, size: st.size, mtime: st.mtime.toISOString(), kind: kindOf(e.name, false) });
            }
          } catch { /* ignore */ }
        }
      }
    }
    found.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json({ items: found.slice(0, limit) });
  } catch {
    res.status(500).json({ error: 'recent failed' });
  }
});

// ---- Download (streaming, never loads whole file into RAM) ----
router.get('/download', async (req, res) => {
  const db = getDb();
  try {
    const r = resolveVPath(db, req.user, req.query.path);
    const abs = await realpathGuard(r.physAbs);
    const st = await statSafe(abs);
    if (!st || st.isDirectory()) return res.status(404).json({ error: 'file not found' });
    const filename = path.basename(abs);
    res.setHeader('Content-Type', mime.lookup(filename) || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    // Range support for large files / resume
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
        let end = m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= st.size) {
          res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }
    }
    fs.createReadStream(abs).pipe(res);
    audit(req, 'download', r.vpath);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'download failed' });
  }
});

// ---- Inline preview/file content (permission-checked; text capped at 512KB) ----
const PREVIEW_TEXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml', '.toml', '.ini', '.xml', '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.css', '.html', '.sh', '.sql', '.vue', '.env', '.gitignore', '.dockerfile']);
router.get('/preview', async (req, res) => {
  const db = getDb();
  try {
    const r = resolveVPath(db, req.user, req.query.path);
    const abs = await realpathGuard(r.physAbs);
    const st = await statSafe(abs);
    if (!st || st.isDirectory()) return res.status(404).json({ error: 'file not found' });
    const ext = path.extname(abs).toLowerCase();
    if (st.size > 100 * 1024 * 1024 && !['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.mp3', '.wav', '.ogg', '.pdf'].includes(ext)) {
      return res.status(413).json({ error: 'file too large to preview — download instead' });
    }
    if (PREVIEW_TEXT.has(ext) || ext === '') {
      // stream first 512KB as text
      const stream = fs.createReadStream(abs, { start: 0, end: 512 * 1024 - 1, encoding: 'utf8' });
      let text = '';
      for await (const chunk of stream) text += chunk;
      return res.json({ type: 'text', truncated: st.size > 512 * 1024, text, size: st.size });
    }
    // images/video/audio/pdf stream inline with correct disposition
    res.setHeader('Content-Type', mime.lookup(abs) || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] === '' ? 0 : parseInt(m[1], 10);
        const end = m[2] === '' ? st.size - 1 : parseInt(m[2], 10);
        if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end && end < st.size) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
          res.setHeader('Content-Length', end - start + 1);
          fs.createReadStream(abs, { start, end }).pipe(res);
          return;
        }
      }
    }
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'preview failed' });
  }
});

// metadata for unsupported types
router.get('/stat', async (req, res) => {
  const db = getDb();
  try {
    const r = resolveVPath(db, req.user, req.query.path);
    const abs = await realpathGuard(r.physAbs);
    const st = await statSafe(abs);
    if (!st) return res.status(404).json({ error: 'not found' });
    res.json({
      vpath: r.vpath, name: path.basename(abs), is_dir: st.isDirectory(),
      size: st.size, mtime: st.mtime.toISOString(), birthtime: st.birthtime.toISOString(),
      kind: kindOf(path.basename(abs), st.isDirectory()),
      mime: st.isDirectory() ? null : (mime.lookup(abs) || 'application/octet-stream'),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'stat failed' });
  }
});

// ---- Bulk download (zip generated on the fly — streams, no RAM blowup) ----
router.post('/bulk-download', async (req, res) => {
  const db = getDb();
  try {
    const { paths = [] } = req.body || {};
    if (!Array.isArray(paths) || !paths.length || paths.length > 100) {
      return res.status(400).json({ error: 'provide 1-100 paths' });
    }
    // Minimal store-only zip writer (no compression, no extra deps).
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="vaultora-download.zip"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const useCrc = require('crypto');
    const entries = [];
    async function* walk(vp, abs, zipPath) {
      const st = await statSafe(abs);
      if (!st) return;
      if (st.isDirectory()) {
        yield { dir: zipPath + '/' };
        for (const e of await fsp.readdir(abs)) {
          yield* walk(vp + '/' + e, path.join(abs, e), zipPath + '/' + e);
        }
      } else {
        yield { file: abs, zipPath, size: st.size };
      }
    }
    const fileList = [];
    for (const p of paths) {
      try {
        const r = resolveVPath(db, req.user, p);
        const abs = await realpathGuard(r.physAbs);
        const base = path.basename(abs);
        for await (const it of walk(p, abs, base)) {
          fileList.push(it);
          if (fileList.length > 2000) break;
        }
      } catch { /* skip forbidden */ }
    }
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })();
    function crcOf(buf) {
      let c = 0xffffffff;
      for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    }
    let offset = 0;
    const central = [];
    const enc = (s) => Buffer.from(s, 'utf8');
    for (const it of fileList) {
      if (it.dir) {
        const nameBuf = enc(it.dir);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 8);
        lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt16LE(0, 14);
        lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22); lh.writeUInt32LE(0, 26);
        lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
        res.write(lh); res.write(nameBuf); offset += 30 + nameBuf.length;
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6);
        ch.writeUInt16LE(0x0808, 8); ch.writeUInt16LE(0x10, 38);
        ch.writeUInt32LE(offset - 30 - nameBuf.length, 42);
        ch.writeUInt16LE(nameBuf.length, 28);
        central.push({ buf: ch, name: nameBuf });
        continue;
      }
      const nameBuf = enc(it.file ? it.zipPath : 'file');
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0808, 8); // utf8 + data-descriptor: sizes follow the data (streaming)
      lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt16LE(0, 14);
      lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
      res.write(lh); res.write(nameBuf); offset += 30 + nameBuf.length;
      const fh = await fsp.open(it.file, 'r');
      let crc = 0xffffffff;
      let size = 0;
      try {
        const buf = Buffer.alloc(1024 * 256);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length);
          if (!bytesRead) break;
          const slice = buf.subarray(0, bytesRead);
          for (const b of slice) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
          size += bytesRead;
          if (!res.write(slice)) await new Promise((r2) => res.once('drain', r2));
          offset += bytesRead;
        }
      } finally { await fh.close(); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const dd = Buffer.alloc(12);
      dd.writeUInt32LE(crc, 0); dd.writeUInt32LE(size, 4); dd.writeUInt32LE(size, 8);
      res.write(dd); offset += 12;
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0808, 8); ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(size, 20); ch.writeUInt32LE(size, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt32LE(offset - size - 12 - 30 - nameBuf.length, 42);
      central.push({ buf: ch, name: nameBuf });
      void useCrc; void entries; void crcOf;
    }
    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) {
      res.write(c.buf); res.write(c.name); offset += 46 + c.name.length; cdSize += 46 + c.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
    res.write(end);
    res.end();
    audit(req, 'bulk_download', `${paths.length} roots`);
  } catch (e) {
    try { res.status(500).json({ error: 'bulk download failed' }); } catch { /* headers sent */ }
  }
});

// ---- Storage usage (own) ----
router.get('/usage', async (req, res) => {
  const db = getDb();
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const used = await userUsageBytes(db, req.user.username);
  const quota = effectiveQuota(db, full);
  res.json({ used_bytes: used, quota_bytes: quota, unlimited: quota == null });
});

// ---- Search (recursive, capped walk — no background indexer) ----
router.get('/search', async (req, res) => {
  const db = getDb();
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ items: [] });
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
    const bases = [];
    const home = resolveVPath(db, req.user, '/My Files');
    bases.push({ vbase: '/My Files', abs: home.physAbs });
    const roots = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM storage_roots').all()
      : db.prepare('SELECT r.* FROM storage_roots r JOIN root_access x ON x.root_id = r.id WHERE x.user_id = ?').all(req.user.id);
    for (const r of roots) bases.push({ vbase: '/' + r.name, abs: path.join(storageRoot(), r.rel_path) });
    const out = [];
    for (const b of bases) {
      const stack = [b.abs];
      let seen = 0;
      while (stack.length && out.length < limit && seen < 8000) {
        const dir = stack.pop();
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          if (++seen > 8000) break;
          const p = path.join(dir, e.name);
          const rel = path.relative(b.abs, p).split(path.sep).join('/');
          const vpath = rel ? b.vbase + '/' + rel : b.vbase;
          if (e.name.toLowerCase().includes(q)) {
            try {
              const st = await fsp.stat(p);
              out.push({ vpath, name: e.name, is_dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtime.toISOString(), kind: kindOf(e.name, st.isDirectory()) });
              if (out.length >= limit) break;
            } catch { /* ignore */ }
          }
          if (e.isDirectory() && !e.isSymbolicLink()) stack.push(p);
        }
      }
    }
    res.json({ items: out.slice(0, limit) });
  } catch {
    res.status(500).json({ error: 'search failed' });
  }
});

// ---- Breakdown for dashboard ----
router.get('/breakdown', async (req, res) => {
  const db = getDb();
  try {
    const home = resolveVPath(db, req.user, '/My Files');
    const cats = { videos: 0, documents: 0, images: 0, other: 0 };
    const stack = [home.physAbs];
    let seen = 0;
    while (stack.length && seen < 20000) {
      const dir = stack.pop();
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (++seen > 20000) break;
        const p = path.join(dir, e.name);
        try {
          if (e.isDirectory() && !e.isSymbolicLink()) { stack.push(p); continue; }
          const st = await fsp.stat(p);
          const k = kindOf(e.name, false);
          if (k === 'video') cats.videos += st.size;
          else if (k === 'image') cats.images += st.size;
          else if (k === 'pdf' || k === 'text' || k === 'code') cats.documents += st.size;
          else cats.other += st.size;
        } catch { /* ignore */ }
      }
    }
    const used = cats.videos + cats.documents + cats.images + cats.other;
    res.json({ ...cats, used_bytes: used });
  } catch {
    res.status(500).json({ error: 'breakdown failed' });
  }
});

module.exports = router;
