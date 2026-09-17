/* Vaultora frontend — vanilla JS, no build step. */
'use strict';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  user: null, csrf: null, view: 'files', path: '/My Files',
  items: [], sort: localStorage.getItem('v_sort') || 'name',
  order: localStorage.getItem('v_order') || 'asc',
  grid: localStorage.getItem('v_grid') === '1',
  sel: new Set(), trash: [], sharedRoots: [],
};
S.theme = localStorage.getItem('v_theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = S.theme;

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB']; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
function iconFor(it) {
  if (it.is_dir) return '📁';
  return { image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', text: '📝', code: '💻', archive: '🗜️', file: '📄' }[it.kind] || '📄';
}

async function api(path, opts = {}) {
  const o = { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' }, ...opts };
  o.headers = { ...(opts.headers || {}) };
  if (S.csrf && !['GET', 'HEAD'].includes((o.method || 'GET').toUpperCase())) o.headers['X-CSRF-Token'] = S.csrf;
  if (o.body && typeof o.body === 'object' && !(o.body instanceof FormData)) {
    o.headers['Content-Type'] = 'application/json';
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(path, o);
  if (r.status === 401) { showLogin(); throw new Error('signed out'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
  if (!r.ok) throw new Error((data && data.error) || `request failed (${r.status})`);
  return data;
}

/* ---------- auth ---------- */
function showLogin() {
  S.user = null;
  $('#app').hidden = true; $('#loginView').hidden = false;
}
async function boot() {
  $('#themeBtn').onclick = () => {
    S.theme = S.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = S.theme;
    localStorage.setItem('v_theme', S.theme);
  };
  try {
    const me = await api('/api/auth/me');
    S.user = me.user; S.csrf = me.csrf || S.csrf;
    enter();
  } catch { showLogin(); }
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { username: $('#liUser').value.trim(), password: $('#liPass').value, totp: $('#liTotp').value.trim() || undefined } });
      S.user = r.user; S.csrf = r.csrf; enter();
    } catch (err) {
      if (String(err.message).includes('two-factor')) { $('#totpWrap').hidden = false; $('#loginErr').textContent = 'Enter your 2FA code and sign in again.'; }
      else $('#loginErr').textContent = err.message;
    }
  };
}

function enter() {
  $('#loginView').hidden = true; $('#app').hidden = false;
  $('#uname').textContent = S.user.username;
  $('#urole').textContent = S.user.role;
  $('#avatar').textContent = S.user.username.slice(0, 1).toUpperCase();
  $('#navAdmin').hidden = S.user.role !== 'admin';
  fetch('/api/version').then((r) => r.json()).then((v) => {
    $('#appVer').textContent = 'v' + v.version + (v.commit ? ' · ' + v.commit : '');
  }).catch(() => { $('#appVer').textContent = ''; });
  bindOnce();
  nav('files');
  refreshStorage();
}

/* ---------- navigation ---------- */
let bound = false;
function bindOnce() {
  if (bound) return; bound = true;
  $$('#nav button').forEach((b) => (b.onclick = () => { document.body.classList.remove('nav-open'); nav(b.dataset.view); }));
  $('#menuBtn').onclick = () => document.body.classList.toggle('nav-open');
  $('#logoutBtn').onclick = async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); location.reload(); };
  $('#uploadBtn').onclick = () => $('#filePick').click();
  $('#folderUpBtn').onclick = () => $('#folderPick').click();
  $('#filePick').onchange = (e) => { queueFiles(Array.from(e.target.files), S.path); e.target.value = ''; };
  $('#folderPick').onchange = (e) => { queueFiles(Array.from(e.target.files), S.path); e.target.value = ''; };
  $('#mkdirBtn').onclick = mkdirDlg;
  $('#viewBtn').onclick = () => { S.grid = !S.grid; localStorage.setItem('v_grid', S.grid ? '1' : '0'); render(); };
  $('#upClose').onclick = () => $('#upPanel').classList.remove('open');
  $('#pvClose').onclick = () => $('#preview').classList.remove('open');
  $('#preview').addEventListener('click', (e) => { if (e.target.id === 'preview') $('#preview').classList.remove('open'); });
  let searchT;
  $('#searchInput').oninput = (e) => { clearTimeout(searchT); searchT = setTimeout(() => doSearch(e.target.value), 250); };
  $('#selClear').onclick = () => { S.sel.clear(); render(); };
  $('#bulkDl').onclick = bulkDownload;
  $('#bulkDel').onclick = bulkDelete;
  $('#bulkMove').onclick = bulkMove;
  // drag & drop
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault(); depth = 0; document.body.classList.remove('dragging');
    if (e.dataTransfer?.files?.length) queueFiles(Array.from(e.dataTransfer.files), S.path);
  });
  document.addEventListener('keydown', keys);
}

function keys(e) {
  if ($('#app').hidden) return;
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  const k = e.key;
  if (k === '/') { e.preventDefault(); $('#searchInput').focus(); }
  else if (k === 'u') $('#filePick').click();
  else if (k === 'n') mkdirDlg();
  else if (k === 'Delete' || k === 'Backspace') { if (S.sel.size) bulkDelete(); }
  else if (k === 'a' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); S.items.forEach((i) => S.sel.add(i.vpath)); render(); }
  else if (k === 'Escape') { S.sel.clear(); closeModal(); $('#preview').classList.remove('open'); render(); }
  else if (k === 'g') { S.grid = !S.grid; render(); }
  else if (k === 'r' && S.view === 'files') loadPath(S.path);
}

function nav(view) {
  S.view = view; S.sel.clear();
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#adminWrap').hidden = view !== 'admin';
  $('#toolbar').style.display = view === 'admin' ? 'none' : '';
  $('#searchInput').value = '';
  if (view === 'files' || view === 'home') loadPath(view === 'home' ? '/My Files' : S.path);
  else if (view === 'shared') loadShared();
  else if (view === 'recent') loadRecent();
  else if (view === 'starred') loadStarred();
  else if (view === 'trash') loadTrash();
  else if (view === 'admin') loadAdmin('users');
}

/* ---------- file list ---------- */
async function loadPath(p) {
  S.view = S.view === 'home' ? 'home' : 'files';
  S.path = p;
  try {
    const d = await api('/api/files?path=' + encodeURIComponent(p) + `&sort=${S.sort}&order=${S.order}`);
    S.path = d.path; S.items = d.items; S.writable = d.writable;
    render();
  } catch (e) { toast(e.message); }
}

