/**
 * Upload system: simple multipart (small files) + chunked resumable (large files).
 * - POST /api/uploads/simple   (multipart field "file", query/body path=)
 * - POST /api/uploads/init     {vdir, filename, total_size} -> {upload_id}
 * - PUT  /api/uploads/:id      body=raw chunk bytes, headers x-offset
 * - POST /api/uploads/:id/complete
 * - DELETE /api/uploads/:id   (cancel)
 * - GET  /api/uploads/:id     (status for resume)
 */
'use strict';

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { getDb, getSetting } = require('../db');
const { requireAuth, audit } = require('../middleware');
const { storageRoot, safeSegment, resolveVPath, assertCanWrite, realpathGuard } = require('../fsutil');
const { effectiveQuota, userUsageBytes } = require('./files-shared');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024, files: 20 }, // simple path for small files only; big files use chunked
});

function maxFileSize(db) {
  const n = Number(getSetting(db, 'max_file_size_bytes', String(20 * 1024 ** 3)));
  return Number.isFinite(n) && n > 0 ? n : 20 * 1024 ** 3;
}

async function checkQuota(db, user, incomingBytes) {
  const full = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  const quota = effectiveQuota(db, full);
  if (quota == null) return;
  const used = await userUsageBytes(db, user.username);
  if (used + incomingBytes > quota) {
    const e = new Error(`Storage quota exceeded (${used} + ${incomingBytes} > ${quota} bytes)`);
    e.status = 413;
    throw e;
  }
}

async function clamScanIfEnabled(db, absPath) {
  if (getSetting(db, 'clamav_enabled', '0') !== '1') return { scanned: false };
  // Optional ClamAV via TCP INSTREAM (no dep). Fail-open=false: block upload on scan error? We fail CLOSED only when daemon reachable and reports FOUND.
  const net = require('net');
  const host = getSetting(db, 'clamav_host', 'clamav') || 'clamav';
  const port = parseInt(getSetting(db, 'clamav_port', '3310'), 10) || 3310;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ scanned: false, warning: 'clamav timeout — upload allowed, scan skipped' }), 15000);
    try {
      const sock = net.connect(port, host, () => {
        sock.write('zINSTREAM\0');
        const rs = fs.createReadStream(absPath, { highWaterMark: 64 * 1024 });
        rs.on('data', (chunk) => {
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length, 0);
          sock.write(len);
          sock.write(chunk);
        });
        rs.on('end', () => {
          const z = Buffer.alloc(4);
          sock.write(z);
        });
        rs.on('error', () => { clearTimeout(timer); try { sock.destroy(); } catch {} resolve({ scanned: false, warning: 'scan read error' }); });
      });
      let data = '';
      sock.on('data', (c) => { data += c.toString(); });
      sock.on('close', () => { clearTimeout(timer); resolve({ scanned: true, clean: !data.includes('FOUND'), raw: data.slice(0, 200) }); });
      sock.on('error', () => { clearTimeout(timer); resolve({ scanned: false, warning: 'clamav unreachable — upload allowed' }); });
    } catch {
      clearTimeout(timer);
      resolve({ scanned: false });
    }
  });
}

// ---- Simple multipart ----
router.post('/simple', upload.array('file', 20), async (req, res) => {
  const db = getDb();
  try {
    const vdir = String((req.body && req.body.path) || req.query.path || '/My Files');
    const r = resolveVPath(db, req.user, vdir);
    assertCanWrite(db, req.user, r);
    const destAbs = await realpathGuard(r.physAbs);
    await fsp.mkdir(destAbs, { recursive: true });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'no files' });
    const max = maxFileSize(db);
    const results = [];
    for (const f of req.files) {
      try {
        if (f.size > max) throw new Error(`exceeds max file size (${max} bytes)`);
        await checkQuota(db, req.user, f.size);
        const name = safeSegment(f.originalname || 'upload');
        const target = await realpathGuard(path.join(destAbs, name));
        // unique-ify
        let finalT = target;
        let n = 1;
        while (await fsp.stat(finalT).then(() => true).catch(() => false)) {
          const ext = path.extname(target);
          finalT = target.slice(0, target.length - ext.length) + ` (${n++})` + ext;
        }
        await fsp.writeFile(finalT, f.buffer);
        const scan = await clamScanIfEnabled(db, finalT);
        if (scan.scanned && !scan.clean) {
          await fsp.rm(finalT, { force: true });
          throw new Error('file blocked by antivirus');
        }
        results.push({ name: path.basename(finalT), ok: true, size: f.size, av: scan });
      } catch (e) {
        results.push({ name: f.originalname, ok: false, error: e.message });
      }
    }
    audit(req, 'upload', `${results.filter((x) => x.ok).length} files -> ${r.vpath}`);
    res.status(201).json({ results });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'upload failed' });
  }
});

