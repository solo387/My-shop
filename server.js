// Simple shop server — no npm packages needed. Run with:  node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = process.env.PORT || 4080;
const DATA = path.join(__dirname, 'data');
const DBF = path.join(DATA, 'db.json');
const UPLOADS = path.join(DATA, 'uploads');
const PUBLIC = path.join(__dirname, 'public');
const SESSION_DAYS = 14;

// ---------- storage (one JSON file; all money is stored in pesewas) ----------
let db;
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const a = Buffer.from(hash, 'hex'), b = crypto.scryptSync(String(pw), salt, 32);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function save() {
  const tmp = DBF + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DBF);
}
function load() {
  fs.mkdirSync(UPLOADS, { recursive: true });
  if (fs.existsSync(DBF)) {
    db = JSON.parse(fs.readFileSync(DBF, 'utf8'));
  } else {
    db = {
      settings: { shopName: 'My Shop', momoPercent: 40, momoNumber: '', momoName: '', tagline: '', unpaidExpiryHours: 24 },
      admins: [{ username: 'admin', pass: hashPassword('admin123'), defaultPassword: true }],
      users: [], products: [], orders: [], walletTx: [], sessions: {},
      seq: { user: 0, product: 0, order: 0, tx: 0 },
    };
    [['Sample: Rice 5kg', 'Perfumed long grain rice', 12000, 20, 'Groceries'],
     ['Sample: Cooking oil 1L', 'Pure vegetable oil', 4500, 30, 'Groceries'],
     ['Sample: Bar soap', 'Multi-purpose soap', 1000, 50, 'Household']].forEach(([name, description, price, stock, category]) =>
      db.products.push({ id: ++db.seq.product, name, description, price, stock, category, image: '', active: true, createdAt: new Date().toISOString() }));
    save();
  }
  if (db.settings.unpaidExpiryHours == null) db.settings.unpaidExpiryHours = 24;
  const now = Date.now();
  for (const k of Object.keys(db.sessions)) if (db.sessions[k].exp < now) delete db.sessions[k];
}
// Unpaid orders hold stock and wallet credit. Cancel them after the configured number of hours.
function expireUnpaidOrders() {
  const hours = Number(db.settings.unpaidExpiryHours) || 0;
  if (hours <= 0) return;
  const cutoff = Date.now() - hours * 3600e3; let changed = false;
  for (const o of db.orders) if (o.status === 'awaiting_payment' && Date.parse(o.createdAt) < cutoff) { cancelOrder(o, 'expired'); changed = true; }
  if (changed) save();
}

// ---------- THE SHOP DISCOUNT RULE ----------
// MoMo:  take as much of the order as possible from the discount wallet, then the
//        customer pays (momoPercent% of the amount taken from the wallet)
//        + (whatever the wallet could not cover) through MoMo.
//        wallet 30, order 10 -> wallet -10, MoMo 4
//        wallet 5,  order 10 -> wallet -5,  MoMo 2 + 5 = 7
// Cash:  the discount wallet is not touched; the full price is paid in cash.
function quote(total, wallet, method, percent) {
  if (method === 'cash')
    return { total, method, walletDeducted: 0, walletFee: 0, remainder: total, momoDue: 0, cashDue: total, momoPercent: percent };
  const walletDeducted = Math.min(Math.max(wallet, 0), total);
  const walletFee = Math.round(walletDeducted * percent / 100);
  const remainder = total - walletDeducted;
  return { total, method: 'momo', walletDeducted, walletFee, remainder, momoDue: walletFee + remainder, cashDue: 0, momoPercent: percent };
}