function crumbsFor(p) {
  const parts = p.split('/').filter(Boolean);
  const el = $('#crumbs'); el.innerHTML = '';
  const mk = (label, target) => {
    const b = document.createElement('button');
    b.innerHTML = `<strong>${esc(label)}</strong>`;
    b.onclick = () => loadPath(target);
    el.appendChild(b);
  };
  if (!parts.length) { mk('My Files', '/My Files'); return; }
  parts.forEach((part, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'muted'; s.textContent = '›'; el.appendChild(s); }
    mk(part, '/' + parts.slice(0, i + 1).join('/'));
  });
}

function render() {
  crumbsFor(S.path);
  const w = $('#listWrap'); w.innerHTML = '';
  $('#countLabel').textContent = S.view === 'files' || S.view === 'home' ? `${S.items.length} item${S.items.length === 1 ? '' : 's'}` : '';
  // bulk bar
  $('#bulkbar').classList.toggle('open', S.sel.size > 0);
  $('#selCount').textContent = `${S.sel.size} selected`;
  if (!S.items.length) {
    w.innerHTML = `<div class="muted" style="padding:30px;text-align:center">This folder is empty.<br>Drag files here, or use <b>Upload</b>.</div>`;
    return;
  }
  if (S.grid) {
    const g = document.createElement('div'); g.className = 'grid';
    S.items.forEach((it) => g.appendChild(cardEl(it)));
    w.appendChild(g);
  } else {
    const t = document.createElement('table'); t.className = 'files';
    t.innerHTML = `<thead><tr>
      <th style="width:34px"><input type="checkbox" id="selAll"></th>
      <th data-s="name">Name ${arrow('name')}</th><th data-s="size">Size ${arrow('size')}</th>
      <th data-s="date">Modified ${arrow('date')}</th><th data-s="type">Type ${arrow('type')}</th><th></th>
    </tr></thead>`;
    const tb = document.createElement('tbody');
    S.items.forEach((it) => tb.appendChild(rowEl(it)));
    t.appendChild(tb); w.appendChild(t);
    $$('th[data-s]', t).forEach((th) => (th.onclick = () => {
      const s = th.dataset.s;
      if (S.sort === s) S.order = S.order === 'asc' ? 'desc' : 'asc';
      else { S.sort = s; S.order = 'asc'; }
      localStorage.setItem('v_sort', S.sort); localStorage.setItem('v_order', S.order);
      loadPath(S.path);
    }));
    const all = $('#selAll', t);
    if (all) all.onchange = () => {
      if (all.checked) S.items.forEach((i) => S.sel.add(i.vpath));
      else S.sel.clear();
      render();
    };
  }
}
function arrow(s) { return S.sort === s ? (S.order === 'asc' ? '▲' : '▼') : ''; }

function thumbEl(it, big) {
  const d = document.createElement('div');
  d.className = big ? 'th' : 'fi';
  if (it.kind === 'image') {
    const img = document.createElement('img');
    img.loading = 'lazy'; img.alt = it.name;
    img.src = '/api/files/preview?path=' + encodeURIComponent(it.vpath);
    img.onerror = () => { img.remove(); d.textContent = '🖼️'; };
    d.appendChild(img);
  } else d.textContent = iconFor(it);
  return d;
}

function rowEl(it) {
  const tr = document.createElement('tr');
  if (S.sel.has(it.vpath)) tr.classList.add('sel');
  tr.innerHTML = `<td><input type="checkbox"></td><td></td><td class="muted">${it.is_dir ? '—' : fmtBytes(it.size)}</td>
    <td class="muted small">${fmtDate(it.mtime)}</td><td class="muted small">${it.is_dir ? 'Folder' : esc(it.kind)}</td>
    <td class="rowactions" style="text-align:right"></td>`;
  const cb = $('input', tr);
  cb.checked = S.sel.has(it.vpath);
  cb.onchange = () => { cb.checked ? S.sel.add(it.vpath) : S.sel.delete(it.vpath); render(); };
  const nm = $('td:nth-child(2)', tr);
  nm.appendChild(Object.assign(document.createElement('div'), { className: 'fname' }));
  const f = $('.fname', nm);
  f.appendChild(thumbEl(it));
  const n = document.createElement('span');
  n.className = 'nm'; n.textContent = it.name; n.title = it.name;
  n.onclick = () => openItem(it);
  f.appendChild(n);
  if (it.starred) { const st = document.createElement('span'); st.textContent = ' ⭐'; f.appendChild(st); }
  const cell = $('.rowactions', tr);
  const b = document.createElement('button');
  b.className = 'iconbtn'; b.textContent = '⋯';
  b.onclick = (e) => { e.stopPropagation(); menu(cell, it); };
  cell.appendChild(b);
  tr.ondblclick = () => openItem(it);
  return tr;
}

function cardEl(it) {
  const c = document.createElement('div');
  c.className = 'card' + (S.sel.has(it.vpath) ? ' sel' : '');
  c.appendChild(thumbEl(it, true));
  const n = document.createElement('div'); n.className = 'nm'; n.textContent = it.name; n.title = it.name;
  const m = document.createElement('div'); m.className = 'mt'; m.textContent = it.is_dir ? 'Folder' : `${fmtBytes(it.size)} · ${it.kind}`;
  c.append(n, m);
  c.onclick = (e) => {
    if (e.ctrlKey || e.metaKey) { S.sel.has(it.vpath) ? S.sel.delete(it.vpath) : S.sel.add(it.vpath); render(); }
    else openItem(it);
  };
  c.oncontextmenu = (e) => { e.preventDefault(); menu(c, it); };
  return c;
}

function openItem(it) {
  if (it.is_dir) { S.view = 'files'; loadPath(it.vpath); }
  else preview(it.vpath, it.name);
}

let openMenu = null;
function menu(anchor, it) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'menu';
  const items = [
    ['Open', () => openItem(it)],
    ['Download', () => download(it.vpath)],
    [it.starred ? 'Unstar ★' : 'Star ☆', async () => { await api('/api/files/star', { method: 'POST', body: { path: it.vpath, starred: !it.starred } }); loadPath(S.path); }],
    ['Rename', () => renameDlg(it)],
    ['Move', () => moveDlg([it.vpath])],
    ['Copy', () => copyDlg([it.vpath])],
    ['Share', () => shareDlg(it.vpath)],
    ['Details', () => detailsDlg(it.vpath)],
    ['Delete', () => delPaths([it.vpath]), 'danger'],
  ];
  items.forEach(([label, fn, cls]) => {
    const b = document.createElement('button');
    b.textContent = label; if (cls) b.className = cls;
    b.onclick = () => { closeMenu(); fn(); };
    m.appendChild(b);
  });
  anchor.style.position = anchor.style.position || 'relative';
  anchor.appendChild(m); openMenu = m;
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { openMenu?.remove(); openMenu = null; }

