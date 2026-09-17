const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const tmpStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultora-e2e-storage-'));
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultora-e2e-data-'));
const tmpChromeUser = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultora-e2e-chrome-'));

process.env.PORT = '18083';
process.env.STORAGE_ROOT = tmpStorage;
process.env.APP_DATA = tmpData;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'adminpass123';

const app = require('../src/index.js');
let server;

function waitPort(url, retries = 30) {
  return new Promise((resolve, reject) => {
    const check = (rem) => {
      http
        .get(url, (res) => {
          resolve();
        })
        .on('error', () => {
          if (rem <= 0) return reject(new Error('Timeout waiting for ' + url));
          setTimeout(() => check(rem - 1), 500);
        });
    };
    check(retries);
  });
}

function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    console.log(`\n=== Running ${path.basename(scriptPath)} ===`);
    const p = spawn(process.execPath, [scriptPath], { stdio: 'inherit' });
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`));
    });
  });
}

let chrome;

async function main() {
  server = app.listen(18083, '127.0.0.1', () => {
    console.log('Test server listening on 18083');
  });

  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=9222',
      `--user-data-dir=${tmpChromeUser}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      'http://127.0.0.1:18083/',
    ],
    { stdio: 'ignore' }
  );

  try {
    await waitPort('http://127.0.0.1:9222/json/list');
    console.log('Chrome CDP ready on 9222');
    await waitPort('http://127.0.0.1:18083/health');
    console.log('App ready on 18083');

    await runScript(path.join(__dirname, '../tests/browser-login.cjs'));
    await runScript(path.join(__dirname, '../tests/browser-verify.cjs'));
    await runScript(path.join(__dirname, '../tests/browser-blocked.cjs'));
    console.log('\nALL BROWSER E2E TESTS PASSED!');
  } finally {
    if (chrome) {
      try {
        chrome.kill();
      } catch {}
    }
    if (server) {
      await new Promise((r) => server.close(r));
    }
    try {
      require('../src/db').closeDb();
    } catch {}
    try {
      fs.rmSync(tmpStorage, { recursive: true, force: true });
      fs.rmSync(tmpData, { recursive: true, force: true });
      fs.rmSync(tmpChromeUser, { recursive: true, force: true });
    } catch {}
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('E2E FAILURE:', err);
    process.exit(1);
  });