// ---------- helpers ----------
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };
const now = () => new Date().toISOString();
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
function money(v, { allowNegative = false, allowZero = true } = {}) {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n) || Math.abs(n) > 1e11) bad('Enter a valid amount');
  if (!allowNegative && n < 0) bad('Amount cannot be negative');
  if (!allowZero && n === 0) bad('Amount cannot be zero');
  return n;
}
function phone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('233') && d.length === 12) d = '0' + d.slice(3);
  if (!/^0\d{9}$/.test(d)) bad('Enter a valid 10-digit phone number, e.g. 0241234567');
  return d;
}
function password(v) { v = String(v || ''); if (v.length < 6) bad('Password must be at least 6 characters'); return v; }
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return out;
}
function startSession(res, name, data) {
  const sid = crypto.randomBytes(24).toString('hex');
  db.sessions[sid] = { ...data, exp: Date.now() + SESSION_DAYS * 864e5 };
  res.setHeader('Set-Cookie', `${name}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`);
}
function endSession(req, res, name) {
  delete db.sessions[cookies(req)[name]];
  res.setHeader('Set-Cookie', `${name}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
function session(req, name, type) {
  const s = db.sessions[cookies(req)[name]];
  return s && s.type === type && s.exp > Date.now() ? s : null;
}
const attempts = new Map();
function throttle(key, max = 8) {
  if (attempts.size > 5000) for (const [k, v] of attempts) if (v.until < Date.now()) attempts.delete(k);
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.n >= max) bad('Too many attempts. Try again in a few minutes.', 429);
  if (!a || a.until < Date.now()) attempts.set(key, { n: 1, until: Date.now() + 10 * 60e3 }); else a.n++;
}
const publicUser = u => ({ id: u.id, name: u.name, phone: u.phone, wallet: u.wallet });
const publicSettings = () => { const s = db.settings; return { shopName: s.shopName, tagline: s.tagline || '', momoPercent: s.momoPercent, momoNumber: s.momoNumber, momoName: s.momoName }; };
function walletMove(user, amount, type, note, orderId) {
  user.wallet += amount;
  db.walletTx.push({ id: ++db.seq.tx, userId: user.id, amount, type, note: note || '', orderId: orderId || null, balanceAfter: user.wallet, at: now() });
}
function cancelOrder(o, by) {
  if (!['awaiting_payment', 'paid'].includes(o.status)) bad('This order can no longer be cancelled');
  o.items.forEach(it => { const p = db.products.find(p => p.id === it.productId); if (p) p.stock += it.qty; });
  const u = db.users.find(u => u.id === o.userId);
  if (u && o.walletDeducted > 0) walletMove(u, o.walletDeducted, 'refund', `Order ${o.number} cancelled`, o.id);
  o.status = 'cancelled'; o.cancelledAt = now(); o.cancelledBy = by;
}
function saveImage(dataUrl, id) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) bad('Image must be a PNG, JPG or WEBP file');
  const buf = Buffer.from(m[2], 'base64'), head = buf.subarray(0, 12).toString('latin1');
  const real = head.startsWith('\x89PNG') ? 'png' : head.startsWith('\xff\xd8\xff') ? 'jpg' : (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') ? 'webp' : null;
  if (!real) bad('That file is not a valid PNG, JPG or WEBP image');
  const name = `p${id}-${Date.now()}.${real}`;
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return '/uploads/' + name;
}
function productFields(b, p) {
  p.name = str(b.name, 120); if (!p.name) bad('Product name is required');
  p.description = str(b.description, 1000);
  p.category = str(b.category, 40);
  if (!p.createdAt) p.createdAt = now();
  p.price = money(b.price, { allowZero: false });
  p.stock = Math.floor(Number(b.stock)); if (!(p.stock >= 0)) bad('Stock must be 0 or more');
  p.active = b.active !== false;
  if (b.imageData) p.image = saveImage(b.imageData, p.id);
  else if (b.removeImage) p.image = '';
}
const adminOrder = o => { const u = db.users.find(u => u.id === o.userId); return { ...o, customer: u ? { name: u.name, phone: u.phone } : null }; };

// ---------- routes ----------
const routes = [];
const route = (method, pattern, auth, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)') + '$'), auth, fn });

// customer
route('GET', '/api/me', null, c => ({ user: c.user ? publicUser(c.user) : null, settings: publicSettings() }));
route('GET', '/api/products', null, () => db.products.filter(p => p.active));
route('POST', '/api/register', null, c => {
  throttle('r' + c.ip, 20);
  const name = str(c.body.name, 80); if (!name) bad('Your name is required');
  const ph = phone(c.body.phone), pw = password(c.body.password);
  if (db.users.some(u => u.phone === ph)) bad('That phone number already has an account. Please log in.');
  const u = { id: ++db.seq.user, name, phone: ph, pass: hashPassword(pw), wallet: 0, createdAt: now() };
  db.users.push(u); startSession(c.res, 'sid', { type: 'user', id: u.id });
  return { user: publicUser(u) };
});
route('POST', '/api/login', null, c => {
  const ph = phone(c.body.phone); throttle('u' + c.ip + ph);
  const u = db.users.find(u => u.phone === ph);
  if (!u || !checkPassword(c.body.password, u.pass)) bad('Wrong phone number or password', 401);
  startSession(c.res, 'sid', { type: 'user', id: u.id });
  return { user: publicUser(u) };
});
route('POST', '/api/logout', null, c => { endSession(c.req, c.res, 'sid'); return {}; });
route('POST', '/api/orders', 'user', c => {
  const method = c.body.method === 'cash' ? 'cash' : 'momo';
  if (!Array.isArray(c.body.items) || !c.body.items.length) bad('Your cart is empty');
  const merged = new Map();
  for (const it of c.body.items) {
    const qty = Math.floor(Number(it.qty)); if (!(qty >= 1)) bad('Invalid quantity');
    merged.set(Number(it.id), (merged.get(Number(it.id)) || 0) + qty);
  }
  const items = []; let total = 0;
  for (const [id, qty] of merged) {
    const p = db.products.find(p => p.id === id && p.active);
    if (!p) bad('An item in your cart is no longer available');
    if (p.stock < qty) bad(`Only ${p.stock} of "${p.name}" left in stock`);
    items.push({ productId: p.id, name: p.name, price: p.price, qty }); total += p.price * qty;
  }
  const payerMomo = method === 'momo' ? phone(c.body.momoNumber || c.user.phone) : '';
  const q = quote(total, c.user.wallet, method, db.settings.momoPercent);
  const id = ++db.seq.order;
  const o = { id, number: 'ORD-' + String(id).padStart(5, '0'), userId: c.user.id, items, ...q,
    payerMomo, momoRef: '', note: str(c.body.note, 300), status: 'awaiting_payment', createdAt: now() };
  items.forEach(it => { db.products.find(p => p.id === it.productId).stock -= it.qty; });
  if (q.walletDeducted > 0) walletMove(c.user, -q.walletDeducted, 'purchase', `Order ${o.number}`, o.id);
  db.orders.push(o);
  return { order: o, user: publicUser(c.user) };
});
route('GET', '/api/orders', 'user', c => db.orders.filter(o => o.userId === c.user.id).reverse());
route('POST', '/api/orders/:id/reference', 'user', c => {
  const o = db.orders.find(o => o.id === c.id && o.userId === c.user.id) || bad('Order not found', 404);
  if (o.status !== 'awaiting_payment' || o.method !== 'momo') bad('This order is not waiting for a MoMo payment');
  o.momoRef = str(c.body.reference, 60); if (!o.momoRef) bad('Enter the MoMo transaction ID');
  return { order: o };
});
route('POST', '/api/orders/:id/cancel', 'user', c => {
  const o = db.orders.find(o => o.id === c.id && o.userId === c.user.id) || bad('Order not found', 404);
  if (o.status !== 'awaiting_payment') bad('Only unpaid orders can be cancelled. Please contact the shop.');
  cancelOrder(o, 'customer');
  return { order: o, user: publicUser(c.user) };
});

// admin
route('POST', '/api/admin/login', null, c => {
  throttle('a' + c.ip);
  const a = db.admins.find(a => a.username === str(c.body.username).toLowerCase());
  if (!a || !checkPassword(c.body.password, a.pass)) bad('Wrong username or password', 401);
  startSession(c.res, 'asid', { type: 'admin', username: a.username });
  return { username: a.username };
});
route('POST', '/api/admin/logout', null, c => { endSession(c.req, c.res, 'asid'); return {}; });
route('GET', '/api/admin/me', 'admin', c => ({ username: c.admin.username, defaultPassword: !!c.admin.defaultPassword, settings: db.settings }));
route('POST', '/api/admin/password', 'admin', c => {
  if (!checkPassword(c.body.current, c.admin.pass)) bad('Current password is wrong');
  c.admin.pass = hashPassword(password(c.body.next)); delete c.admin.defaultPassword; return {};
});
route('GET', '/api/admin/summary', 'admin', () => {
  const live = db.orders.filter(o => o.status !== 'cancelled'), paid = live.filter(o => o.status !== 'awaiting_payment');
  const sum = (a, k) => a.reduce((s, o) => s + o[k], 0);
  return {
    awaiting: live.length - paid.length, paidOrders: paid.length,
    momoCollected: sum(paid, 'momoDue'), cashCollected: sum(paid, 'cashDue'), walletUsed: sum(paid, 'walletDeducted'),
    walletOutstanding: db.users.reduce((s, u) => s + u.wallet, 0), customers: db.users.length,
    lowStock: db.products.filter(p => p.active && p.stock <= 3).map(p => ({ name: p.name, stock: p.stock })),
  };
});
route('GET', '/api/admin/products', 'admin', () => db.products);
route('POST', '/api/admin/products', 'admin', c => { const p = { id: ++db.seq.product, image: '' }; productFields(c.body, p); db.products.push(p); return p; });
route('PUT', '/api/admin/products/:id', 'admin', c => { const p = db.products.find(p => p.id === c.id) || bad('Product not found', 404); productFields(c.body, p); return p; });
route('DELETE', '/api/admin/products/:id', 'admin', c => { db.products = db.products.filter(p => p.id !== c.id); return {}; });
route('GET', '/api/admin/customers', 'admin', () => db.users.map(u => ({ ...publicUser(u), createdAt: u.createdAt, orders: db.orders.filter(o => o.userId === u.id).length })));
route('POST', '/api/admin/customers', 'admin', c => {
  const name = str(c.body.name, 80); if (!name) bad('Name is required');
  const ph = phone(c.body.phone); if (db.users.some(u => u.phone === ph)) bad('That phone number already has an account');
  const u = { id: ++db.seq.user, name, phone: ph, pass: hashPassword(password(c.body.password)), wallet: 0, createdAt: now() };
  db.users.push(u);
  const w = money(c.body.wallet || 0); if (w > 0) walletMove(u, w, 'credit', 'Opening balance');
  return publicUser(u);
});
route('PUT', '/api/admin/customers/:id', 'admin', c => {
  const u = db.users.find(u => u.id === c.id) || bad('Customer not found', 404);
  const name = str(c.body.name, 80); if (!name) bad('Name is required');
  const ph = phone(c.body.phone); if (db.users.some(x => x.phone === ph && x.id !== u.id)) bad('That phone number is used by another customer');
  u.name = name; u.phone = ph; if (c.body.password) u.pass = hashPassword(password(c.body.password));
  return publicUser(u);
});
route('POST', '/api/admin/customers/:id/wallet', 'admin', c => {
  const u = db.users.find(u => u.id === c.id) || bad('Customer not found', 404);
  const amount = money(c.body.amount, { allowNegative: true, allowZero: false });
  if (u.wallet + amount < 0) bad('The wallet cannot go below zero');
  walletMove(u, amount, amount > 0 ? 'credit' : 'debit', str(c.body.note, 200) || 'Adjusted by admin');
  return publicUser(u);
});
route('GET', '/api/admin/customers/:id/wallet', 'admin', c => db.walletTx.filter(t => t.userId === c.id).reverse());
route('GET', '/api/admin/orders', 'admin', () => db.orders.map(adminOrder).reverse());
route('POST', '/api/admin/orders/:id/status', 'admin', c => {
  const o = db.orders.find(o => o.id === c.id) || bad('Order not found', 404), a = c.body.action;
  if (a === 'paid') { if (o.status !== 'awaiting_payment') bad('Order is not awaiting payment'); o.status = 'paid'; o.paidAt = now(); }
  else if (a === 'delivered') { if (o.status !== 'paid') bad('Confirm payment before marking as delivered'); o.status = 'delivered'; o.deliveredAt = now(); }
  else if (a === 'cancel') cancelOrder(o, 'admin');
  else bad('Unknown action');
  return adminOrder(o);
});
route('PUT', '/api/admin/settings', 'admin', c => {
  const s = db.settings, b = c.body;
  s.shopName = str(b.shopName, 60) || 'My Shop'; s.tagline = str(b.tagline, 90);
  const pct = Number(b.momoPercent); if (!(pct >= 0 && pct <= 100)) bad('The MoMo percentage must be between 0 and 100');
  s.momoPercent = pct; s.momoNumber = str(b.momoNumber, 20); s.momoName = str(b.momoName, 80);
  if (b.unpaidExpiryHours !== undefined) { const h = Number(b.unpaidExpiryHours); if (!(h >= 0 && h <= 720)) bad('Unpaid order expiry must be between 0 and 720 hours'); s.unpaidExpiryHours = h; }
  return s;
});

// ---------- server ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveFile(res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', ch => { size += ch.length; if (size > 6e6) { reject(new HttpError(413, 'That file is too large (max 4 MB)')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Invalid request')); } });
    req.on('error', reject);
  });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'); let p;
  try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end(); }
  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (p.startsWith('/uploads/')) return serveFile(res, UPLOADS, p.slice(9));
    return serveFile(res, PUBLIC, p === '/' ? 'index.html' : p === '/admin' ? 'admin.html' : p.slice(1));
  }
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  try {
    let m; const r = routes.find(r => r.method === req.method && (m = r.re.exec(p)));
    if (!r) bad('Not found', 404);
    const c = { req, res, ip: req.socket.remoteAddress, id: m[1] ? Number(m[1]) : null, body: {} };
    if (req.method !== 'GET') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) bad('Invalid request');
      c.body = await readBody(req);
    }
    const us = session(req, 'sid', 'user'); c.user = us ? db.users.find(u => u.id === us.id) : null;
    const as = session(req, 'asid', 'admin'); c.admin = as ? db.admins.find(a => a.username === as.username) : null;
    if (r.auth === 'user' && !c.user) bad('Please log in first', 401);
    if (r.auth === 'admin' && !c.admin) bad('Admin login required', 401);
    const out = r.fn(c);
    if (req.method !== 'GET') save();
    send(200, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(e instanceof HttpError ? e.code : 500, { error: e instanceof HttpError ? e.message : 'Something went wrong on the server' });
  }
});
if (require.main === module) {
  load(); expireUnpaidOrders(); setInterval(expireUnpaidOrders, 15 * 60e3).unref();
  // If the port is taken (another copy still running, or another program), try the next few.
  let port = Number(PORT), tries = 0;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && tries++ < 10) { console.log(`Port ${port} is busy, trying ${port + 1}...`); port++; setTimeout(() => server.listen(port), 200); }
    else if (e.code === 'EACCES') { console.error(`Windows will not allow port ${port} to be used. Run:  set PORT=5000 && node server.js  to pick another.`); process.exit(1); }
    else { console.error('Could not start the shop:', e.message); process.exit(1); }
  });
  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`\nShop is running.\n  Shop:   ${url}\n  Admin:  ${url}/admin\n\nKeep this window open. Press Ctrl+C to stop.\n`);
    if (process.argv.includes('--open')) {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url + '/admin']] : process.platform === 'darwin' ? ['open', [url + '/admin']] : ['xdg-open', [url + '/admin']];
      try { require('child_process').spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
  });
}
module.exports = { quote, expireUnpaidOrders };