/* ---------- operations ---------- */
function download(vpath) {
  const a = document.createElement('a');
  a.href = '/api/files/download?path=' + encodeURIComponent(vpath);
  a.download = vpath.split('/').pop();
  document.body.appendChild(a); a.click(); a.remove();
}
async function mkdirDlg() {
  const name = await promptDlg('New folder', 'Folder name', '');
  if (!name) return;
  try { await api('/api/files/mkdir', { method: 'POST', body: { path: S.path, name } }); loadPath(S.path); }
  catch (e) { toast(e.message); }
}
async function renameDlg(it) {
  const name = await promptDlg('Rename', 'New name', it.name);
  if (!name || name === it.name) return;
  try { await api('/api/files/rename', { method: 'POST', body: { path: it.vpath, name } }); loadPath(S.path); }
  catch (e) { toast(e.message); }
}
async function delPaths(paths) {
  if (!confirm(`Delete ${paths.length} item(s)? They move to Trash (if enabled).`)) return;
  try {
    const r = await api('/api/files/delete', { method: 'POST', body: { paths } });
    const bad = r.results.filter((x) => !x.ok);
    if (bad.length) toast(`Failed: ${bad[0].error}`);
    S.sel.clear(); refresh();
  } catch (e) { toast(e.message); }
}
async function moveDlg(paths) {
  const dest = await promptDlg('Move to', 'Destination folder (e.g. /My Files/Docs)', S.path);
  if (!dest) return;
  try {
    const r = await api('/api/files/move', { method: 'POST', body: { paths, dest } });
    const bad = r.results.filter((x) => !x.ok);
    toast(bad.length ? `Moved with ${bad.length} error(s): ${bad[0].error}` : 'Moved');
    S.sel.clear(); refresh();
  } catch (e) { toast(e.message); }
}
async function copyDlg(paths) {
  const dest = await promptDlg('Copy to', 'Destination folder', S.path);
  if (!dest) return;
  try {
    const r = await api('/api/files/copy', { method: 'POST', body: { paths, dest } });
    const bad = r.results.filter((x) => !x.ok);
    toast(bad.length ? `Copied with ${bad.length} error(s)` : 'Copied');
    S.sel.clear(); refresh();
  } catch (e) { toast(e.message); }
}
async function bulkDownload() {
  const paths = [...S.sel];
  if (!paths.length) return;
  if (paths.length === 1 && !paths[0].is_dir) { download(paths[0]); return; }
  try {
    const r = await fetch('/api/files/bulk-download', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', 'X-CSRF-Token': S.csrf },
      body: JSON.stringify({ paths }),
    });
    if (!r.ok) throw new Error('bulk download failed');
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'vaultora-download.zip';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  } catch (e) { toast(e.message); }
}
async function bulkDelete() { await delPaths([...S.sel]); }
async function bulkMove() { await moveDlg([...S.sel]); }
async function detailsDlg(vpath) {
  try {
    const d = await api('/api/files/stat?path=' + encodeURIComponent(vpath));
    modal(`<h3>Details</h3><dl class="kv">
      <dt>Name</dt><dd>${esc(d.name)}</dd><dt>Type</dt><dd>${esc(d.kind)} · ${esc(d.mime || '')}</dd>
      <dt>Size</dt><dd>${fmtBytes(d.size)}</dd><dt>Modified</dt><dd>${fmtDate(d.mtime)}</dd>
      <dt>Path</dt><dd class="mono">${esc(d.vpath)}</dd></dl>
      <div class="row"><button class="btn" onclick="document.querySelector('#modal').classList.remove('open')">Close</button></div>`);
  } catch (e) { toast(e.message); }
}

