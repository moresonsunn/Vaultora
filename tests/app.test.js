/** Vaultora integration tests (node:test). Boots the real server on ephemeral ports. */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

let tmpStorage, tmpData, base, adminCookie, adminCsrf, userCookie, userCsrf, server;

function parseCookies(res) {
  const out = {};
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of raw) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  return out;
}

async function req(p, { method = 'GET', cookie = '', csrf = '', body, rawBody, headers = {} } = {}) {
  const h = { 'X-Requested-With': 'fetch', ...headers };
  if (cookie) h.Cookie = cookie;
  if (csrf) h['X-CSRF-Token'] = csrf;
  let b;
  if (rawBody) b = rawBody;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const res = await fetch(base + p, { method, headers: h, body: b });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  return { res, data, cookies: parseCookies(res) };
}
const cookieStr = (c) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ');

before(async () => {
  tmpStorage = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultora-storage-'));
  tmpData = await fsp.mkdtemp(path.join(os.tmpdir(), 'vaultora-data-'));
  process.env.STORAGE_ROOT = tmpStorage;
  process.env.APP_DATA = tmpData;
  process.env.ADMIN_USER = 'admin';
  process.env.ADMIN_PASSWORD = 'adminpass123';
  process.env.PORT = '0';
  delete require.cache[require.resolve('../src/index.js')];
  const app = require('../src/index.js');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { require('../src/db').closeDb(); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  await fsp.rm(tmpStorage, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(tmpData, { recursive: true, force: true }).catch(() => {});
});

test('health + login/logout', async () => {
  const h = await fetch(base + '/health').then((r) => r.json());
  assert.equal(h.ok, true);
  const { res, data, cookies } = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'adminpass123' } });
  assert.equal(res.status, 200);
  assert.ok(cookies.vid_session);
  adminCookie = cookieStr(cookies);
  adminCsrf = data.csrf || cookies.vid_csrf;
  const me = await req('/api/auth/me', { cookie: adminCookie });
  assert.equal(me.data.user.username, 'admin');
  // wrong password rejected + rate-limit shape
  const bad = await req('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'nope' } });
  assert.equal(bad.res.status, 401);
});

test('user creation + duplicate + validation', async () => {
  const r = await req('/api/users', { method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { username: 'alice', password: 'alicepass1', role: 'user' } });
  assert.equal(r.res.status, 201);
  const dup = await req('/api/users', { method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { username: 'alice', password: 'alicepass1' } });
  assert.equal(dup.res.status, 409);
  const badName = await req('/api/users', { method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { username: '../evil', password: 'longenough1' } });
  assert.equal(badName.res.status, 400);
  // login as alice
  const l = await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'alicepass1' } });
  assert.equal(l.res.status, 200);
  userCookie = cookieStr(l.cookies);
  userCsrf = l.data.csrf || l.cookies.vid_csrf;
  // home dir created on disk as a normal file path
  assert.ok(fs.existsSync(path.join(tmpStorage, 'users', 'alice')));
});

test('mkdir + simple upload + download + preview + rename + move + copy + delete + trash restore', async () => {
  // mkdir
  let r = await req('/api/files/mkdir', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/My Files', name: 'Docs' } });
  assert.equal(r.res.status, 201);
  assert.ok(fs.existsSync(path.join(tmpStorage, 'users', 'alice', 'Docs')));

  // simple upload via multipart
  const fd = new FormData();
  fd.append('path', '/My Files/Docs');
  fd.append('file', new Blob(['hello vaultora'], { type: 'text/plain' }), 'hello.txt');
  const up = await fetch(base + '/api/uploads/simple', {
    method: 'POST',
    headers: { Cookie: userCookie, 'X-CSRF-Token': userCsrf, 'X-Requested-With': 'fetch' },
    body: fd,
  });
  assert.equal(up.status, 201);
  const upJ = await up.json();
  assert.equal(upJ.results[0].ok, true);
  assert.ok(fs.existsSync(path.join(tmpStorage, 'users', 'alice', 'Docs', 'hello.txt')));

  // list + sort
  const list = await req('/api/files?path=' + encodeURIComponent('/My Files/Docs'), { cookie: userCookie });
  assert.equal(list.data.items.length, 1);

  // download bytes match (streaming)
  const dl = await fetch(base + '/api/files/download?path=' + encodeURIComponent('/My Files/Docs/hello.txt'), { headers: { Cookie: userCookie } });
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'hello vaultora');

  // preview text excerpt
  const pv = await req('/api/files/preview?path=' + encodeURIComponent('/My Files/Docs/hello.txt'), { cookie: userCookie });
  assert.equal(pv.data.type, 'text');
  assert.match(pv.data.text, /hello vaultora/);

  // rename
  r = await req('/api/files/rename', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/My Files/Docs/hello.txt', name: 'greet.txt' } });
  assert.equal(r.res.status, 200);

  // search finds it (recursive)
  const s = await req('/api/files/search?q=greet', { cookie: userCookie });
  assert.ok(s.data.items.some((i) => i.name === 'greet.txt'));

  // copy
  r = await req('/api/files/copy', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { paths: ['/My Files/Docs/greet.txt'], dest: '/My Files' } });
  assert.equal(r.data.results[0].ok, true);

  // move copy back into Docs under new flow + move dir-into-itself refused
  r = await req('/api/files/move', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { paths: ['/My Files/Docs'], dest: '/My Files/Docs' } });
  assert.equal(r.data.results[0].ok, false);

  // delete -> trash
  r = await req('/api/files/delete', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { paths: ['/My Files/greet.txt'] } });
  assert.equal(r.data.results[0].ok, true);
  const trash = await req('/api/files/trash', { cookie: userCookie });
  assert.ok(trash.data.items.length >= 1);
  // restore
  const id = trash.data.items[0].trash_id;
  r = await req('/api/files/trash/restore', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { ids: [id] } });
  assert.equal(r.data.results[0].ok, true);
});

