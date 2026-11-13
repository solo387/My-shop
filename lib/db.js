// SQLite database (built into Node.js, nothing to install).
// All money is stored as whole pesewas (GH₵ 1.00 = 100).
const fs = require('fs'), path = require('path');

let sqlite;
try { sqlite = require('node:sqlite'); }
catch {
  console.error('\nThis shop needs Node.js version 22.13 or newer.\nInstall the "LTS" version from https://nodejs.org and run start.bat again.\n');
  process.exit(1);
}

const SCHEMA = [
  // version 1
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE admins (
     id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, pass TEXT NOT NULL,
     default_password INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL);
   CREATE TABLE users (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, email TEXT NOT NULL DEFAULT '', pass TEXT NOT NULL,
     wallet INTEGER NOT NULL DEFAULT 0 CHECK (wallet >= 0),
     failed INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
   CREATE TABLE products (
     id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
     price INTEGER NOT NULL CHECK (price > 0), stock INTEGER NOT NULL CHECK (stock >= 0),
     image TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
   CREATE TABLE orders (
     id INTEGER PRIMARY KEY, number TEXT UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id),
     total INTEGER NOT NULL, method TEXT NOT NULL CHECK (method IN ('momo', 'cash')),
     wallet_deducted INTEGER NOT NULL, wallet_fee INTEGER NOT NULL, remainder INTEGER NOT NULL,
     momo_due INTEGER NOT NULL, cash_due INTEGER NOT NULL, momo_percent REAL NOT NULL,
     payer_momo TEXT NOT NULL DEFAULT '', momo_ref TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'paid', 'delivered', 'cancelled')),
     paid_via TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL, paid_at TEXT, delivered_at TEXT, cancelled_at TEXT, cancelled_by TEXT);
   CREATE TABLE order_items (
     order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER, name TEXT NOT NULL,
     price INTEGER NOT NULL, qty INTEGER NOT NULL CHECK (qty > 0));
   CREATE TABLE wallet_tx (
     id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, type TEXT NOT NULL,
     note TEXT NOT NULL DEFAULT '', order_id INTEGER, balance_after INTEGER NOT NULL CHECK (balance_after >= 0), at TEXT NOT NULL);
   CREATE TABLE payments (
     reference TEXT PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), amount INTEGER NOT NULL,
     status TEXT NOT NULL, provider_status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, subject INTEGER NOT NULL, csrf TEXT NOT NULL,
     created INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires INTEGER NOT NULL, ip TEXT NOT NULL DEFAULT '');
   CREATE TABLE audit (
     id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
     target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '');
   CREATE INDEX orders_user ON orders(user_id);
   CREATE INDEX orders_status ON orders(status);
   CREATE INDEX items_order ON order_items(order_id);
   CREATE INDEX wallet_user ON wallet_tx(user_id);
   CREATE INDEX payments_order ON payments(order_id);
   CREATE INDEX sessions_subject ON sessions(kind, subject);`,
];

let db;
const cache = new Map();
const stmt = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
const one = (sql, ...a) => stmt(sql).get(...a);
const all = (sql, ...a) => stmt(sql).all(...a);
const run = (sql, ...a) => stmt(sql).run(...a);

// Everything inside fn() is saved together or not at all.
let depth = 0;
function tx(fn) {
  if (depth) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  finally { depth--; }
}

function open(dataDir) {
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
  const file = path.join(dataDir, 'shop.db');
  const isNew = !fs.existsSync(file);
  db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < SCHEMA.length; i++) tx(() => { db.exec(SCHEMA[i]); db.exec(`PRAGMA user_version = ${i + 1}`); });
  return { isNew, file };
}

// One copy per day in data/backups, keeping the most recent ones.
function backup(dataDir, keepDays) {
  const dir = path.join(dataDir, 'backups'); fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10), target = path.join(dir, `shop-${day}.db`);
  if (!fs.existsSync(target)) db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  const files = fs.readdirSync(dir).filter(f => /^shop-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keepDays))) try { fs.unlinkSync(path.join(dir, f)); } catch {}
}

module.exports = { open, one, all, run, tx, backup, raw: () => db };