/* ---------- search / shared / recent / starred / trash ---------- */
async function doSearch(q) {
  if (!q || q.trim().length < 2) {
    if (S.view === 'files') loadPath(S.path);
    return;
  }
  try {
    const d = await api('/api/files/search?q=' + encodeURIComponent(q));
    S.items = d.items; S.view = 'search';
    $('#countLabel').textContent = `${d.items.length} result(s)`;
    renderSearchResults();
  } catch (e) { toast(e.message); }
}
function renderSearchResults() {
  crumbsFor('/Search');
  const w = $('#listWrap'); w.innerHTML = '';
  if (!S.items.length) { w.innerHTML = '<div class="muted" style="padding:30px;text-align:center">No matches.</div>'; return; }
  const t = document.createElement('table'); t.className = 'files';
  t.innerHTML = '<thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Location</th></tr></thead>';
  const tb = document.createElement('tbody');
  S.items.forEach((it) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="muted">${it.is_dir ? '—' : fmtBytes(it.size)}</td><td class="muted small">${fmtDate(it.mtime)}</td><td class="muted small mono">${esc(it.vpath)}</td>`;
    const c = $('td', tr);
    const f = document.createElement('div'); f.className = 'fname';
    f.append(thumbEl(it));
    const n = document.createElement('span'); n.className = 'nm'; n.textContent = it.name;
    n.onclick = () => openItem(it);
    f.appendChild(n); c.appendChild(f);
    tb.appendChild(tr);
  });
  t.appendChild(tb); w.appendChild(t);
}
async function loadShared() {
  try {
    const d = await api('/api/admin/roots').catch(() => null);
    let roots = [];
    if (S.user.role === 'admin' && d) roots = d.roots.map((r) => '/' + r.name);
    else {
      // non-admin: probe via files API — list known roots by trying /Shared view fallback:
      // server exposes accessible roots through recent/search; simplest: fetch /api/files for each? Instead call storage endpoint:
      try {
        const u = await api('/api/files/usage'); void u;
      } catch {}
      // Ask server: reuse admin 403 -> fallback to listing via search of "" is blocked; so expose via dedicated probe:
      const probe = await fetch('/api/files?path=' + encodeURIComponent('/My Files'), { credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } }).then((r) => r.json());
      void probe;
      // Last resort: try common names is wrong. Use /api/shares-owned? No.
      // Correct approach: GET /api/shared-roots (added below in code? fallback to admin list attempt).
      roots = S.sharedRoots;
    }
    if (S.user.role !== 'admin' && !roots.length) {
      // fetch accessible roots via new lightweight endpoint
      try {
        const r2 = await api('/api/files/shared-roots');
        roots = r2.roots.map((r) => '/' + r);
        S.sharedRoots = roots;
      } catch { roots = []; }
    }
    S.items = [];
    const w = $('#listWrap'); w.innerHTML = '';
    crumbsFor('/Shared');
    $('#countLabel').textContent = `${roots.length} shared folder(s)`;
    if (!roots.length) { w.innerHTML = '<div class="muted" style="padding:30px;text-align:center">No shared folders. Your admin can share storage roots with you.</div>'; return; }
    const g = document.createElement('div'); g.className = 'grid';
    roots.forEach((rp) => {
      const c = document.createElement('div'); c.className = 'card';
      c.innerHTML = `<div class="th">🤝</div><div class="nm">${esc(rp.slice(1))}</div><div class="mt">Shared folder</div>`;
      c.onclick = () => { S.view = 'files'; loadPath(rp); };
      g.appendChild(c);
    });
    w.appendChild(g);
  } catch (e) { toast(e.message); }
}
async function loadRecent() {
  try {
    const d = await api('/api/files/recent?limit=50');
    S.items = d.items; S.view = 'recent';
    $('#countLabel').textContent = `${d.items.length} recent`;
    renderSearchResults();
  } catch (e) { toast(e.message); }
}
async function loadStarred() {
  try {
    const d = await api('/api/files/starred');
    S.items = d.items.map((x) => ({ vpath: x.vpath, name: x.vpath.split('/').pop(), is_dir: false, kind: 'file', size: 0, mtime: x.created_at }));
    S.view = 'starred';
    $('#countLabel').textContent = `${d.items.length} starred`;
    renderSearchResults();
  } catch (e) { toast(e.message); }
}
async function loadTrash() {
  try {
    const d = await api('/api/files/trash');
    S.trash = d.items; S.view = 'trash';
    const w = $('#listWrap'); w.innerHTML = '';
    crumbsFor('/Trash');
    $('#countLabel').textContent = `${d.items.length} item(s)`;
    const bar = document.createElement('div');
    bar.innerHTML = `<button class="btn sm danger" id="emptyTrash">Empty trash</button> `;
    w.appendChild(bar);
    $('#emptyTrash', bar).onclick = async () => {
      if (!confirm('Permanently delete everything in Trash?')) return;
      await api('/api/files/trash/empty', { method: 'POST' });
      loadTrash();
    };
    const t = document.createElement('table'); t.className = 'files';
    t.innerHTML = '<thead><tr><th>Name</th><th>Origin</th><th>Deleted</th><th></th></tr></thead>';
    const tb = document.createElement('tbody');
    d.items.forEach((it) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(it.name)}</td><td class="muted small mono">${esc(it.origin || '')}</td><td class="muted small">${fmtDate(it.deleted_at)}</td><td style="text-align:right"></td>`;
      const cell = $('td:last-child', tr);
      const rb = document.createElement('button'); rb.className = 'btn sm'; rb.textContent = 'Restore';
      rb.onclick = async () => { await api('/api/files/trash/restore', { method: 'POST', body: { ids: [it.trash_id] } }); loadTrash(); };
      const db2 = document.createElement('button'); db2.className = 'btn sm danger'; db2.textContent = 'Delete';
      db2.onclick = async () => { await api('/api/files/trash/delete', { method: 'POST', body: { ids: [it.trash_id] } }); loadTrash(); };
      cell.append(rb, document.createTextNode(' '), db2);
      tb.appendChild(tr);
    });
    t.appendChild(tb); w.appendChild(t);
  } catch (e) { toast(e.message); }
}
function refresh() {
  if (S.view === 'files' || S.view === 'home') loadPath(S.path);
  else nav(S.view);
  refreshStorage();
}
async function refreshStorage() {
  try {
    const [u, b] = await Promise.all([
      api('/api/files/usage'),
      api('/api/files/breakdown').catch(() => null),
    ]);
    const label = u.unlimited ? `${fmtBytes(u.used_bytes)} used (unlimited)` : `${fmtBytes(u.used_bytes)} / ${fmtBytes(u.quota_bytes)}`;
    $('#storageText').textContent = label;
    $('#storageBar').style.width = u.unlimited || !u.quota_bytes ? '4%' : Math.min(100, (u.used_bytes / u.quota_bytes) * 100) + '%';
    $('#storageBreak').textContent = b ? `🎬 ${fmtBytes(b.videos)} · 📕 ${fmtBytes(b.documents)} · 🖼️ ${fmtBytes(b.images)} · 📦 ${fmtBytes(b.other)}` : '';
  } catch {}
}