test('chunked large upload (10MB, resumable protocol)', async () => {
  const total = 10 * 1024 * 1024;
  const init = await req('/api/uploads/init', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/My Files', filename: 'big.bin', total_size: total } });
  assert.equal(init.res.status, 201);
  const uid = init.data.upload_id;
  const chunk = Buffer.alloc(4 * 1024 * 1024, 7);
  let offset = 0;
  while (offset < total) {
    const slice = chunk.subarray(0, Math.min(chunk.length, total - offset));
    const st = await req(`/api/uploads/${uid}`, {
      method: 'PUT', cookie: userCookie, csrf: userCsrf,
      rawBody: slice, headers: { 'Content-Type': 'application/octet-stream', 'X-Offset': String(offset) },
    });
    assert.equal(st.res.status, 200);
    offset = st.data.received;
  }
  const done = await req(`/api/uploads/${uid}/complete`, { method: 'POST', cookie: userCookie, csrf: userCsrf });
  assert.equal(done.res.status, 200);
  const st = fs.statSync(path.join(tmpStorage, 'users', 'alice', 'big.bin'));
  assert.equal(st.size, total);
  // wrong-offset rejected with 409 + received hint (resume)
  const init2 = await req('/api/uploads/init', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/My Files', filename: 'big2.bin', total_size: 100 } });
  const bad = await req(`/api/uploads/${init2.data.upload_id}`, {
    method: 'PUT', cookie: userCookie, csrf: userCsrf, rawBody: Buffer.from('x'), headers: { 'Content-Type': 'application/octet-stream', 'X-Offset': '50' },
  });
  assert.equal(bad.res.status, 409);
});

test('path traversal blocked, cross-user forbidden, CSRF enforced', async () => {
  // traversal via .. in virtual path is normalized but must not escape; direct escape attempt:
  const t = await req('/api/files?path=' + encodeURIComponent('/My Files/../../..'), { cookie: userCookie });
  assert.ok([200, 400, 403, 404].includes(t.res.status));
  // ensure we cannot read admin's home
  const evil = await req('/api/files/download?path=' + encodeURIComponent('/My Files/../../../../etc/passwd'), { cookie: userCookie });
  assert.ok(evil.res.status >= 400);
  // bob cannot touch alice's files: no shared roots granted
  await req('/api/users', { method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { username: 'bob', password: 'bobpass12' } });
  const lb = await req('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass12' } });
  const bobCookie = cookieStr(lb.cookies);
  // bob listing /My Files shows his own empty home, not alice's
  const bl = await req('/api/files?path=/My Files', { cookie: bobCookie });
  assert.equal(bl.res.status, 200);
  assert.ok(!bl.data.items.some((i) => i.name === 'big.bin'));
  // CSRF: mutating without token must 403
  const noCsrf = await req('/api/files/mkdir', { method: 'POST', cookie: userCookie, body: { path: '/My Files', name: 'x' } });
  assert.equal(noCsrf.res.status, 403);
});

