'use strict';
// Full browser verification: wrong password -> visible error;
// correct password -> login hides, app shows (full-page screenshot proof).
const http = require('http');
const fs = require('fs');

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
      throw new Error('page JS error: ' + JSON.stringify(out.result.exceptionDetails).slice(0, 300));
    }
    return out.result.result.value;
  };

  await send('Network.enable');
  await send('Network.clearBrowserCookies');
  await send('Page.reload');
  await sleep(3000);

  // 1. wrong password -> error text must appear
  await evalJs(
    `document.querySelector('#liUser').value = 'admin';
     document.querySelector('#liPass').value = 'definitely-wrong';
     document.querySelector('#loginForm button[type=submit]').click(); 'x'`
  );
  await sleep(2500);
  const bad = await evalJs(
    `JSON.stringify({err: document.querySelector('#loginErr').textContent,
      loginVisible: !document.querySelector('#loginView').hidden,
      appVisible: !document.querySelector('#app').hidden})`
  );
  console.log('WRONG PASSWORD:', bad);

  // 2. correct password -> app visible, login gone
  await evalJs(
    `document.querySelector('#liPass').value = 'adminpass123';
     document.querySelector('#loginForm button[type=submit]').click(); 'x'`
  );
  await sleep(4000);
  const good = await evalJs(
    `JSON.stringify({err: document.querySelector('#loginErr').textContent,
      loginVisible: !document.querySelector('#loginView').hidden,
      appVisible: !document.querySelector('#app').hidden,
      uname: document.querySelector('#uname').textContent,
      loginDisplay: getComputedStyle(document.querySelector('#loginView')).display,
      appDisplay: getComputedStyle(document.querySelector('#app')).display})`
  );
  console.log('RIGHT PASSWORD:', good);

  // 3. full-page screenshot proof
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(
    'C:\\Users\\phili\\AppData\\Local\\Temp\\vapp-fixed.png',
    Buffer.from(shot.result.data, 'base64')
  );
  console.log('screenshot saved');
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('BROWSER VERIFY FAIL:', e.message);
  process.exit(1);
});
