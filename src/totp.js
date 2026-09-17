/**
 * Minimal RFC 6238 TOTP (SHA-1, 30s, 6 digits) — no external deps.
 * Used for optional 2FA.
 */
'use strict';
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomSecret(len = 20) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  // 64-bit big-endian counter
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) {
    msg[i] = Number(c & 0xffn);
    c >>= 8n;
  }
  const h = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code =
    ((h[offset] & 0x7f) << 24) |
    ((h[offset + 1] & 0xff) << 16) |
    ((h[offset + 2] & 0xff) << 8) |
    (h[offset + 3] & 0xff);
  return String(code % 10 ** digits).padStart(digits, '0');
}

function totpNow(secret, { step = 30, digits = 6, time = Date.now() } = {}) {
  const counter = Math.floor(time / 1000 / step);
  return hotp(base32Decode(secret), counter, digits);
}

function verifyTotp(secret, token, { step = 30, digits = 6, window = 1, time = Date.now() } = {}) {
  const t = String(token).replace(/\s+/g, '');
  if (!/^\d{6,8}$/.test(t)) return false;
  const counter = Math.floor(time / 1000 / step);
  const buf = base32Decode(secret);
  for (let w = -window; w <= window; w++) {
    if (hotp(buf, counter + w, digits) === t) return true;
  }
  return false;
}

function otpauthUrl({ secret, account, issuer = 'Vaultora' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}

module.exports = { randomSecret, verifyTotp, totpNow, otpauthUrl };
