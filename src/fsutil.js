/**
 * Filesystem layer: virtual-path <-> physical-path mapping, guards, helpers.
 *
 * Virtual paths (what the API + UI use):
 *   /My Files/...            -> STORAGE_ROOT/users/<username>/...
 *   /<RootName>/...          -> STORAGE_ROOT/<rel_path>/...  (admin-created shared roots)
 *   Trash and Recent/Starred are views, not paths.
 *
 * Physical paths ALWAYS stay under STORAGE_ROOT. Every resolution is
 * realpath-checked to prevent traversal / symlink escape.
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function storageRoot() {
  return path.resolve(process.env.STORAGE_ROOT || process.env.STORAGE_DIR || '/data');
}

function ensureStorageLayout() {
  const root = storageRoot();
  fs.mkdirSync(root, { recursive: true });
  for (const sub of ['users', '.tmp', '.thumbs', '.trash']) {
    fs.mkdirSync(path.join(root, sub), { recursive: true });
  }
  return root;
}

function userHomeRel(username) {
  return path.join('users', safeSegment(username));
}

function trashRel(username) {
  return path.join('.trash', safeSegment(username));
}

/** Sanitize a single path segment: no separators, no traversal, sane length. */
function safeSegment(name) {
  let s = String(name || '').normalize('NFC');
  s = s.replace(/[\0-\x1f\x7f]/g, ''); // control chars
  s = s.replace(/[\\/]/g, '_');
  s = s.replace(/^\.+$/, '_'); // "." / ".." / "..."
  s = s.trim().replace(/\s+$/g, '');
  if (!s) s = 'unnamed';
  if (s === '.' || s === '..') s = '_';
  if (s.length > 180) {
    const ext = path.extname(s);
    s = s.slice(0, 180 - ext.length) + ext;
  }
  return s;
}

/** Sanitize each segment of a user-supplied relative path. */
function sanitizeRel(rel) {
  const parts = String(rel || '')
    .split(/[\\/]+/)
    .filter((p) => p && p !== '.' && p !== '..');
  return parts.map(safeSegment).join('/');
}

function isSafeRelPath(rel) {
  if (/(^|[\\/])\.\.([\\/]|$)/.test(String(rel))) return false;
  if (String(rel).includes('\0')) return false;
  return true;
}

/**
 * Resolve a virtual path for a user to a physical absolute path.
 * Returns { kind: 'home'|'root', rootId?, rootName?, physAbs, physRel, subRel, display }
 * Throws { status, message } on forbidden.
 */
function resolveVPath(db, user, vpath) {
  const root = storageRoot();
  let v = String(vpath || '/My Files');
  if (!v.startsWith('/')) v = '/' + v;
  v = path.posix.normalize(v);
  // Special views have no physical path
  const parts = v.split('/').filter(Boolean);

  if (parts.length === 0) {
    // "/" -> user's home
    const rel = userHomeRel(user.username);
    return {
      kind: 'home',
      physRel: rel,
      physAbs: path.join(root, rel),
      subRel: '',
      display: '/My Files',
      vpath: '/My Files',
    };
  }

  const first = parts[0];
  if (first === 'My Files') {
    const sub = sanitizeRel(parts.slice(1).join('/'));
    const rel = path.join(userHomeRel(user.username), sub);
    assertInside(root, path.join(root, rel));
    return {
      kind: 'home',
      physRel: rel.split(path.sep).join('/'),
      physAbs: path.join(root, rel),
      subRel: sub,
      display: v,
      vpath: v,
    };
  }

  // Shared storage root: /<RootName>/...
  const row = db.prepare('SELECT * FROM storage_roots WHERE name = ?').get(first);
  if (!row) {
    const err = new Error(`Not found: ${first}`);
    err.status = 404;
    throw err;
  }
  if (user.role !== 'admin') {
    const acc = db
      .prepare('SELECT * FROM root_access WHERE root_id = ? AND user_id = ?')
      .get(row.id, user.id);
    if (!acc) {
      const err = new Error('Forbidden');
      err.status = 403;
      throw err;
    }
  }
  const sub = sanitizeRel(parts.slice(1).join('/'));
  const rel = path.join(row.rel_path, sub);
  assertInside(root, path.join(root, rel));
  return {
    kind: 'root',
    rootId: row.id,
    rootName: row.name,
    physRel: rel.split(path.sep).join('/'),
    physAbs: path.join(root, rel),
    subRel: sub,
    display: v,
    vpath: v,
  };
}

/** Check write permission for a resolved path. */
function assertCanWrite(db, user, resolved) {
  if (user.role === 'admin') return;
  if (resolved.kind === 'home') return;
  const acc = db
    .prepare('SELECT * FROM root_access WHERE root_id = ? AND user_id = ?')
    .get(resolved.rootId, user.id);
  if (!acc || acc.permission !== 'write') {
    const err = new Error('Read-only');
    err.status = 403;
    throw err;
  }
}

function assertInside(root, abs) {
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (a !== r && !a.startsWith(r + path.sep)) {
    const err = new Error('Path escapes storage root');
    err.status = 400;
    throw err;
  }
  return a;
}

/** Resolve then verify against the REAL filesystem (symlink-safe). */
async function realpathGuard(abs) {
  const root = storageRoot();
  const realRoot = await fsp.realpath(root).catch(() => root);
  // Walk up to nearest existing ancestor for new paths
  let probe = abs;
  const created = [];
  for (;;) {
    try {
      const st = await fsp.lstat(probe);
      void st;
      break;
    } catch {
      created.unshift(path.basename(probe));
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  const realProbe = await fsp.realpath(probe).catch(() => probe);
  const rebuilt = created.length ? path.join(realProbe, ...created) : realProbe;
  const rr = path.resolve(realRoot);
  const rb = path.resolve(rebuilt);
  if (rb !== rr && !rb.startsWith(rr + path.sep)) {
    const err = new Error('Path escapes storage root');
    err.status = 400;
    throw err;
  }
  return rb;
}

async function statSafe(abs) {
  try {
    return await fsp.stat(abs);
  } catch {
    return null;
  }
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

function kindOf(name, isDir) {
  if (isDir) return 'folder';
  const ext = path.extname(String(name).toLowerCase());
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.heic'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.ogv', '.mov', '.m4v', '.mkv'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.opus'].includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yaml', '.yml', '.toml', '.ini', '.xml'].includes(ext)) return 'text';
  if (['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.css', '.html', '.sh', '.sql', '.vue'].includes(ext)) return 'code';
  if (['.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz'].includes(ext)) return 'archive';
  return 'file';
}

function randomToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = {
  storageRoot,
  ensureStorageLayout,
  userHomeRel,
  trashRel,
  safeSegment,
  sanitizeRel,
  isSafeRelPath,
  resolveVPath,
  assertCanWrite,
  assertInside,
  realpathGuard,
  statSafe,
  formatBytes,
  kindOf,
  randomToken,
};
