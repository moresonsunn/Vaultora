'use strict';
// True end-to-end browser test: drives headless Chrome over CDP,
// fills the login form, clicks Sign in, reads back the DOM state.
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
      throw new Error('page JS error: ' + JSON.stringify(out.result.exceptionDetails).slice(0, 500));
    }
    return out.result.result.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:18083/' });
  await sleep(3000);

  const before = await evalJs(
    `JSON.stringify({appHidden: document.querySelector('#app').hidden,
      loginHidden: document.querySelector('#loginView').hidden,
      hasHandler: !!document.querySelector('#loginForm').onsubmit})`
  );
  console.log('BEFORE CLICK:', before);

  await evalJs(
    `document.querySelector('#liUser').value = 'admin';
     document.querySelector('#liPass').value = 'adminpass123';
     document.querySelector('#loginForm button[type=submit]').click();
     'clicked'`
  );
  await sleep(4000);

  const after = await evalJs(
    `JSON.stringify({appHidden: document.querySelector('#app').hidden,
      loginHidden: document.querySelector('#loginView').hidden,
      err: document.querySelector('#loginErr').textContent,
      uname: document.querySelector('#uname').textContent,
      count: document.querySelector('#countLabel').textContent})`
  );
  console.log('AFTER CLICK:', after);
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('BROWSER TEST FAIL:', e.message);
  process.exit(1);
});