/* ---------- preview ---------- */
async function preview(vpath, name) {
  $('#pvName').textContent = name || vpath.split('/').pop();
  $('#pvDl').href = '/api/files/download?path=' + encodeURIComponent(vpath);
  const body = $('#pvBody'); body.innerHTML = '<div class="muted">Loading…</div>';
  $('#preview').classList.add('open');
  const ext = (name || vpath).toLowerCase().split('.').pop();
  const imgExt = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];
  const vidExt = ['mp4', 'webm', 'ogv', 'mov', 'm4v'];
  const audExt = ['mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'opus'];
  const url = '/api/files/preview?path=' + encodeURIComponent(vpath);
  if (imgExt.includes(ext)) body.innerHTML = `<img src="${esc(url)}" alt="">`;
  else if (vidExt.includes(ext)) body.innerHTML = `<video src="${esc(url)}" controls playsinline preload="metadata"></video>`;
  else if (audExt.includes(ext)) body.innerHTML = `<audio src="${esc(url)}" controls style="width:100%"></audio>`;
  else if (ext === 'pdf') body.innerHTML = `<iframe src="${esc(url)}" style="width:100%;height:70vh;border:0"></iframe>`;
  else {
    try {
      const d = await api(url);
      if (d && d.type === 'text') {
        body.innerHTML = `<div class="small muted">${fmtBytes(d.size)}${d.truncated ? ' · showing first 512 KB' : ''}</div><pre></pre>`;
        $('pre', body).textContent = d.text;
      } else body.innerHTML = '';
    } catch {
      try {
        const st = await api('/api/files/stat?path=' + encodeURIComponent(vpath));
        body.innerHTML = `<dl class="kv"><dt>Type</dt><dd>${esc(st.mime || 'unknown')}</dd><dt>Size</dt><dd>${fmtBytes(st.size)}</dd></dl><p class="muted">No browser preview for this type — use Download.</p>`;
      } catch (e) { body.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
    }
  }
}

/* ---------- uploads (chunked + progress + cancel/retry) ---------- */
const UPS = new Map(); // id -> {file, relPath, status, loaded, total, xhr, uploadId, speed, t0}
const CHUNK = 4 * 1024 * 1024;

function queueFiles(files, vdir) {
  if (!files.length) return;
  if (!vdir || S.view === 'trash') vdir = '/My Files';
  $('#upPanel').classList.add('open');
  files.forEach((f) => {
    const rel = f.webkitRelativePath || f.name;
    const id = Math.random().toString(36).slice(2);
    UPS.set(id, { id, file: f, relPath: rel, vdir, status: 'queued', loaded: 0, total: f.size, t0: Date.now() });
    renderUp(id);
    pump(id);
  });
  updateUpTotal();
}

function renderUp(id) {
  const u = UPS.get(id);
  let el = $('#up-' + id);
  if (!el) {
    el = document.createElement('div');
    el.className = 'up-item'; el.id = 'up-' + id;
    $('#upList').prepend(el);
  }
  const pct = u.total ? Math.round((u.loaded / u.total) * 100) : 100;
  const el1 = u.t0 && u.loaded ? ` · ${fmtBytes(u.speed || 0)}/s · ${eta(u)}` : '';
  el.innerHTML = `<div class="t"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.relPath)}">${esc(u.relPath)}</span><span>${pct}%</span></div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="meta">${esc(u.status)}${esc(el1)} <span data-act></span></div>`;
  const act = $('[data-act]', el);
  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.className = 'btn sm ghost'; b.textContent = label; b.style.padding = '2px 8px';
    b.onclick = fn; act.appendChild(document.createTextNode(' ')); act.appendChild(b);
  };
  if (u.status === 'uploading') { mkBtn('Pause', () => pauseUp(id)); mkBtn('Cancel', () => cancelUp(id)); }
  if (u.status === 'paused') { mkBtn('Resume', () => resumeUp(id)); mkBtn('Cancel', () => cancelUp(id)); }
  if (u.status === 'error' || u.status === 'cancelled') mkBtn('Retry', () => { if (u.status === 'cancelled') { u.uploadId = null; u.loaded = 0; } u.status = 'queued'; renderUp(id); pump(id); });
  if (u.status === 'done' || u.status === 'error' || u.status === 'cancelled') mkBtn('Dismiss', () => { UPS.delete(id); el.remove(); updateUpTotal(); });
}

function eta(u) {
  if (!u.speed || u.speed < 1) return '…';
  const s = Math.max(0, (u.total - u.loaded) / u.speed);
  return s < 60 ? `${Math.ceil(s)}s left` : `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s left`;
}
function updateUpTotal() {
  const all = [...UPS.values()];
  const done = all.filter((u) => u.status === 'done').length;
  $('#upTotal').textContent = all.length ? `${done}/${all.length}` : '';
  const tot = all.reduce((a, u) => a + u.total, 0);
  const ld = all.reduce((a, u) => a + u.loaded, 0);
  $('#upTitle').textContent = tot ? `Uploads · ${Math.round((ld / tot) * 100)}% overall` : 'Uploads';
}

async function pump(id) {
  const u = UPS.get(id);
  if (!u || u.status !== 'queued') return;
  u.status = 'uploading'; u.t0 = Date.now(); renderUp(id);
  try {
    if (u.total > 8 * 1024 * 1024) await chunkedUp(u);
    else await simpleUp(u);
    u.status = 'done'; u.loaded = u.total;
  } catch (e) {
    if (u.status === 'paused' || e?.paused) { u.status = 'paused'; }
    else if (u.status !== 'cancelled') { u.status = 'error'; u.error = e.message; }
  }
  renderUp(id); updateUpTotal(); refreshStorage();
  if (u.status === 'done' && (S.view === 'files' || S.view === 'home')) loadPath(S.path);
}

async function simpleUp(u) {
  const fd = new FormData();
  // preserve folder structure: create subfolders first via mkdir chain (server sanitizes each segment)
  const dir = u.relPath.includes('/') ? u.relPath.slice(0, u.relPath.lastIndexOf('/')) : '';
  const vdir = await ensureRemoteFolders(u.vdir, dir);
  fd.append('path', vdir);
  fd.append('file', u.file, u.file.name);
  await xhrSend(u, '/api/uploads/simple', 'POST', fd, true);
}

async function ensureRemoteFolders(base, relDir) {
  if (!relDir) return base;
  let cur = base;
  for (const seg of relDir.split('/').filter(Boolean)) {
    try { await api('/api/files/mkdir', { method: 'POST', body: { path: cur, name: seg } }); } catch {}
    cur = cur + '/' + seg;
  }
  return cur;
}

async function chunkedUp(u) {
  const dir = u.relPath.includes('/') ? u.relPath.slice(0, u.relPath.lastIndexOf('/')) : '';
  const vdir = await ensureRemoteFolders(u.vdir, dir);
  if (!u.uploadId) {
    const init = await api('/api/uploads/init', { method: 'POST', body: { path: vdir, filename: u.file.name, total_size: u.total } });
    u.uploadId = init.upload_id;
  }
  // resume: ask the server how much it already has
  try {
    const st = await api(`/api/uploads/${u.uploadId}`);
    if (st && Number.isFinite(st.received)) { u.loaded = Math.min(st.received, u.total); }
  } catch {}
  let offset = u.loaded || 0;
  while (offset < u.total) {
    if (u.status === 'cancelled') throw new Error('cancelled');
    if (u.status === 'paused') { const e = new Error('paused'); e.paused = true; throw e; }
    const slice = u.file.slice(offset, offset + CHUNK);
    const buf = await slice.arrayBuffer();
    u.abort = new AbortController();
    try {
      await fetch(`/api/uploads/${u.uploadId}`, {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'fetch', 'X-CSRF-Token': S.csrf, 'X-Offset': String(offset) },
        body: buf, signal: u.abort.signal,
      }).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'chunk failed');
        offset = d.received;
      });
    } catch (e) {
      if (u.status === 'paused' || e?.name === 'AbortError') { const p = new Error('paused'); p.paused = true; throw p; }
      throw e;
    } finally { u.abort = null; }
    u.loaded = offset;
    u.speed = u.loaded / Math.max(0.5, (Date.now() - u.t0) / 1000);
    renderUp(u.id); updateUpTotal();
  }
  await api(`/api/uploads/${u.uploadId}/complete`, { method: 'POST' });
  u.loaded = u.total;
}

