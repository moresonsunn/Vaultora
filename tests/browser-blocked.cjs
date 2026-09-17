'use strict';
// Adversarial browser test: simulates an extension/ad-blocker that HANGS
// API requests (like Brave Shields did for the reporter).
// Proves: (1) Sign-in button stays live even while /me hangs,
//         (2) login still succeeds, (3) a hung login surfaces a timeout
//         message instead of a dead button.
const http = require('http');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const tabs = await getJson('http://127.0.0.1:9222/json/list');
  const page = tabs.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
    // deliberately NEVER answer Fetch.requestPaused -> request hangs, like a blocker
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (out.result.exceptionDetails) {
      throw new Error('page JS error: ' + JSON.stringify(out.result.exceptionDetails).slice(0, 300));
    }
    return out.result.result.value;
  };

  await send('Network.enable');
  await send('Network.clearBrowserCookies');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api/auth/me*' }] }); // stall /me forever
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:18083/' });
  await sleep(3000);

  const bound = await evalJs(`JSON.stringify({
    hasHandler: !!document.querySelector('#loginForm').onsubmit,
    loginVisible: !document.querySelector('#loginView').hidden })`);
  console.log('ME HUNG, HANDLER PRESENT:', bound);

  await evalJs(
    `document.querySelector('#liUser').value = 'admin';
     document.querySelector('#liPass').value = 'adminpass123';
     document.querySelector('#loginForm button[type=submit]').click(); 'x'`
  );
  await sleep(4000);
  const loggedIn = await evalJs(
    `JSON.stringify({appVisible: !document.querySelector('#app').hidden,
      uname: document.querySelector('#uname').textContent})`
  );
  console.log('LOGIN WHILE ME HUNG:', loggedIn);

  // now also stall the login call itself -> must end in a timeout MESSAGE
  await send('Network.clearBrowserCookies');
  await send('Fetch.enable', {
    patterns: [{ urlPattern: '*api/auth/me*' }, { urlPattern: '*api/auth/login*' }],
  });
  await send('Page.reload');
  await sleep(2000);
  await evalJs(
    `document.querySelector('#liUser').value = 'admin';
     document.querySelector('#liPass').value = 'adminpass123';
     document.querySelector('#loginForm button[type=submit]').click(); 'x'`
  );
  await sleep(24000);
  const timedOut = await evalJs(
    `JSON.stringify({err: document.querySelector('#loginErr').textContent,
      btn: document.querySelector('#loginForm button[type=submit]').textContent,
      btnEnabled: !document.querySelector('#loginForm button[type=submit]').disabled})`
  );
  console.log('HUNG LOGIN RESULT:', timedOut);
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('BLOCKED TEST FAIL:', e.message);
  process.exit(1);
});
