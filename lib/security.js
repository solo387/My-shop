const crypto = require('crypto');
const { one, all, run } = require('./db');
const config = require('./config');

// ---------- passwords ----------
// scrypt with a per-password salt. Older hashes ("salt:hash") still work and are upgraded at next login.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `s2$${salt}$${crypto.scryptSync(String(pw), salt, 32, SCRYPT).toString('hex')}`;
}
function checkPassword(pw, stored) {
  stored = String(stored || '');
  let salt, hash, opts;
  if (stored.startsWith('s2$')) [, salt, hash] = stored.split('$'), opts = SCRYPT;
  else [salt, hash] = stored.split(':'), opts = {};
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(String(pw), salt, 32, opts);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const needsRehash = stored => !String(stored || '').startsWith('s2$');
const DUMMY = hashPassword(crypto.randomBytes(8).toString('hex'));
const burnTime = pw => checkPassword(pw, DUMMY);   // same delay whether or not an account exists

const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'admin123', 'admin1234', 'administrator', '11111111', '00000000', 'abc12345', 'iloveyou', 'welcome1', 'letmein1', 'shop12345', 'myshop123']);
function checkNewPassword(pw, { min, phone, username }) {
  pw = String(pw || '');
  if (pw.length < min) return `Password must be at least ${min} characters`;
  if (pw.length > 200) return 'Password is too long';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common. Choose another one';
  if (phone && pw.replace(/\D/g, '') === phone) return 'Do not use your phone number as your password';
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) return 'Do not use the username in the password';
  if (/^(.)\1+$/.test(pw)) return 'Password cannot be one repeated character';
  return '';
}

// ---------- sessions ----------
// The cookie holds a random token; the database only stores its SHA-256, so a stolen database cannot be used to log in.
const KINDS = {
  user: { cookie: 'sid', absolute: 30 * 864e5, idle: 14 * 864e5, sameSite: 'Lax' },
  admin: { cookie: 'asid', absolute: 12 * 3600e3, idle: 2 * 3600e3, sameSite: 'Strict' },
};
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
const cookieName = kind => (config.secure ? '__Host-' : '') + KINDS[kind].cookie;
function cookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
function setCookie(res, name, value, maxAgeSec, sameSite) {
  const prev = res.getHeader('Set-Cookie') || [];
  const c = `${name}=${value}; HttpOnly; SameSite=${sameSite}; Path=/; Max-Age=${maxAgeSec}${config.secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', [].concat(prev, c));
}
function createSession(res, kind, subject, ip) {
  const k = KINDS[kind], token = crypto.randomBytes(32).toString('base64url'), csrf = crypto.randomBytes(24).toString('base64url'), t = Date.now();
  run('DELETE FROM sessions WHERE expires < ? OR last_seen < ?', t, t - KINDS.user.idle);
  run('INSERT INTO sessions (token_hash, kind, subject, csrf, created, last_seen, expires, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha(token), kind, subject, csrf, t, t, t + k.absolute, ip || '');
  setCookie(res, cookieName(kind), token, Math.floor(k.absolute / 1000), k.sameSite);
  return csrf;
}
function getSession(req, kind) {
  const token = cookies(req)[cookieName(kind)]; if (!token) return null;
  const s = one('SELECT * FROM sessions WHERE token_hash = ? AND kind = ?', sha(token), kind); if (!s) return null;
  const t = Date.now();
  if (s.expires < t || s.last_seen + KINDS[kind].idle < t) { run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash); return null; }
  if (t - s.last_seen > 60e3) run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', t, s.token_hash);
  return s;
}
function endSession(req, res, kind) {
  const token = cookies(req)[cookieName(kind)];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
  setCookie(res, cookieName(kind), '', 0, KINDS[kind].sameSite);
}
function endAllSessions(kind, subject, exceptHash) {
  run('DELETE FROM sessions WHERE kind = ? AND subject = ? AND token_hash != ?', kind, subject, exceptHash || '');
}
const csrfOk = (s, header) => !!s && typeof header === 'string' && header.length === s.csrf.length &&
  crypto.timingSafeEqual(Buffer.from(header), Buffer.from(s.csrf));

// ---------- rate limits (in memory) ----------
const buckets = new Map();
function limited(key, max, windowMs) {
  const t = Date.now();
  if (buckets.size > 20000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
  let b = buckets.get(key);
  if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
  return ++b.n > max;
}
const clearLimit = key => buckets.delete(key);

// ---------- account lockout (stored, so it survives restarts) ----------
const LOCK_AFTER = 5, LOCK_MS = 15 * 60e3;
function isLocked(table, row) { return row && row.locked_until > Date.now(); }
function recordFailure(table, row) {
  if (!row) return;
  const failed = row.failed + 1;
  run(`UPDATE ${table} SET failed = ?, locked_until = ? WHERE id = ?`, failed >= LOCK_AFTER ? 0 : failed, failed >= LOCK_AFTER ? Date.now() + LOCK_MS : row.locked_until, row.id);
}
const recordSuccess = (table, row) => run(`UPDATE ${table} SET failed = 0, locked_until = 0 WHERE id = ?`, row.id);

// ---------- audit log ----------
function audit(actor, action, target = '', detail = '', ip = '') {
  run('INSERT INTO audit (at, actor, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
    new Date().toISOString(), actor, action, String(target), typeof detail === 'string' ? detail : JSON.stringify(detail), ip || '');
}

module.exports = {
  hashPassword, checkPassword, needsRehash, burnTime, checkNewPassword,
  createSession, getSession, endSession, endAllSessions, csrfOk, sha, cookies, cookieName,
  limited, clearLimit, isLocked, recordFailure, recordSuccess, audit, LOCK_MS,
};