function xhrSend(u, url, method, body, isForm) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    u.xhr = x;
    x.open(method, url);
    x.withCredentials = true;
    x.setRequestHeader('X-Requested-With', 'fetch');
    if (S.csrf) x.setRequestHeader('X-CSRF-Token', S.csrf);
    const t0 = Date.now();
    x.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        u.loaded = e.loaded;
        u.speed = e.loaded / Math.max(0.5, (Date.now() - t0) / 1000);
        renderUp(u.id); updateUpTotal();
      }
    };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) {
        u.loaded = u.total; resolve(x.response);
      } else {
        try { reject(new Error(JSON.parse(x.responseText).error || 'upload failed')); }
        catch { reject(new Error('upload failed (' + x.status + ')')); }
      }
    };
    x.onerror = () => reject(new Error('network error'));
    x.onabort = () => { u.status = 'cancelled'; reject(new Error('cancelled')); };
    x.send(body);
  });
}
function pauseUp(id) {
  const u = UPS.get(id);
  if (!u || u.status !== 'uploading') return;
  u.status = 'paused'; // server-side bytes are kept; Resume continues from `received`
  try { u.abort?.abort(); } catch {}
  try { u.xhr?.abort(); } catch {} // simple uploads restart on resume (small files only)
  if (u.uploadId == null) u.status = 'paused';
  renderUp(id); updateUpTotal();
}
function resumeUp(id) {
  const u = UPS.get(id);
  if (!u || (u.status !== 'paused' && u.status !== 'error' && u.status !== 'cancelled')) return;
  if (u.status === 'cancelled') u.uploadId = null; // cancelled deleted server state; start over
  u.status = 'queued'; u.t0 = Date.now();
  renderUp(id); pump(id);
}
function cancelUp(id) {
  const u = UPS.get(id);
  if (!u) return;
  u.status = 'cancelled';
  try { u.xhr?.abort(); } catch {}
  if (u.uploadId) api(`/api/uploads/${u.uploadId}`, { method: 'DELETE' }).catch(() => {});
  renderUp(id); updateUpTotal();
}

/* ---------- shares ---------- */
async function shareDlg(vpath) {
  modal(`<h3>Share</h3><div class="small muted mono">${esc(vpath)}</div>
    <label>Password (optional)</label><input id="shPw" type="password" placeholder="leave empty for open link">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><label>Expires</label><input id="shExp" type="date"></div>
      <div><label>Max downloads</label><input id="shMax" type="number" min="1" placeholder="unlimited"></div>
    </div>
    <div class="row"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mOk">Create link</button></div>`);
  $('#mCancel').onclick = closeModal;
  $('#mOk').onclick = async () => {
    try {
      const body = { path: vpath };
      if ($('#shPw').value) body.password = $('#shPw').value;
      if ($('#shExp').value) body.expires_at = new Date($('#shExp').value + 'T23:59:59').toISOString();
      if ($('#shMax').value) body.max_downloads = Number($('#shMax').value);
      const r = await api('/api/shares', { method: 'POST', body });
      modal(`<h3>Share link ready</h3>
        <input id="shUrl" readonly value="${esc(r.share.url)}" style="width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px">
        <div class="row"><button class="btn" id="mCopy">Copy</button><button class="btn primary" id="mDone">Done</button></div>`);
      $('#mCopy').onclick = () => { $('#shUrl').select(); document.execCommand('copy'); navigator.clipboard?.writeText(r.share.url); toast('Copied'); };
      $('#mDone').onclick = closeModal;
    } catch (e) { toast(e.message); }
  };
}

/* ---------- modal helpers ---------- */
function modal(html) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.add('open');
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
}
function closeModal() { $('#modal').classList.remove('open'); }
function promptDlg(title, label, initial) {
  return new Promise((resolve) => {
    modal(`<h3>${esc(title)}</h3><label>${esc(label)}</label>
      <input id="mIn" value="${esc(initial || '')}">
      <div class="row"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mOk">OK</button></div>`);
    const inp = $('#mIn'); inp.focus(); inp.select();
    const done = (v) => { closeModal(); resolve(v); };
    $('#mCancel').onclick = () => done(null);
    $('#mOk').onclick = () => done(inp.value.trim() || null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); };
  });
}

/* ---------- admin ---------- */
let adminTab = 'users';
async function loadAdmin(tab) {
  adminTab = tab || adminTab;
  const w = $('#adminWrap'); w.innerHTML = '';
  crumbsFor('/Admin');
  $('#countLabel').textContent = '';
  const tabs = document.createElement('div'); tabs.className = 'tabs';
  ['users', 'storage', 'shares', 'activity', 'settings', 'security'].forEach((t) => {
    const b = document.createElement('button');
    b.textContent = t[0].toUpperCase() + t.slice(1);
    b.classList.toggle('active', t === adminTab);
    b.onclick = () => loadAdmin(t);
    tabs.appendChild(b);
  });
  w.appendChild(tabs);
  const body = document.createElement('div'); w.appendChild(body);
  try {
    if (adminTab === 'users') await adminUsers(body);
    else if (adminTab === 'storage') await adminStorage(body);
    else if (adminTab === 'shares') await adminShares(body);
    else if (adminTab === 'activity') await adminActivity(body);
    else if (adminTab === 'settings') await adminSettings(body);
    else if (adminTab === 'security') await adminSecurity(body);
  } catch (e) { body.innerHTML = `<p style="color:var(--danger)">${esc(e.message)}</p>`; }
}