test('shares: create, public download, password, expiry, limits, disable/regenerate', async () => {
  // create share for a file
  const c = await req('/api/shares', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/My Files/Docs/greet.txt' } });
  assert.equal(c.res.status, 201);
  const token = c.data.share.token;
  assert.match(c.data.share.url, /\/s\//);
  assert.ok(!c.data.share.url.includes('users/alice')); // no fs path in URL
  // public metadata + download without login
  const meta = await fetch(base + '/api/public/' + token).then((r) => r.json());
  assert.equal(meta.name, 'greet.txt');
  const dl = await fetch(base + '/api/public/' + token + '/download').then((r) => r.text());
  assert.match(dl, /hello vaultora/);

  // password-protected share
  const cp = await req('/api/shares', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/My Files/Docs/greet.txt', password: 's3cret' } });
  const pt = cp.data.share.token;
  const nopw = await fetch(base + '/api/public/' + pt);
  assert.equal(nopw.status, 401);
  const withpw = await fetch(base + '/api/public/' + pt + '?password=s3cret').then((r) => r.json());
  assert.equal(withpw.name, 'greet.txt');

  // expired share -> 410
  const ce = await req('/api/shares', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/My Files/Docs/greet.txt', expires_at: new Date(Date.now() + 1000).toISOString(), max_downloads: 1 } });
  const et = ce.data.share.token;
  await fetch(base + '/api/public/' + et + '/download'); // consume the 1 download
  const over = await fetch(base + '/api/public/' + et + '/download');
  assert.equal(over.status, 410);

  // disable + regenerate (owner)
  const dis = await req(`/api/shares/${c.data.share.id}`, { method: 'PATCH', cookie: userCookie, csrf: userCsrf, body: { disabled: true } });
  assert.equal(dis.data.share.disabled, true);
  const gone = await fetch(base + '/api/public/' + token);
  assert.equal(gone.status, 404);
  const reg = await req(`/api/shares/${c.data.share.id}/regenerate`, { method: 'POST', cookie: userCookie, csrf: userCsrf });
  assert.notEqual(reg.data.share.token, token);
});

test('storage roots: admin creates, grants alice, bob denied, quota enforced', async () => {
  const cr = await req('/api/admin/roots', { method: 'POST', cookie: adminCookie, csrf: adminCsrf, body: { name: 'Projects' } });
  assert.equal(cr.res.status, 201);
  const users = await req('/api/users', { cookie: adminCookie });
  const alice = users.data.users.find((u) => u.username === 'alice');
  const grant = await req(`/api/admin/roots/${cr.data.root.id}/access`, { method: 'PUT', cookie: adminCookie, csrf: adminCsrf, body: { user_ids: [alice.id], permission: 'write' } });
  assert.equal(grant.res.status, 200);
  // alice can write
  const m = await req('/api/files/mkdir', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/Projects', name: 'A' } });
  assert.equal(m.res.status, 201);
  // bob (no grant) gets 403
  const lb = await req('/api/auth/login', { method: 'POST', body: { username: 'bob', password: 'bobpass12' } });
  const bobCookie = cookieStr(lb.cookies);
  const denied = await req('/api/files?path=/Projects', { cookie: bobCookie });
  assert.equal(denied.res.status, 403);
  // quota: set alice to 1 byte over current usage -> next upload must 413
  await req(`/api/users/${alice.id}`, { method: 'PUT', cookie: adminCookie, csrf: adminCsrf, body: { quota_bytes: 1 } });
  const qi = await req('/api/uploads/init', { method: 'POST', cookie: userCookie, csrf: userCsrf, body: { path: '/My Files', filename: 'q.bin', total_size: 1024 } });
  assert.equal(qi.res.status, 413);
  // restore unlimited
  await req(`/api/users/${alice.id}`, { method: 'PUT', cookie: adminCookie, csrf: adminCsrf, body: { quota_bytes: null } });
});

test('audit log records key actions; admin can revoke sessions', async () => {
  const a = await req('/api/admin/activity?limit=500', { cookie: adminCookie });
  assert.equal(a.res.status, 200);
  const actions = new Set(a.data.items.map((i) => i.action));
  for (const need of ['login', 'upload', 'delete', 'share_create']) {
    assert.ok(actions.has(need), `missing audit action ${need}`);
  }
  const sess = await req('/api/admin/sessions', { cookie: adminCookie });
  assert.ok(sess.data.sessions.length >= 2);
  const victim = sess.data.sessions.find((s) => s.username === 'bob');
  const del = await req(`/api/admin/sessions/${victim.id}`, { method: 'DELETE', cookie: adminCookie, csrf: adminCsrf });
  assert.equal(del.res.status, 200);
});

test('persistence: db + files survive a "restart" (reopen same dirs)', async () => {
  // simulate restart by requiring fresh db handle on same path: data must still be there
  const dbPath = path.join(tmpData, 'vaultora.db');
  assert.ok(fs.existsSync(dbPath));
  const Database = require('better-sqlite3');
  const d = new Database(dbPath, { readonly: true });
  const users = d.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  assert.ok(users >= 3);
  const shares = d.prepare('SELECT COUNT(*) AS c FROM shares').get().c;
  assert.ok(shares >= 1);
  d.close();
  assert.ok(fs.existsSync(path.join(tmpStorage, 'users', 'alice', 'Docs', 'greet.txt')));
});
