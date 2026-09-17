/**
 * Vaultora — SQLite metadata store + migrations.
 * Files themselves NEVER live here; only metadata (users, shares, audit, etc).
 * DB path: DATA_DIR/vaultora.db (bind-mounted, survives recreation).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.APP_DATA || process.env.DATA_DIR || '/app/data';
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'vaultora.db');

let db = null;

function openDb(dbPath) {
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  return d;
}

function migrate(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    quota_bytes INTEGER, -- NULL = unlimited (default from settings)
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS storage_roots (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,          -- e.g. Documents, Videos, Minecraft
    rel_path TEXT UNIQUE NOT NULL,      -- relative to STORAGE_ROOT, sanitized, e.g. Documents
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS root_access (
    root_id TEXT NOT NULL REFERENCES storage_roots(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL DEFAULT 'write' CHECK (permission IN ('read','write')),
    PRIMARY KEY (root_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS starred (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vpath TEXT NOT NULL,               -- virtual path e.g. /My Files/a.txt or /Documents/x
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, vpath)
  );

  CREATE TABLE IF NOT EXISTS file_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_scope TEXT NOT NULL,          -- username that can see it (owner) or '*' for shared roots
    vpath TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mtime TEXT NOT NULL,
    is_dir INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_file_index_scope ON file_index(user_scope);
  CREATE INDEX IF NOT EXISTS idx_file_index_name ON file_index(name);

  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vpath TEXT NOT NULL,               -- virtual path at creation time
    phys_rel TEXT NOT NULL,            -- physical path relative to STORAGE_ROOT (resolved once)
    is_dir INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT,                -- NULL = no password
    expires_at TEXT,                   -- NULL = never
    max_downloads INTEGER,             -- NULL = unlimited
    download_count INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);
  CREATE INDEX IF NOT EXISTS idx_shares_owner ON shares(owner_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    action TEXT NOT NULL,              -- login, logout, upload, delete, rename, move, copy, mkdir, share_create, share_access, trash_restore, ...
    detail TEXT,
    ip TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    vdir TEXT NOT NULL,                -- destination virtual dir
    phys_rel TEXT NOT NULL,            -- destination physical rel path (dir)
    total_size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active', -- active|complete|cancelled|expired
    tmp_rel TEXT NOT NULL,             -- tmp file rel to STORAGE_ROOT/.tmp
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `);

  // Seed default settings if absent
  const defaults = defaultSettings();
  const get = d.prepare('SELECT value FROM settings WHERE key = ?');
  const put = d.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, datetime('now')) ON CONFLICT(key) DO NOTHING"
  );
  for (const [k, v] of Object.entries(defaults)) {
    if (!get.get(k)) put.run(k, v);
  }

  // Seed admin user if none exists (only when no users at all)
  const count = d.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const bcrypt = require('bcryptjs');
    const { v4: uuidv4 } = require('uuid');
    const now = new Date().toISOString();
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'changeme123';
    const hash = bcrypt.hashSync(adminPass, 12);
    d.prepare(
      'INSERT INTO users(id, username, password_hash, role, created_at, updated_at) VALUES(?,?,?,?,?,?)'
    ).run(uuidv4(), adminUser, hash, 'admin', now, now);
    d.prepare(
      "INSERT INTO audit_log(at, username, action, detail) VALUES(datetime('now'), ?, 'seed', 'initial admin user created')"
    ).run(adminUser);
  }

  const ver = d.prepare('SELECT MAX(version) AS v FROM schema_version').get().v || 0;
  if (ver < 1) d.prepare('INSERT INTO schema_version(version, applied_at) VALUES(1, datetime(\'now\'))').run();
}

function defaultSettings() {
  return {
    app_url: process.env.APP_URL || 'http://localhost:8090',
    session_ttl_hours: process.env.SESSION_TTL_HOURS || '72',
    max_file_size_bytes: process.env.MAX_FILE_SIZE || String(20 * 1024 * 1024 * 1024), // 20 GiB
    default_quota_bytes: process.env.DEFAULT_QUOTA || '', // empty = unlimited
    trash_retention_days: process.env.TRASH_RETENTION_DAYS || '30',
    trash_enabled: '1',
    share_default_expiry_days: process.env.SHARE_DEFAULT_EXPIRY_DAYS || '',
    share_require_password: '0',
    allow_signup: '0',
    password_min_length: '8',
    login_max_attempts: '10',
    login_window_minutes: '15',
    clamav_enabled: '0',
    clamav_host: process.env.CLAMAV_HOST || 'clamav',
    clamav_port: process.env.CLAMAV_PORT || '3310',
  };
}

function getDb() {
  if (!db) {
    db = openDb(DB_PATH);
    migrate(db);
  }
  return db;
}

function closeDb() {
  try {
    if (db) {
      try { db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run(); } catch {}
      db.close();
    }
  } catch {}
  db = null;
}

function getSetting(d, key, fallback = '') {
  const row = d.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(d, key, value) {
  d.prepare(
    "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')"
  ).run(key, String(value));
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : require('uuid').v4();
}

if (require.main === module && process.argv.includes('--migrate-only')) {
  getDb();
  // eslint-disable-next-line no-console
  console.log('migrated', DB_PATH);
}

module.exports = { getDb, closeDb, getSetting, setSetting, defaultSettings, DB_PATH, DATA_DIR, newId, openDb, migrate };
