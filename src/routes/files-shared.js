/** Shared helpers for file routes (du, listing, quota). */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { storageRoot, userHomeRel } = require('../fsutil');
const { getSetting } = require('../db');

async function duDir(abs, cap = 200000) {
  let bytes = 0;
  let files = 0;
  const stack = [abs];
  let seen = 0;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > cap) return { bytes, files, truncated: true };
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory() && !e.isSymbolicLink()) stack.push(p);
        else if (e.isFile()) {
          const st = await fsp.stat(p);
          bytes += st.size;
          files++;
        }
      } catch { /* ignore */ }
    }
  }
  return { bytes, files, truncated: false };
}

async function userUsageBytes(db, username) {
  const root = storageRoot();
  const home = path.join(root, userHomeRel(username));
  const { bytes } = await duDir(home, 100000);
  return bytes;
}

function effectiveQuota(db, userRow) {
  if (userRow.quota_bytes != null) return userRow.quota_bytes;
  const d = getSetting(db, 'default_quota_bytes', '');
  if (d === '' || d == null) return null;
  const n = Number(d);
  return Number.isFinite(n) && n > 0 ? n : null;
}

module.exports = { duDir, userUsageBytes, effectiveQuota };