async function adminUsers(el) {
  const d = await api('/api/users');
  el.innerHTML = `<div style="margin:8px 0"><button class="btn primary sm" id="addUser">＋ New user</button></div>
  <table class="admin-table"><thead><tr><th>User</th><th>Role</th><th>Quota</th><th>Status</th><th></th></tr></thead><tbody></tbody></table>`;
  const tb = $('tbody', el);
  d.users.forEach((u) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${esc(u.username)}</strong></td><td>${u.role}</td>
      <td class="muted">${u.quota_bytes == null ? 'unlimited' : fmtBytes(u.quota_bytes)}</td>
      <td>${u.disabled ? '⛔ disabled' : '✅ active'}${u.totp_enabled ? ' · 2FA' : ''}</td><td style="text-align:right"></td>`;
    const cell = $('td:last-child', tr);
    const btn = (label, fn, cls) => {
      const b = document.createElement('button'); b.className = 'btn sm' + (cls ? ' ' + cls : ''); b.textContent = label; b.style.marginLeft = '4px';
      b.onclick = fn; cell.appendChild(b);
    };
    btn('Quota', async () => {
      const q = await promptDlg('Storage quota', 'Bytes (empty = unlimited)', u.quota_bytes ?? '');
      if (q === null) return;
      await api(`/api/users/${u.id}`, { method: 'PUT', body: { quota_bytes: q === '' ? null : Number(q) } });
      loadAdmin('users');
    });
    btn(u.role === 'admin' ? 'Make user' : 'Make admin', async () => {
      await api(`/api/users/${u.id}`, { method: 'PUT', body: { role: u.role === 'admin' ? 'user' : 'admin' } });
      loadAdmin('users');
    });
    btn('Reset PW', async () => {
      const pw = await promptDlg('Reset password', `New password for ${u.username}`, '');
      if (!pw) return;
      await api(`/api/users/${u.id}/password`, { method: 'POST', body: { password: pw } });
      toast('Password reset; sessions revoked');
    });
    btn(u.disabled ? 'Enable' : 'Disable', async () => {
      await api(`/api/users/${u.id}/${u.disabled ? 'enable' : 'disable'}`, { method: 'POST' });
      loadAdmin('users');
    });
    btn('Delete', async () => {
      if (!confirm(`Delete user ${u.username}? Files on disk are kept.`)) return;
      await api(`/api/users/${u.id}`, { method: 'DELETE' });
      loadAdmin('users');
    }, 'danger');
    tb.appendChild(tr);
  });
  $('#addUser', el).onclick = async () => {
    modal(`<h3>New user</h3><label>Username</label><input id="nu" placeholder="jane">
      <label>Password</label><input id="np" type="password">
      <label>Role</label><select id="nr"><option value="user">user</option><option value="admin">admin</option></select>
      <div class="row"><button class="btn ghost" id="mCancel">Cancel</button><button class="btn primary" id="mOk">Create</button></div>`);
    $('#mCancel').onclick = closeModal;
    $('#mOk').onclick = async () => {
      try {
        await api('/api/users', { method: 'POST', body: { username: $('#nu').value.trim(), password: $('#np').value, role: $('#nr').value } });
        closeModal(); loadAdmin('users');
      } catch (e) { toast(e.message); }
    };
  };
}

async function adminStorage(el) {
  const d = await api('/api/admin/roots');
  const s = await api('/api/admin/storage');
  el.innerHTML = `<p class="muted small">Storage root (server path): <span class="mono">${esc(s.storage_root)}</span></p>
    <div style="margin:8px 0"><button class="btn primary sm" id="addRoot">＋ New shared folder</button></div>
    <table class="admin-table"><thead><tr><th>Name</th><th>Server path</th><th>Size</th><th>Access</th><th></th></tr></thead><tbody></tbody></table>`;
  const tb = $('tbody', el);
  s.roots.forEach((r) => {
    const meta = (d.roots || []).find((x) => x.name === r.name);
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${esc(r.name)}</strong></td><td class="mono small">${esc(r.rel_path)}</td>
      <td class="muted">${fmtBytes(r.bytes)} · ${r.files} files</td>
      <td class="small muted">${meta ? esc(meta.users.map((u) => u.username + '(' + u.permission + ')').join(', ') || '—') : ''}</td>
      <td style="text-align:right"></td>`;
    const cell = $('td:last-child', tr);
    const b1 = document.createElement('button'); b1.className = 'btn sm'; b1.textContent = 'Access';
    b1.onclick = async () => {
      const users = await api('/api/users');
      const ids = await promptDlg('Access', 'Comma-separated usernames (empty = nobody)', (meta?.users || []).map((u) => u.username).join(', '));
      if (ids === null) return;
      const names = ids.split(',').map((x) => x.trim()).filter(Boolean);
      const uids = users.users.filter((u) => names.includes(u.username)).map((u) => u.id);
      await api(`/api/admin/roots/${meta.id}/access`, { method: 'PUT', body: { user_ids: uids, permission: 'write' } });
      loadAdmin('storage');
    };
    const b2 = document.createElement('button'); b2.className = 'btn sm danger'; b2.textContent = 'Remove'; b2.style.marginLeft = '4px';
    b2.onclick = async () => {
      if (!confirm(`Remove shared folder "${r.name}" from Vaultora? Files stay on disk.`)) return;
      await api(`/api/admin/roots/${meta.id}`, { method: 'DELETE' });
      loadAdmin('storage');
    };
    cell.append(b1, b2);
    tb.appendChild(tr);
  });
  $('#addRoot', el).onclick = async () => {
    const name = await promptDlg('New shared folder', 'Name (becomes a folder under the storage root)', '');
    if (!name) return;
    try { await api('/api/admin/roots', { method: 'POST', body: { name } }); loadAdmin('storage'); }
    catch (e) { toast(e.message); }
  };
}

async function adminShares(el) {
  const d = await api('/api/shares');
  el.innerHTML = `<table class="admin-table"><thead><tr><th>Link</th><th>Target</th><th>Owner</th><th>Expires</th><th>DL</th><th></th></tr></thead><tbody></tbody></table>`;
  const tb = $('tbody', el);
  if (!d.shares.length) el.innerHTML += '<p class="muted">No share links yet.</p>';
  d.shares.forEach((sh) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mono small"><a href="${esc(sh.url)}" target="_blank">${esc(sh.token)}</a>${sh.disabled ? ' ⛔' : ''}</td>
      <td class="small mono">${esc(sh.vpath)}</td><td>${esc(sh.owner || '')}</td>
      <td class="small muted">${sh.expires_at ? fmtDate(sh.expires_at) : 'never'}</td>
      <td class="small muted">${sh.download_count}${sh.max_downloads ? '/' + sh.max_downloads : ''}</td>
      <td style="text-align:right"></td>`;
    const cell = $('td:last-child', tr);
    const mk = (label, fn, cls) => {
      const b = document.createElement('button'); b.className = 'btn sm' + (cls ? ' ' + cls : ''); b.textContent = label; b.style.marginLeft = '4px'; b.onclick = fn; cell.appendChild(b);
    };
    mk(sh.disabled ? 'Enable' : 'Disable', async () => { await api(`/api/shares/${sh.id}`, { method: 'PATCH', body: { disabled: !sh.disabled } }); loadAdmin('shares'); });
    mk('Regenerate', async () => { await api(`/api/shares/${sh.id}/regenerate`, { method: 'POST' }); loadAdmin('shares'); });
    mk('Delete', async () => { await api(`/api/shares/${sh.id}`, { method: 'DELETE' }); loadAdmin('shares'); }, 'danger');
    tb.appendChild(tr);
  });
}

async function adminActivity(el) {
  const d = await api('/api/admin/activity?limit=200');
  el.innerHTML = `<p class="muted small">Audit log: login, upload, delete, rename, move, share creation… (${d.total} total)</p>
  <table class="admin-table"><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead><tbody></tbody></table>`;
  const tb = $('tbody', el);
  d.items.forEach((a) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="small muted">${fmtDate(a.at)}</td><td>${esc(a.username || '')}</td><td><strong>${esc(a.action)}</strong></td><td class="small mono">${esc(a.detail || '')}</td><td class="small muted">${esc(a.ip || '')}</td>`;
    tb.appendChild(tr);
  });
}