// ---- Chunked init ----
router.post('/init', async (req, res) => {
  const db = getDb();
  try {
    const { path: vdir, filename, total_size } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const total = Number(total_size);
    if (!Number.isFinite(total) || total < 0) return res.status(400).json({ error: 'total_size required' });
    const max = maxFileSize(db);
    if (total > max) return res.status(413).json({ error: `exceeds max file size (${max} bytes)` });
    await checkQuota(db, req.user, total);
    const r = resolveVPath(db, req.user, vdir || '/My Files');
    assertCanWrite(db, req.user, r);
    // phys_rel of destination dir, relative to storage root
    const id = uuidv4();
    const now = new Date().toISOString();
    const tmpRel = path.join('.tmp', `${id}.part`).split(path.sep).join('/');
    // pre-create empty tmp file
    const root = storageRoot();
    await fsp.mkdir(path.join(root, '.tmp'), { recursive: true });
    await fsp.writeFile(path.join(root, '.tmp', `${id}.part`), Buffer.alloc(0));
    db.prepare('INSERT INTO uploads(id, user_id, filename, vdir, phys_rel, total_size, tmp_rel, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(
      id, req.user.id, safeSegment(filename), r.vpath, r.physRel, total, tmpRel, now, now
    );
    res.status(201).json({ upload_id: id, chunk_size: 4 * 1024 * 1024 });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'init failed' });
  }
});

// ---- Chunk append: PUT raw bytes, offset via header x-offset or query offset ----
router.put('/:id', express.raw({ type: '*/*', limit: '64mb' }), async (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!row || row.status !== 'active') return res.status(404).json({ error: 'upload not found or finished' });
    const offset = Number(req.get('x-offset') ?? req.query.offset ?? row.received);
    if (!Number.isFinite(offset) || offset < 0) return res.status(400).json({ error: 'invalid offset' });
    if (offset !== row.received) {
      return res.status(409).json({ error: 'offset mismatch', received: row.received });
    }
    const chunk = req.body && Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!chunk.length) return res.status(400).json({ error: 'empty chunk' });
    if (row.received + chunk.length > row.total_size + 1024 * 1024) {
      return res.status(413).json({ error: 'exceeds declared total_size' });
    }
    const root = storageRoot();
    const tmpAbs = path.join(root, row.tmp_rel);
    const fh = await fsp.open(tmpAbs, 'a');
    try { await fh.write(chunk); } finally { await fh.close(); }
    const received = row.received + chunk.length;
    db.prepare("UPDATE uploads SET received = ?, updated_at = datetime('now') WHERE id = ?").run(received, row.id);
    res.json({ received, total: row.total_size, done: received >= row.total_size });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'chunk failed' });
  }
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id, filename, vdir, total_size, received, status FROM uploads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

router.delete('/:id', async (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare("UPDATE uploads SET status = 'cancelled' WHERE id = ?").run(row.id);
  try { await fsp.rm(path.join(storageRoot(), row.tmp_rel), { force: true }); } catch { /* ignore */ }
  res.json({ ok: true });
});

router.post('/:id/complete', async (req, res) => {
  const db = getDb();
  try {
    const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!row || row.status !== 'active') return res.status(404).json({ error: 'upload not found or finished' });
    const root = storageRoot();
    const tmpAbs = path.join(root, row.tmp_rel);
    const st = await fsp.stat(tmpAbs).catch(() => null);
    if (!st) return res.status(400).json({ error: 'no data received' });
    if (st.size < row.total_size) return res.status(400).json({ error: `incomplete: ${st.size}/${row.total_size}` });
    await checkQuota(db, req.user, st.size);
    const r = resolveVPath(db, req.user, row.vdir);
    assertCanWrite(db, req.user, r);
    const destDir = await realpathGuard(r.physAbs);
    await fsp.mkdir(destDir, { recursive: true });
    let target = await realpathGuard(path.join(destDir, safeSegment(row.filename)));
    let n = 1;
    while (await fsp.stat(target).then(() => true).catch(() => false)) {
      const ext = path.extname(path.join(destDir, safeSegment(row.filename)));
      const base = path.basename(path.join(destDir, safeSegment(row.filename)), ext);
      target = path.join(destDir, `${base} (${n++})${ext}`);
    }
    await fsp.rename(tmpAbs, target);
    // truncate in case client overshot by a byte
    const tst = await fsp.stat(target);
    if (tst.size > row.total_size) await fsp.truncate(target, row.total_size);
    db.prepare("UPDATE uploads SET status = 'complete' WHERE id = ?").run(row.id);
    const scan = await clamScanIfEnabled(db, target);
    if (scan.scanned && !scan.clean) {
      await fsp.rm(target, { force: true });
      return res.status(422).json({ error: 'file blocked by antivirus' });
    }
    audit(req, 'upload', `${path.basename(target)} (${tst.size}B) -> ${r.vpath}`);
    res.json({ ok: true, name: path.basename(target), size: tst.size });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'complete failed' });
  }
});

module.exports = router;
