/** Second suite: bulk zip validity, stat/usage/breakdown/recent/starred, 2FA, permanent delete, folder shares. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let tmpStorage, tmpData, base, cookie, csrf, server;

async function req(p, { method = 'GET', body, rawBody, headers = {} } = {}) {
  const h = { 'X-Requested-With': 'fetch', Cookie: cookie, ...headers };
  if (csrf && method !== 'GET' && method !== 'HEAD') h['X-CSRF-Token'] = csrf;
  let b;
  if (rawBody) b = rawBody;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers: h, body: b });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.arrayBuffer().then((ab) => Buffer.from(ab));
  return { res, data };
}

before(async () => {
  tmpStorage = await fsp.mkdtemp(path.join(os.tmpdir(), 'v2-storage-'));
  tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'v2-data-'));
  process.env.STORAGE_ROOT = tmpStorage;
  process.env.APP_DATA = tmpData;
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASSWORD = 'adminpass123';
  const app = require('../src/index.js');
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const l = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
  });
  const lj = await l.json();
  const raw = l.headers.getSetCookie();
  cookie = raw.map((c) => c.split(';')[0]).join('; ');
  csrf = lj.csrf;
  // seed files
  await req('/api/files/mkdir', { method: 'POST', body: { path: '/My Files', name: 'Z' } });
  const fd = new FormData();
  fd.append('path', '/My Files/Z');
  fd.append('file', new Blob(['AAA'], { type: 'text/plain' }), 'a.txt');
  fd.append('file', new Blob(['BB'], { type: 'text/plain' }), 'b.txt');
  await fetch(base + '/api/uploads/simple', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Requested-With': 'fetch' }, body: fd });
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { require('../src/db').closeDb(); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(tmpStorage, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(tmpData, { recursive: true, force: true }).catch(() => {});
});

test('no HSTS header (plain-HTTP LAN app must not poison browsers into https)', async () => {
  const res = await fetch(base + '/');
  assert.ok(!res.headers.get('strict-transport-security'), 'HSTS header must be absent');
  assert.equal(res.status, 200);
});

test('bulk download is a valid store-only zip containing both files', async () => {
  const { res, data } = await req('/api/files/bulk-download', { method: 'POST', body: { paths: ['/My Files/Z'] } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/zip/);
  assert.equal(data.subarray(0, 4).toString('binary'), 'PK\x03\x04');
  assert.ok(data.includes('a.txt') && data.includes('b.txt'), 'filenames present');
  assert.ok(data.includes('AAA') && data.includes('BB'), 'file bytes present');
  assert.equal(data.subarray(data.length - 22, data.length - 18).toString('binary'), 'PK\x05\x06');
});

test('stat / usage / breakdown / recent / starred all respond', async () => {
  assert.equal((await req('/api/files/stat?path=' + encodeURIComponent('/My Files/Z/a.txt'))).data.name, 'a.txt');
  const u = (await req('/api/files/usage')).data;
  assert.ok(u.used_bytes >= 5);
  const b = (await req('/api/files/breakdown')).data;
  assert.ok(b.used_bytes >= 5);
  assert.ok((await req('/api/files/recent?limit=10')).data.items.length >= 2);
  await req('/api/files/star', { method: 'POST', body: { path: '/My Files/Z/a.txt', starred: true } });
  assert.ok((await req('/api/files/starred')).data.items.some((i) => i.vpath.endsWith('a.txt')));
});

test('2FA TOTP roundtrip: setup -> enable -> login requires code -> disable', async () => {
  const setup = (await req('/api/auth/2fa/setup', { method: 'POST' })).data;
  assert.ok(setup.secret && setup.otpauth_url);
  // compute current code with the same algorithm (independent re-implementation inline)
  const crypto = require('node:crypto');
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const dec = (s) => {
    let bits = 0, v = 0; const out = [];
    for (const ch of s.replace(/[^A-Z2-7]/gi, '').toUpperCase()) {
      v = (v << 5) | B32.indexOf(ch); bits += 5;
      if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
  };
  const code = (() => {
    const c = Math.floor(Date.now() / 1000 / 30);
    const msg = Buffer.alloc(8);
    let cc = BigInt(c);
    for (let i = 7; i >= 0; i--) { msg[i] = Number(cc & 0xffn); cc >>= 8n; }
    const h = crypto.createHmac('sha1', dec(setup.secret)).update(msg).digest();
    const o = h[h.length - 1] & 0x0f;
    return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 10 ** 6).padStart(6, '0');
  })();
  assert.equal((await req('/api/auth/2fa/enable', { method: 'POST', body: { code } })).res.status, 200);
  // new login without code must fail with need_totp
  const noTotp = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'adminpass123' }),
  }).then((r) => r.json().then((j) => ({ status: r.status, j })));
  assert.equal(noTotp.status, 401);
  assert.equal(noTotp.j.need_totp, true);
  // with code succeeds
  const withTotp = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'adminpass123', totp: code }),
  });
  assert.equal(withTotp.status, 200);
  // disable with code
  assert.equal((await req('/api/auth/2fa/disable', { method: 'POST', body: { code } })).res.status, 200);
});

test('folder share: list children + download one file via ?file=', async () => {
  const c = (await req('/api/shares', { method: 'POST', body: { path: '/My Files/Z' } })).data.share;
  assert.equal(c.is_dir, true);
  const meta = await fetch(base + '/api/public/' + c.token).then((r) => r.json());
  assert.equal(meta.is_dir, true);
  assert.ok(meta.children.some((x) => x.name === 'a.txt'));
  // traversal inside share blocked
  const evil = await fetch(base + '/api/public/' + c.token + '/download?file=../vaultora.db');
  assert.equal(evil.status, 400);
  const one = await fetch(base + '/api/public/' + c.token + '/download?file=a.txt').then((r) => r.text());
  assert.equal(one, 'AAA');
});

test('pause/resume: partial chunks persist server-side and complete later', async () => {
  const total = 6 * 1024 * 1024;
  const init = (await req('/api/uploads/init', { method: 'POST', body: { path: '/My Files', filename: 'resume.bin', total_size: total } })).data;
  const send = (off, len) => req(`/api/uploads/${init.upload_id}`, {
    method: 'PUT', rawBody: Buffer.alloc(len, 9),
    headers: { 'Content-Type': 'application/octet-stream', 'X-Offset': String(off) },
  });
  await send(0, 4 * 1024 * 1024);
  // "pause": client goes away; server reports progress for resume
  const st = (await req(`/api/uploads/${init.upload_id}`)).data;
  assert.equal(st.received, 4 * 1024 * 1024);
  // resume remaining bytes, then complete
  await send(st.received, total - st.received);
  assert.equal((await req(`/api/uploads/${init.upload_id}/complete`, { method: 'POST' })).res.status, 200);
  assert.equal(fs.statSync(path.join(tmpStorage, 'users', 'admin', 'resume.bin')).size, total);
});

test('versions: overwrite creates restorable history (simple + chunked)', async () => {
  await req('/api/files/mkdir', { method: 'POST', body: { path: '/My Files', name: 'Vtest' } });
  const put = async (text, overwrite) => {
    const fd = new FormData();
    fd.append('path', '/My Files/Vtest');
    if (overwrite) fd.append('overwrite', '1');
    fd.append('file', new Blob([text], { type: 'text/plain' }), 'v.txt');
    return fetch(base + '/api/uploads/simple', {
      method: 'POST',
      headers: { Cookie: cookie, 'X-CSRF-Token': csrf, 'X-Requested-With': 'fetch' },
      body: fd,
    }).then((r) => r.json());
  };
  await put('one', false);
  // same name without overwrite -> kept both, no version
  const r2 = await put('one-again', false);
  assert.equal(r2.results[0].name, 'v (1).txt');
  assert.equal((await req('/api/files/versions?path=' + encodeURIComponent('/My Files/Vtest/v.txt'))).data.versions.length, 0);
  // with overwrite -> version created, exact name kept
  await put('two', true);
  const vs = (await req('/api/files/versions?path=' + encodeURIComponent('/My Files/Vtest/v.txt'))).data.versions;
  assert.equal(vs.length, 1);
  const dl = await fetch(base + '/api/files/download?path=' + encodeURIComponent('/My Files/Vtest/v.txt'), { headers: { Cookie: cookie } }).then((r) => r.text());
  assert.equal(dl, 'two');
  // restore -> old content back, replaced content becomes a version
  await req('/api/files/versions/restore', { method: 'POST', body: { path: '/My Files/Vtest/v.txt', version: vs[0].id } });
  const dl2 = await fetch(base + '/api/files/download?path=' + encodeURIComponent('/My Files/Vtest/v.txt'), { headers: { Cookie: cookie } }).then((r) => r.text());
  assert.equal(dl2, 'one');
  const vs2 = (await req('/api/files/versions?path=' + encodeURIComponent('/My Files/Vtest/v.txt'))).data.versions;
  assert.ok(vs2.length >= 1);
  // delete a version
  await req('/api/files/versions/delete', { method: 'POST', body: { path: '/My Files/Vtest/v.txt', version: vs2[0].id } });
  const vs3 = (await req('/api/files/versions?path=' + encodeURIComponent('/My Files/Vtest/v.txt'))).data.versions;
  assert.equal(vs3.length, vs2.length - 1);
  // invalid version rejected
  const bad = await req('/api/files/versions/restore', { method: 'POST', body: { path: '/My Files/Vtest/v.txt', version: '../evil' } });
  assert.equal(bad.res.status, 400);
  // chunked overwrite path
  const init = (await req('/api/uploads/init', { method: 'POST', body: { path: '/My Files/Vtest', filename: 'c.txt', total_size: 3 } })).data;
  await req(`/api/uploads/${init.upload_id}`, { method: 'PUT', rawBody: Buffer.from('abc'), headers: { 'Content-Type': 'application/octet-stream', 'X-Offset': '0' } });
  await req(`/api/uploads/${init.upload_id}/complete`, { method: 'POST' });
  const init2 = (await req('/api/uploads/init', { method: 'POST', body: { path: '/My Files/Vtest', filename: 'c.txt', total_size: 3 } })).data;
  await req(`/api/uploads/${init2.upload_id}`, { method: 'PUT', rawBody: Buffer.from('xyz'), headers: { 'Content-Type': 'application/octet-stream', 'X-Offset': '0' } });
  await req(`/api/uploads/${init2.upload_id}/complete`, { method: 'POST', body: { overwrite: true } });
  const cvs = (await req('/api/files/versions?path=' + encodeURIComponent('/My Files/Vtest/c.txt'))).data.versions;
  assert.equal(cvs.length, 1);
  const cdl = await fetch(base + '/api/files/download?path=' + encodeURIComponent('/My Files/Vtest/c.txt'), { headers: { Cookie: cookie } }).then((r) => r.text());
  assert.equal(cdl, 'xyz');
});

test('file drop: anonymous upload gated by flag, password, quota', async () => {
  await req('/api/files/mkdir', { method: 'POST', body: { path: '/My Files', name: 'DropBox' } });
  const drop = await req('/api/shares', { method: 'POST', body: { path: '/My Files/DropBox', allow_upload: true } });
  assert.equal(drop.data.share.allow_upload, true);
  const noflag = await req('/api/shares', { method: 'POST', body: { path: '/My Files/DropBox' } });
  assert.equal(noflag.data.share.allow_upload, false);
  const anon = async (token, name, text) => {
    const fd = new FormData();
    fd.append('file', new Blob([text]), name);
    return fetch(base + '/api/public/' + token + '/upload', { method: 'POST', body: fd }).then((r) => r.json().then((j) => ({ status: r.status, j })));
  };
  // no login cookie anywhere here: anonymous
  const ok = await anon(drop.data.share.token, 'hello-drop.txt', 'from a friend');
  assert.equal(ok.status, 201);
  assert.equal(ok.j.results[0].ok, true);
  const meta = await fetch(base + '/api/public/' + drop.data.share.token).then((r) => r.json());
  assert.equal(meta.allow_upload, true);
  assert.ok(meta.children.some((c) => c.name === 'hello-drop.txt'));
  // flag off -> 403
  const denied = await anon(noflag.data.share.token, 'x.txt', 'x');
  assert.equal(denied.status, 403);
  // password-protected drop without password -> 401
  const pwshare = await req('/api/shares', { method: 'POST', body: { path: '/My Files/DropBox', allow_upload: true, password: 'drop1' } });
  const nopw = await anon(pwshare.data.share.token, 'y.txt', 'y');
  assert.equal(nopw.status, 401);
});

test('activity feed is per-user', async () => {
  const mine = (await req('/api/files/activity?limit=100')).data.items;
  assert.ok(mine.length > 0);
  assert.ok(mine.every((a) => a.action));
  assert.ok(mine.some((a) => a.action === 'upload' || a.action === 'share_create'));
  // create isolated user via admin users endpoint (cookie/csrf are admin's here)
  const cu = await req('/api/users', { method: 'POST', body: { username: 'carol', password: 'carolpass1' } });
  assert.equal(cu.res.status, 201);
  const cl = await fetch(base + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'carol', password: 'carolpass1' }),
  });
  const carolCookie = cl.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const carol = await fetch(base + '/api/files/activity?limit=100', { headers: { Cookie: carolCookie, 'X-Requested-With': 'fetch' } }).then((r) => r.json());
  assert.ok(carol.items.length >= 1); // her own login
  assert.ok(!carol.items.some((a) => a.action === 'share_create' && a.detail && a.detail.includes('/My Files/DropBox')));
});

test('migration adds allow_upload to pre-v2 share tables', async () => {
  const { openDb, ensureColumn } = require('../src/db');
  const os2 = require('node:os');
  const p = require('node:path');
  const tmp = await fsp.mkdtemp(path.join(os2.tmpdir(), 'v-old-db-'));
  const dbPath = path.join(tmp, 'old.db');
  const d = openDb(dbPath);
  d.exec('CREATE TABLE shares (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL)');
  ensureColumn(d, 'shares', 'allow_upload', 'INTEGER NOT NULL DEFAULT 0');
  const cols = d.prepare('PRAGMA table_info(shares)').all().map((c) => c.name);
  assert.ok(cols.includes('allow_upload'));
  d.close();
  await fsp.rm(tmp, { recursive: true, force: true });
});

test('permanent delete skips trash; trash empty works', async () => {
  await req('/api/files/delete', { method: 'POST', body: { paths: ['/My Files/Z/b.txt'], permanent: true } });
  assert.ok(!fs.existsSync(path.join(tmpStorage, 'users', 'admin', 'Z', 'b.txt')));
  await req('/api/files/delete', { method: 'POST', body: { paths: ['/My Files/Z/a.txt'] } });
  assert.ok((await req('/api/files/trash')).data.items.length >= 1);
  assert.equal((await req('/api/files/trash/empty', { method: 'POST' })).res.status, 200);
  assert.equal((await req('/api/files/trash')).data.items.length, 0);
});