async function adminSettings(el) {
  const d = await api('/api/admin/settings');
  const s = d.settings;
  const GB = 1024 ** 3;
  const num = (k, label, help) => `<label>${label}</label><input data-k="${k}" value="${esc(s[k] ?? '')}" placeholder="${esc(help || '')}">`;
  el.innerHTML = `<div style="display:grid;gap:4px;max-width:640px">
    ${num('app_url', 'Application URL (used in share links)', 'https://files.example.com')}
    ${num('max_file_size_bytes', 'Max file size (bytes)', String(20 * GB))}
    ${num('default_quota_bytes', 'Default user quota (bytes, empty = unlimited)', '')}
    ${num('session_ttl_hours', 'Session expiration (hours)', '72')}
    ${num('trash_retention_days', 'Trash auto-cleanup (days)', '30')}
    <label style="margin-top:8px"><input type="checkbox" data-k="trash_enabled" ${s.trash_enabled === '1' ? 'checked' : ''} style="width:auto"> Trash enabled</label>
    ${num('share_default_expiry_days', 'Default share expiry (days, empty = never)', '')}
    <label style="margin-top:8px"><input type="checkbox" data-k="share_require_password" ${s.share_require_password === '1' ? 'checked' : ''} style="width:auto"> Require password on shares</label>
    ${num('password_min_length', 'Minimum password length', '8')}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div>${num('login_max_attempts', 'Login attempts', '10')}</div>
      <div>${num('login_window_minutes', '…per minutes', '15')}</div>
    </div>
    <label style="margin-top:8px"><input type="checkbox" data-k="clamav_enabled" ${s.clamav_enabled === '1' ? 'checked' : ''} style="width:auto"> ClamAV antivirus scan (optional daemon)</label>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div>${num('clamav_host', 'ClamAV host', 'clamav')}</div>
      <div>${num('clamav_port', 'ClamAV port', '3310')}</div>
    </div>
    <p class="muted small">Running Vaultora <strong>${esc(d.version || 'dev')}</strong>${d.commit ? ' · ' + esc(d.commit) : ''}. Environment-managed: storage root <span class="mono">${esc(d.storage_root)}</span> · port ${esc(d.port)} · PUID ${esc(d.uid || '—')} PGID ${esc(d.gid || '—')} · TZ ${esc(d.tz || '—')}. Change these in CasaOS / docker-compose, not here.</p>
    <div><button class="btn primary" id="saveSet">Save settings</button>
    <button class="btn" id="runTrash" style="margin-left:8px">Run trash cleanup now</button></div>
  </div>`;
  $('#saveSet', el).onclick = async () => {
    const body = {};
    $$('[data-k]', el).forEach((inp) => {
      body[inp.dataset.k] = inp.type === 'checkbox' ? (inp.checked ? '1' : '0') : inp.value;
    });
    await api('/api/admin/settings', { method: 'PUT', body });
    toast('Settings saved');
  };
  $('#runTrash', el).onclick = async () => {
    const r = await api('/api/admin/maintenance/trash-cleanup', { method: 'POST' });
    toast(`Trash cleanup: removed ${r.cleaned}`);
  };
}

async function adminSecurity(el) {
  const [sess, me] = await Promise.all([api('/api/admin/sessions'), api('/api/auth/me')]);
  void me;
  el.innerHTML = `<h4>Active sessions (all users)</h4>
    <table class="admin-table"><thead><tr><th>User</th><th>Created</th><th>Expires</th><th>IP</th><th></th></tr></thead><tbody></tbody></table>
    <h4 style="margin-top:16px">Two-factor authentication</h4>
    <p class="muted small">TOTP per user. Each user enables it from the account menu; admins can require it per policy.</p>
    <div><button class="btn sm" id="my2fa">Set up 2FA for my account</button></div><div id="tfaBox"></div>`;
  const tb = $('tbody', el);
  sess.sessions.forEach((sn) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${esc(sn.username)}</td><td class="small muted">${fmtDate(sn.created_at)}</td><td class="small muted">${fmtDate(sn.expires_at)}</td><td class="small muted">${esc(sn.ip || '')}</td><td style="text-align:right"></td>`;
    const b = document.createElement('button'); b.className = 'btn sm danger'; b.textContent = 'Revoke';
    b.onclick = async () => { await api(`/api/admin/sessions/${sn.id}`, { method: 'DELETE' }); loadAdmin('security'); };
    $('td:last-child', tr).appendChild(b);
    tb.appendChild(tr);
  });
  $('#my2fa', el).onclick = async () => {
    const r = await api('/api/auth/2fa/setup', { method: 'POST' });
    $('#tfaBox', el).innerHTML = `<p>Add this secret to your authenticator app, then confirm:</p>
      <p class="mono" style="font-size:16px">${esc(r.secret)}</p>
      <p class="small muted mono">${esc(r.otpauth_url)}</p>
      <input id="tfaCode" placeholder="123456" inputmode="numeric"><div style="margin-top:8px"><button class="btn primary sm" id="tfaOk">Confirm & enable</button></div>`;
    $('#tfaOk', el).onclick = async () => {
      try { await api('/api/auth/2fa/enable', { method: 'POST', body: { code: $('#tfaCode').value.trim() } }); toast('2FA enabled'); }
      catch (e) { toast(e.message); }
    };
  };
}

// shared-roots probe cache for non-admins
(async () => {
  try {
    const r = await fetch('/api/files/shared-roots', { credentials: 'same-origin' });
    if (r.ok) { const d = await r.json(); S.sharedRoots = (d.roots || []).map((x) => '/' + x); }
  } catch {}
})();

document.addEventListener('DOMContentLoaded', boot);
