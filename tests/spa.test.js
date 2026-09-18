/** SPA shell test: proves the built React app is served (skips when not built,
 *  e.g. backend-only CI job — the frontend job covers the build itself). */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');

test('built SPA shell served when present', async () => {
  if (!fs.existsSync(INDEX)) {
    console.log('skip: frontend not built (public/index.html absent)');
    return;
  }
  const html = fs.readFileSync(INDEX, 'utf8');
  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /<script type="module"/);
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.equal(inline.length, 0, 'no inline scripts (CSP has no unsafe-inline)');
  const dir = path.join(__dirname, '..', 'public', 'assets');
  const js = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(js.length >= 1, 'built JS bundle exists');
});
