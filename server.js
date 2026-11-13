// Shop server. No npm packages needed: Node.js 22.13+ only.  Run:  node server.js
// Quieten Node's "SQLite is experimental" notice; everything else is still shown.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w && w.message || w).includes('SQLite') ? undefined : emitWarning.call(process, w, ...a));

const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const config = require('./lib/config');
const D = require('./lib/db');
const { one, all, run, tx } = D;
const S = require('./lib/security');
const paystack = require('./lib/paystack');

const PUBLIC = path.join(__dirname, 'public');
const UPLOADS = path.join(config.dataDir, 'uploads');

// ---------- small helpers ----------
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (msg, code = 400) => { throw new HttpError(code, msg); };
const now = () => new Date().toISOString();
const str = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
function money(v, { allowNegative = false, allowZero = true } = {}) {
  const n = Math.round(Number(v) * 100);
  if (v === '' || v == null || !Number.isFinite(n) || Math.abs(n) > 1e11) bad('Enter a valid amount');
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
function email(v, required) {
  const e = str(v, 120).toLowerCase();
  if (!e) { if (required) bad('Enter your email address. Paystack sends your payment receipt there.'); return ''; }
  if (!/^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e)) bad('Enter a valid email address');
  return e;
}
function newPassword(pw, opts) { const msg = S.checkNewPassword(pw, opts); if (msg) bad(msg); return String(pw); }
const pad = id => 'ORD-' + String(id).padStart(5, '0');

// ---------- THE SHOP DISCOUNT RULE (the only place it is calculated) ----------
// MoMo:  take as much of the order as possible from the discount wallet; the customer then pays
//        (momoPercent% of the amount taken from the wallet) + (whatever the wallet did not cover) by MoMo.
//        wallet 30, order 10 -> wallet -10, MoMo 4      wallet 5, order 10 -> wallet -5, MoMo 2 + 5 = 7
// Cash:  the wallet is not touched; the full price is paid in cash.
function quote(total, wallet, method, percent) {
  if (method === 'cash') return { total, method, walletDeducted: 0, walletFee: 0, remainder: total, momoDue: 0, cashDue: total, momoPercent: percent };
  const walletDeducted = Math.min(Math.max(wallet, 0), total);
  const walletFee = Math.round(walletDeducted * percent / 100);
  const remainder = total - walletDeducted;
  return { total, method: 'momo', walletDeducted, walletFee, remainder, momoDue: walletFee + remainder, cashDue: 0, momoPercent: percent };
}

// ---------- settings ----------
const DEFAULTS = { shopName: 'My Shop', tagline: '', momoPercent: 40, momoNumber: '', momoName: '', unpaidExpiryHours: 24 };
function settings() { const s = { ...DEFAULTS }; for (const r of all('SELECT key, value FROM settings')) s[r.key] = JSON.parse(r.value); return s; }
const setSetting = (k, v) => run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, JSON.stringify(v));
const publicSettings = () => { const s = settings(); return { shopName: s.shopName, tagline: s.tagline, momoPercent: s.momoPercent, momoNumber: s.momoNumber, momoName: s.momoName }; };

// ---------- shapes sent to the browser ----------
const productOut = p => ({ id: p.id, name: p.name, description: p.description, category: p.category, price: p.price, stock: p.stock, image: p.image, active: !!p.active, createdAt: p.created_at });
const userOut = u => ({ id: u.id, name: u.name, phone: u.phone, email: u.email, wallet: u.wallet });
function orderOut(o, forAdmin) {
  const out = {
    id: o.id, number: o.number, userId: o.user_id, total: o.total, method: o.method,
    walletDeducted: o.wallet_deducted, walletFee: o.wallet_fee, remainder: o.remainder, momoDue: o.momo_due, cashDue: o.cash_due,
    momoPercent: o.momo_percent, payerMomo: o.payer_momo, momoRef: o.momo_ref, note: o.note, status: o.status, paidVia: o.paid_via,
    createdAt: o.created_at, paidAt: o.paid_at, deliveredAt: o.delivered_at, cancelledAt: o.cancelled_at, cancelledBy: o.cancelled_by,
    items: all('SELECT product_id AS productId, name, price, qty FROM order_items WHERE order_id = ?', o.id),
  };
  if (forAdmin) {
    const u = one('SELECT name, phone FROM users WHERE id = ?', o.user_id);
    out.customer = u ? { name: u.name, phone: u.phone } : null;
    out.payments = all('SELECT reference, amount, status, provider_status AS providerStatus, created_at AS createdAt FROM payments WHERE order_id = ? ORDER BY created_at', o.id);
  }
  return out;
}

// ---------- wallet, orders, payments ----------
function walletMove(userId, amount, type, note, orderId) {
  const u = one('SELECT wallet FROM users WHERE id = ?', userId), bal = u.wallet + amount;
  if (bal < 0) bad('The wallet cannot go below zero');
  run('UPDATE users SET wallet = ? WHERE id = ?', bal, userId);
  run('INSERT INTO wallet_tx (user_id, amount, type, note, order_id, balance_after, at) VALUES (?, ?, ?, ?, ?, ?, ?)', userId, amount, type, note || '', orderId || null, bal, now());
  return bal;
}
function priceItems(input) {
  if (!Array.isArray(input) || !input.length) bad('Your cart is empty');
  if (input.length > 100) bad('Too many different items in one order');
  const merged = new Map();
  for (const it of input) {
    const id = Number(it && it.id), qty = Number(it && it.qty);
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty < 1 || qty > 1e6) bad('Invalid item in cart');
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const items = []; let total = 0;
  for (const [id, qty] of merged) {
    const p = one('SELECT * FROM products WHERE id = ? AND active = 1', id);
    if (!p) bad('An item in your cart is no longer available');
    if (p.stock < qty) bad(`Only ${p.stock} of "${p.name}" left in stock`);
    items.push({ productId: p.id, name: p.name, price: p.price, qty }); total += p.price * qty;
  }
  return { items, total };
}
function cancelOrder(o, by) {
  if (!['awaiting_payment', 'paid'].includes(o.status)) bad('This order can no longer be cancelled');
  for (const it of all('SELECT product_id, qty FROM order_items WHERE order_id = ?', o.id))
    if (it.product_id) run('UPDATE products SET stock = stock + ? WHERE id = ?', it.qty, it.product_id);
  if (o.wallet_deducted > 0) walletMove(o.user_id, o.wallet_deducted, 'refund', `Order ${o.number} cancelled`, o.id);
  run("UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ?", now(), by, o.id);
}
const baseUrl = req => config.publicUrl || `${reqProto(req)}://${req.headers.host}`;
async function startPayment(o, user, emailInput, req) {
  if (!config.paystack.enabled) bad('Online MoMo payment is not set up for this shop');
  if (o.status !== 'awaiting_payment' || o.method !== 'momo' || o.momo_due <= 0) bad('This order is not waiting for a MoMo payment');
  const mail = email(emailInput || user.email, true);
  const reference = `${o.number}-${crypto.randomBytes(5).toString('hex')}`;
  tx(() => {
    if (mail !== user.email) run('UPDATE users SET email = ? WHERE id = ?', mail, user.id);
    run("INSERT INTO payments (reference, order_id, amount, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)", reference, o.id, o.momo_due, now(), now());
  });
  let data;
  try { data = await paystack.initialize({ email: mail, amount: o.momo_due, reference, callbackUrl: `${baseUrl(req)}/?pay=return`, metadata: { orderId: o.id, orderNumber: o.number } }); }
  catch (e) { data = null; console.error('Paystack initialize failed:', e.message); }
  const url = data && data.authorization_url;
  if (!url || !(/^https:\/\//.test(url) || config.paystack.baseUrl.startsWith('http://'))) {
    run("UPDATE payments SET status = 'not_started', updated_at = ? WHERE reference = ?", now(), reference);
    bad('Could not open the MoMo payment page right now. Your order is saved; tap "Pay now" again in a moment.', 502);
  }
  return url;
}
// Called by the webhook, by the customer returning from Paystack, and by the unpaid-order check. Safe to call twice.
function applyPayment(reference, data, source) {
  return tx(() => {
    const p = one('SELECT * FROM payments WHERE reference = ?', reference);
    if (!p) return { ok: false, reason: 'unknown' };
    if (p.status !== 'pending') return { ok: p.status === 'success', reason: p.status };
    const status = String(data && data.status || '');
    if (status !== 'success') { run('UPDATE payments SET provider_status = ?, updated_at = ? WHERE reference = ?', status.slice(0, 40), now(), reference); return { ok: false, reason: status || 'pending' }; }
    const o = one('SELECT * FROM orders WHERE id = ?', p.order_id);
    if (Number(data.amount) !== p.amount || String(data.currency || '').toUpperCase() !== 'GHS') {
      run("UPDATE payments SET status = 'mismatch', provider_status = ?, updated_at = ? WHERE reference = ?", `${data.amount} ${data.currency}`.slice(0, 40), now(), reference);
      S.audit('paystack', 'payment.mismatch', o.number, { reference, expected: p.amount, received: data.amount, currency: data.currency });
      return { ok: false, reason: 'mismatch' };
    }
    if (o.status === 'awaiting_payment' && o.momo_due === p.amount) {
      run("UPDATE orders SET status = 'paid', paid_via = 'paystack', paid_at = ?, momo_ref = ? WHERE id = ?", now(), reference, o.id);
      run("UPDATE payments SET status = 'success', provider_status = 'success', updated_at = ? WHERE reference = ?", now(), reference);
      S.audit('paystack', 'order.paid', o.number, { reference, amount: p.amount, source });
      return { ok: true, reason: 'success' };
    }
    // Money arrived for an order that was cancelled or already paid: it has to be refunded.
    run("UPDATE payments SET status = 'needs_refund', provider_status = 'success', updated_at = ? WHERE reference = ?", now(), reference);
    S.audit('paystack', 'payment.needs_refund', o.number, { reference, amount: p.amount, orderStatus: o.status });
    return { ok: false, reason: 'needs_refund' };
  });
}
async function checkPendingPayments(orderId) {
  if (!config.paystack.enabled) return;
  for (const p of all("SELECT reference FROM payments WHERE order_id = ? AND status = 'pending'", orderId)) {
    try { applyPayment(p.reference, await paystack.verify(p.reference), 'check'); } catch {}
  }
}
async function expireUnpaidOrders() {
  const hours = Number(settings().unpaidExpiryHours) || 0; if (hours <= 0) return;
  const cutoff = new Date(Date.now() - hours * 3600e3).toISOString();
  for (const o of all("SELECT id FROM orders WHERE status = 'awaiting_payment' AND created_at < ?", cutoff)) {
    await checkPendingPayments(o.id);   // never cancel an order that was in fact paid
    tx(() => { const cur = one('SELECT * FROM orders WHERE id = ?', o.id); if (cur.status === 'awaiting_payment') { cancelOrder(cur, 'expired'); S.audit('system', 'order.expired', cur.number); } });
  }
}

// ---------- images ----------
function saveImage(dataUrl, id) {
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) bad('Image must be a PNG, JPG or WEBP file');
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > 4e6) bad('Photo must be under 4 MB');
  const head = buf.subarray(0, 12).toString('latin1');
  const ext = head.startsWith('\x89PNG') ? 'png' : head.startsWith('\xff\xd8\xff') ? 'jpg' : (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') ? 'webp' : null;
  if (!ext) bad('That file is not a valid PNG, JPG or WEBP image');
  const name = `p${id}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS, name), buf);
  return '/uploads/' + name;
}
function deleteImage(url) { if (url && url.startsWith('/uploads/')) try { fs.unlinkSync(path.join(UPLOADS, path.basename(url))); } catch {} }
function productFields(b) {
  const name = str(b.name, 120); if (!name) bad('Product name is required');
  const price = money(b.price, { allowZero: false });
  const stock = Number(b.stock); if (!(Number.isInteger(stock) && stock >= 0 && stock <= 1e6)) bad('Stock must be a whole number from 0 to 1,000,000');
  return { name, price, stock, description: str(b.description, 1000), category: str(b.category, 40), active: b.active === false ? 0 : 1 };
}

// ---------- routes ----------
// auth: null = anyone, 'user' / 'admin' = must be logged in, 'user?' / 'admin?' = optional (still CSRF-checked when logged in)
const routes = [];
const route = (method, pattern, auth, fn, opts = {}) => routes.push({ method, auth, fn, opts,
  re: new RegExp('^' + pattern.replace(/:id/g, '(\\d+)').replace(/:ref/g, '([A-Za-z0-9._=-]{1,100})') + '$') });

// --- customers
route('GET', '/api/me', null, c => ({
  user: c.user ? userOut(c.user) : null, csrf: c.userSession ? c.userSession.csrf : '',
  settings: publicSettings(), onlinePayments: config.paystack.enabled,
}));
route('GET', '/api/products', null, () => all('SELECT * FROM products WHERE active = 1 ORDER BY id').map(productOut));
route('POST', '/api/quote', 'user?', c => {
  const { items, total } = priceItems(c.body.items);
  return { items, quote: quote(total, c.user ? c.user.wallet : 0, c.body.method === 'cash' ? 'cash' : 'momo', settings().momoPercent) };
});
route('POST', '/api/register', null, c => {
  if (S.limited('reg' + c.ip, 10, 3600e3)) bad('Too many sign-ups from this network. Try again later.', 429);
  const name = str(c.body.name, 80); if (!name) bad('Your name is required');
  const ph = phone(c.body.phone), pw = newPassword(c.body.password, { min: 8, phone: ph });
  if (one('SELECT 1 FROM users WHERE phone = ?', ph)) bad('That phone number already has an account. Please log in.');
  const id = Number(run('INSERT INTO users (name, phone, email, pass, created_at) VALUES (?, ?, ?, ?, ?)', name, ph, email(c.body.email), S.hashPassword(pw), now()).lastInsertRowid);
  const csrf = S.createSession(c.res, 'user', id, c.ip);
  return { user: userOut(one('SELECT * FROM users WHERE id = ?', id)), csrf };
});
route('POST', '/api/login', null, c => {
  if (S.limited('login' + c.ip, 20, 10 * 60e3)) bad('Too many attempts from this network. Try again in a few minutes.', 429);
  const ph = phone(c.body.phone), u = one('SELECT * FROM users WHERE phone = ?', ph);
  if (S.isLocked('users', u)) bad('This account is locked for 15 minutes after too many wrong passwords.', 429);
  if (!u) { S.burnTime(c.body.password); bad('Wrong phone number or password', 401); }
  if (!S.checkPassword(c.body.password, u.pass)) { S.recordFailure('users', u); bad('Wrong phone number or password', 401); }
  S.recordSuccess('users', u);
  if (S.needsRehash(u.pass)) run('UPDATE users SET pass = ? WHERE id = ?', S.hashPassword(c.body.password), u.id);
  const csrf = S.createSession(c.res, 'user', u.id, c.ip);
  return { user: userOut(u), csrf };
});
route('POST', '/api/logout', 'user?', c => { S.endSession(c.req, c.res, 'user'); return {}; });
route('POST', '/api/me/password', 'user', c => {
  if (!S.checkPassword(c.body.current, c.user.pass)) bad('Your current password is wrong');
  const pw = newPassword(c.body.next, { min: 8, phone: c.user.phone });
  run('UPDATE users SET pass = ? WHERE id = ?', S.hashPassword(pw), c.user.id);
  S.endAllSessions('user', c.user.id, c.userSession.token_hash);
  return {};
});
route('POST', '/api/orders', 'user', async c => {
  const method = c.body.method === 'cash' ? 'cash' : 'momo';
  const id = tx(() => {
    const { items, total } = priceItems(c.body.items);
    const u = one('SELECT * FROM users WHERE id = ?', c.user.id);
    const q = quote(total, u.wallet, method, settings().momoPercent);
    const due = method === 'momo' ? q.momoDue : q.cashDue;
    // The customer agreed to a specific amount. If anything changed since, stop and show the new figure.
    if (c.body.expectedDue === undefined || Number(c.body.expectedDue) !== due)
      bad(`The amount to pay is now GH₵ ${(due / 100).toFixed(2)} because a price or your wallet balance changed. Check the new total and place the order again.`, 409);
    const payer = method === 'momo' && !config.paystack.enabled ? phone(c.body.momoNumber || u.phone) : '';
    const oid = Number(run(`INSERT INTO orders (user_id, total, method, wallet_deducted, wallet_fee, remainder, momo_due, cash_due, momo_percent,
        payer_momo, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?)`,
      u.id, q.total, method, q.walletDeducted, q.walletFee, q.remainder, q.momoDue, q.cashDue, q.momoPercent, payer, str(c.body.note, 300), now()).lastInsertRowid);
    const number = pad(oid);
    run('UPDATE orders SET number = ? WHERE id = ?', number, oid);
    for (const it of items) {
      run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)', oid, it.productId, it.name, it.price, it.qty);
      if (run('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?', it.qty, it.productId, it.qty).changes !== 1) bad(`"${it.name}" just sold out`);
    }
    if (q.walletDeducted > 0) walletMove(u.id, -q.walletDeducted, 'purchase', `Order ${number}`, oid);
    if (method === 'momo' && q.momoDue === 0) run("UPDATE orders SET status = 'paid', paid_via = 'wallet', paid_at = ? WHERE id = ?", now(), oid);
    return oid;
  });
  const o = one('SELECT * FROM orders WHERE id = ?', id); let payUrl = '', payError = '';
  if (o.status === 'awaiting_payment' && o.method === 'momo' && config.paystack.enabled) {
    try { payUrl = await startPayment(o, one('SELECT * FROM users WHERE id = ?', c.user.id), c.body.email, c.req); }
    catch (e) { payError = e.message; }
  }
  return { order: orderOut(o), user: userOut(one('SELECT * FROM users WHERE id = ?', c.user.id)), payUrl, payError };
});
route('GET', '/api/orders', 'user', c => all('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 200', c.user.id).map(o => orderOut(o)));
route('POST', '/api/orders/:id/pay', 'user', async c => {
  const o = one('SELECT * FROM orders WHERE id = ? AND user_id = ?', c.id, c.user.id) || bad('Order not found', 404);
  return { payUrl: await startPayment(o, c.user, c.body.email, c.req) };
});
route('POST', '/api/payments/verify', 'user', async c => {
  const ref = str(c.body.reference, 100);
  const p = one('SELECT p.* FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.reference = ? AND o.user_id = ?', ref, c.user.id) || bad('Payment not found', 404);
  if (p.status === 'pending') {
    let data; try { data = await paystack.verify(ref); } catch { bad('Could not confirm the payment with Paystack yet. Check again in a minute.', 502); }
    applyPayment(ref, data, 'return');
  }
  return { status: one('SELECT status FROM payments WHERE reference = ?', ref).status, order: orderOut(one('SELECT * FROM orders WHERE id = ?', p.order_id)) };
});
route('POST', '/api/orders/:id/reference', 'user', c => {
  if (config.paystack.enabled) bad('This shop confirms MoMo payments automatically. Use "Pay now" instead.');
  const o = one('SELECT * FROM orders WHERE id = ? AND user_id = ?', c.id, c.user.id) || bad('Order not found', 404);
  if (o.status !== 'awaiting_payment' || o.method !== 'momo') bad('This order is not waiting for a MoMo payment');
  const ref = str(c.body.reference, 60); if (!ref) bad('Enter the MoMo transaction ID');
  run('UPDATE orders SET momo_ref = ? WHERE id = ?', ref, o.id);
  return { order: orderOut(one('SELECT * FROM orders WHERE id = ?', o.id)) };
});
route('POST', '/api/orders/:id/cancel', 'user', async c => {
  const o = one('SELECT * FROM orders WHERE id = ? AND user_id = ?', c.id, c.user.id) || bad('Order not found', 404);
  await checkPendingPayments(o.id);
  tx(() => {
    const cur = one('SELECT * FROM orders WHERE id = ?', o.id);
    if (cur.status !== 'awaiting_payment') bad('This order has already been paid, so it cannot be cancelled here. Please contact the shop.');
    cancelOrder(cur, 'customer'); S.audit(`customer #${c.user.id}`, 'order.cancel', cur.number, '', c.ip);
  });
  return { order: orderOut(one('SELECT * FROM orders WHERE id = ?', o.id)), user: userOut(one('SELECT * FROM users WHERE id = ?', c.user.id)) };
});

// --- Paystack webhook (server to server; trusted only because of the signature)
route('POST', '/api/paystack/webhook', null, c => {
  if (paystack.validSignature(c.raw, c.req.headers['x-paystack-signature'])) {
    let ev; try { ev = JSON.parse(c.raw.toString('utf8')); } catch { return {}; }
    if (ev && ev.event === 'charge.success' && ev.data && ev.data.reference) {
      const r = applyPayment(String(ev.data.reference).slice(0, 100), ev.data, 'webhook');
      if (r.reason === 'unknown') S.audit('paystack', 'webhook.unknown_reference', String(ev.data.reference).slice(0, 100), '', c.ip);
    }
  } else S.audit('system', 'webhook.rejected', '', 'bad or missing signature', c.ip);
  return {};   // always 200 so Paystack does not keep retrying events that are handled or forged
}, { raw: true, noOriginCheck: true });

// --- admin
route('POST', '/api/admin/login', null, c => {
  if (S.limited('alogin' + c.ip, 10, 10 * 60e3)) bad('Too many attempts from this network. Try again in a few minutes.', 429);
  const name = str(c.body.username, 60), a = one('SELECT * FROM admins WHERE username = ?', name);
  if (S.isLocked('admins', a)) { S.audit('system', 'admin.login_locked', a.username, '', c.ip); bad('This admin account is locked for 15 minutes after too many wrong passwords.', 429); }
  if (!a) { S.burnTime(c.body.password); S.audit('system', 'admin.login_failed', name, '', c.ip); bad('Wrong username or password', 401); }
  if (!S.checkPassword(c.body.password, a.pass)) { S.recordFailure('admins', a); S.audit('system', 'admin.login_failed', a.username, '', c.ip); bad('Wrong username or password', 401); }
  S.recordSuccess('admins', a);
  if (S.needsRehash(a.pass)) run('UPDATE admins SET pass = ? WHERE id = ?', S.hashPassword(c.body.password), a.id);
  const csrf = S.createSession(c.res, 'admin', a.id, c.ip);
  S.audit(a.username, 'admin.login', '', '', c.ip);
  return { username: a.username, csrf };
});
route('POST', '/api/admin/logout', 'admin?', c => { if (c.admin) S.audit(c.admin.username, 'admin.logout', '', '', c.ip); S.endSession(c.req, c.res, 'admin'); return {}; });
route('GET', '/api/admin/me', 'admin', c => ({
  username: c.admin.username, csrf: c.adminSession.csrf, defaultPassword: !!c.admin.default_password, settings: settings(),
  payments: { online: config.paystack.enabled, mode: config.paystack.mode, webhookUrl: baseUrl(c.req) + '/api/paystack/webhook' },
  hosting: { secure: config.secure, publicUrl: config.publicUrl },
}));
route('POST', '/api/admin/password', 'admin', c => {
  if (!S.checkPassword(c.body.current, c.admin.pass)) bad('Current password is wrong');
  const pw = newPassword(c.body.next, { min: 10, username: c.admin.username });
  run('UPDATE admins SET pass = ?, default_password = 0 WHERE id = ?', S.hashPassword(pw), c.admin.id);
  S.endAllSessions('admin', c.admin.id, c.adminSession.token_hash);
  S.audit(c.admin.username, 'admin.password_changed', '', '', c.ip);
  return {};
});
route('GET', '/api/admin/summary', 'admin', () => {
  const v = sql => one(sql).v || 0;
  return {
    awaiting: v("SELECT COUNT(*) v FROM orders WHERE status = 'awaiting_payment'"),
    paidOrders: v("SELECT COUNT(*) v FROM orders WHERE status IN ('paid', 'delivered')"),
    toDeliver: v("SELECT COUNT(*) v FROM orders WHERE status = 'paid'"),
    momoCollected: v("SELECT SUM(momo_due) v FROM orders WHERE status IN ('paid', 'delivered')"),
    cashCollected: v("SELECT SUM(cash_due) v FROM orders WHERE status IN ('paid', 'delivered')"),
    walletUsed: v("SELECT SUM(wallet_deducted) v FROM orders WHERE status IN ('paid', 'delivered')"),
    walletOutstanding: v('SELECT SUM(wallet) v FROM users'), customers: v('SELECT COUNT(*) v FROM users'),
    lowStock: all('SELECT name, stock FROM products WHERE active = 1 AND stock <= 3 ORDER BY stock'),
    paymentProblems: all(`SELECT p.reference, p.amount, p.status, o.number, o.status AS orderStatus FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.status IN ('needs_refund', 'mismatch') ORDER BY p.updated_at DESC`),
  };
});
route('GET', '/api/admin/products', 'admin', () => all('SELECT * FROM products ORDER BY id DESC').map(productOut));
route('POST', '/api/admin/products', 'admin', c => tx(() => {
  const f = productFields(c.body);
  const id = Number(run('INSERT INTO products (name, price, stock, description, category, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    f.name, f.price, f.stock, f.description, f.category, f.active, now()).lastInsertRowid);
  if (c.body.imageData) run('UPDATE products SET image = ? WHERE id = ?', saveImage(c.body.imageData, id), id);
  S.audit(c.admin.username, 'product.create', `#${id} ${f.name}`, { price: f.price, stock: f.stock }, c.ip);
  return productOut(one('SELECT * FROM products WHERE id = ?', id));
}));
route('PUT', '/api/admin/products/:id', 'admin', c => tx(() => {
  const p = one('SELECT * FROM products WHERE id = ?', c.id) || bad('Product not found', 404), f = productFields(c.body);
  let image = p.image;
  if (c.body.imageData) image = saveImage(c.body.imageData, p.id); else if (c.body.removeImage) image = '';
  run('UPDATE products SET name = ?, price = ?, stock = ?, description = ?, category = ?, active = ?, image = ? WHERE id = ?',
    f.name, f.price, f.stock, f.description, f.category, f.active, image, p.id);
  if (image !== p.image) deleteImage(p.image);
  const changes = {}; for (const k of ['name', 'price', 'stock', 'active', 'category']) if (String(p[k]) !== String(f[k])) changes[k] = [p[k], f[k]];
  S.audit(c.admin.username, 'product.update', `#${p.id} ${f.name}`, changes, c.ip);
  return productOut(one('SELECT * FROM products WHERE id = ?', p.id));
}));
route('DELETE', '/api/admin/products/:id', 'admin', c => tx(() => {
  const p = one('SELECT * FROM products WHERE id = ?', c.id) || bad('Product not found', 404);
  run('DELETE FROM products WHERE id = ?', p.id); deleteImage(p.image);
  S.audit(c.admin.username, 'product.delete', `#${p.id} ${p.name}`, '', c.ip);
  return {};
}));
route('GET', '/api/admin/customers', 'admin', () => all('SELECT u.*, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS orders FROM users u ORDER BY u.id DESC')
  .map(u => ({ ...userOut(u), orders: u.orders, createdAt: u.created_at, locked: u.locked_until > Date.now() })));
route('POST', '/api/admin/customers', 'admin', c => tx(() => {
  const name = str(c.body.name, 80); if (!name) bad('Name is required');
  const ph = phone(c.body.phone); if (one('SELECT 1 FROM users WHERE phone = ?', ph)) bad('That phone number already has an account');
  const pw = newPassword(c.body.password, { min: 8, phone: ph });
  const id = Number(run('INSERT INTO users (name, phone, email, pass, created_at) VALUES (?, ?, ?, ?, ?)', name, ph, email(c.body.email), S.hashPassword(pw), now()).lastInsertRowid);
  const w = money(c.body.wallet || 0); if (w > 0) walletMove(id, w, 'credit', 'Opening balance');
  S.audit(c.admin.username, 'customer.create', `#${id} ${name}`, { openingWallet: w }, c.ip);
  return userOut(one('SELECT * FROM users WHERE id = ?', id));
}));
route('PUT', '/api/admin/customers/:id', 'admin', c => tx(() => {
  const u = one('SELECT * FROM users WHERE id = ?', c.id) || bad('Customer not found', 404);
  const name = str(c.body.name, 80); if (!name) bad('Name is required');
  const ph = phone(c.body.phone); if (one('SELECT 1 FROM users WHERE phone = ? AND id != ?', ph, u.id)) bad('That phone number is used by another customer');
  run('UPDATE users SET name = ?, phone = ?, email = ? WHERE id = ?', name, ph, email(c.body.email), u.id);
  if (c.body.password) {
    run('UPDATE users SET pass = ?, failed = 0, locked_until = 0 WHERE id = ?', S.hashPassword(newPassword(c.body.password, { min: 8, phone: ph })), u.id);
    S.endAllSessions('user', u.id);
  }
  if (c.body.unlock) run('UPDATE users SET failed = 0, locked_until = 0 WHERE id = ?', u.id);
  S.audit(c.admin.username, 'customer.update', `#${u.id} ${name}`, { passwordReset: !!c.body.password, phoneChanged: ph !== u.phone }, c.ip);
  return userOut(one('SELECT * FROM users WHERE id = ?', u.id));
}));
route('POST', '/api/admin/customers/:id/wallet', 'admin', c => tx(() => {
  const u = one('SELECT * FROM users WHERE id = ?', c.id) || bad('Customer not found', 404);
  const amount = money(c.body.amount, { allowNegative: true, allowZero: false });
  if (u.wallet + amount < 0) bad('The wallet cannot go below zero');
  const note = str(c.body.note, 200) || 'Adjusted by admin';
  const bal = walletMove(u.id, amount, amount > 0 ? 'credit' : 'debit', note, null);
  S.audit(c.admin.username, 'wallet.adjust', `#${u.id} ${u.name}`, { amount, balance: bal, note }, c.ip);
  return userOut(one('SELECT * FROM users WHERE id = ?', u.id));
}));
route('GET', '/api/admin/customers/:id/wallet', 'admin', c => all(`SELECT id, user_id AS userId, amount, type, note, order_id AS orderId, balance_after AS balanceAfter, at
  FROM wallet_tx WHERE user_id = ? ORDER BY id DESC LIMIT 500`, c.id));
route('GET', '/api/admin/orders', 'admin', () => all('SELECT * FROM orders ORDER BY id DESC LIMIT 500').map(o => orderOut(o, true)));
route('POST', '/api/admin/orders/:id/status', 'admin', async c => {
  const a = c.body.action;
  if (a === 'cancel' || a === 'paid') await checkPendingPayments(c.id);
  return tx(() => {
    const o = one('SELECT * FROM orders WHERE id = ?', c.id) || bad('Order not found', 404);
    if (a === 'paid') {
      if (o.status !== 'awaiting_payment') bad('This order is no longer waiting for payment (it may have just been paid online)');
      run("UPDATE orders SET status = 'paid', paid_via = 'manual', paid_at = ? WHERE id = ?", now(), o.id);
    } else if (a === 'delivered') {
      if (o.status !== 'paid') bad('Confirm payment before marking as delivered');
      run("UPDATE orders SET status = 'delivered', delivered_at = ? WHERE id = ?", now(), o.id);
    } else if (a === 'cancel') cancelOrder(o, 'admin');
    else bad('Unknown action');
    S.audit(c.admin.username, `order.${a}`, o.number, { method: o.method, due: o.method === 'momo' ? o.momo_due : o.cash_due }, c.ip);
    return orderOut(one('SELECT * FROM orders WHERE id = ?', o.id), true);
  });
});
route('POST', '/api/admin/payments/:ref/refunded', 'admin', c => tx(() => {
  const p = one('SELECT * FROM payments WHERE reference = ?', c.ref) || bad('Payment not found', 404);
  if (!['needs_refund', 'mismatch'].includes(p.status)) bad('This payment does not need a refund');
  run("UPDATE payments SET status = 'refunded', updated_at = ? WHERE reference = ?", now(), p.reference);
  S.audit(c.admin.username, 'payment.refunded', p.reference, { amount: p.amount }, c.ip);
  return {};
}));
route('GET', '/api/admin/audit', 'admin', () => all('SELECT * FROM audit ORDER BY id DESC LIMIT 300'));
route('PUT', '/api/admin/settings', 'admin', c => tx(() => {
  const b = c.body, before = settings();
  const pct = Number(b.momoPercent); if (b.momoPercent === '' || !(Number.isFinite(pct) && pct >= 0 && pct <= 100)) bad('The MoMo percentage must be between 0 and 100');
  const h = Number(b.unpaidExpiryHours ?? before.unpaidExpiryHours); if (!(Number.isFinite(h) && h >= 0 && h <= 720)) bad('Unpaid order expiry must be between 0 and 720 hours');
  const next = { shopName: str(b.shopName, 60) || 'My Shop', tagline: str(b.tagline, 90), momoPercent: pct, momoNumber: str(b.momoNumber, 20), momoName: str(b.momoName, 80), unpaidExpiryHours: h };
  for (const [k, v] of Object.entries(next)) setSetting(k, v);
  const changes = {}; for (const k of Object.keys(next)) if (before[k] !== next[k]) changes[k] = [before[k], next[k]];
  S.audit(c.admin.username, 'settings.update', '', changes, c.ip);
  return settings();
}));

// ---------- first start: new shop, or import the old db.json ----------
function seedOrImport(isNew) {
  if (!isNew) return;
  const oldFile = path.join(config.dataDir, 'db.json');
  if (fs.existsSync(oldFile)) {
    const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    tx(() => {
      for (const [k, v] of Object.entries(old.settings || {})) if (k in DEFAULTS) setSetting(k, v);
      for (const a of old.admins || []) run('INSERT INTO admins (username, pass, default_password, created_at) VALUES (?, ?, ?, ?)', a.username, a.pass, a.defaultPassword ? 1 : 0, now());
      for (const u of old.users || []) run('INSERT INTO users (id, name, phone, pass, wallet, created_at) VALUES (?, ?, ?, ?, ?, ?)', u.id, u.name, u.phone, u.pass, u.wallet, u.createdAt || now());
      for (const p of old.products || []) run('INSERT INTO products (id, name, description, category, price, stock, image, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        p.id, p.name, p.description || '', p.category || '', p.price, p.stock, p.image || '', p.active === false ? 0 : 1, p.createdAt || now());
      for (const o of old.orders || []) {
        run(`INSERT INTO orders (id, number, user_id, total, method, wallet_deducted, wallet_fee, remainder, momo_due, cash_due, momo_percent, payer_momo, momo_ref, note,
          status, paid_via, created_at, paid_at, delivered_at, cancelled_at, cancelled_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          o.id, o.number, o.userId, o.total, o.method, o.walletDeducted, o.walletFee, o.remainder, o.momoDue, o.cashDue, o.momoPercent, o.payerMomo || '', o.momoRef || '', o.note || '',
          o.status, o.paidAt ? 'manual' : '', o.createdAt, o.paidAt || null, o.deliveredAt || null, o.cancelledAt || null, o.cancelledBy || null);
        for (const it of o.items || []) run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)', o.id, it.productId, it.name, it.price, it.qty);
      }
      for (const t of old.walletTx || []) run('INSERT INTO wallet_tx (user_id, amount, type, note, order_id, balance_after, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        t.userId, t.amount, t.type, t.note || '', t.orderId || null, t.balanceAfter, t.at);
      S.audit('system', 'import.json', 'db.json', { customers: (old.users || []).length, orders: (old.orders || []).length });
    });
    fs.renameSync(oldFile, oldFile + '.imported');
    console.log(`Imported your existing shop data from db.json (${(old.users || []).length} customers, ${(old.orders || []).length} orders).`);
    return;
  }
  tx(() => {
    run('INSERT INTO admins (username, pass, default_password, created_at) VALUES (?, ?, 1, ?)', 'admin', S.hashPassword('admin123'), now());
    for (const [name, description, price, stock, category] of [['Sample: Rice 5kg', 'Perfumed long grain rice', 12000, 20, 'Groceries'],
      ['Sample: Cooking oil 1L', 'Pure vegetable oil', 4500, 30, 'Groceries'], ['Sample: Bar soap', 'Multi-purpose soap', 1000, 50, 'Household']])
      run('INSERT INTO products (name, description, price, stock, category, created_at) VALUES (?, ?, ?, ?, ?, ?)', name, description, price, stock, category, now());
  });
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  ...(config.secure ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};
const reqProto = req => (config.trustProxy && req.headers['x-forwarded-proto'] ? String(req.headers['x-forwarded-proto']).split(',')[0].trim() : (req.socket.encrypted ? 'https' : 'http'));
const clientIp = req => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '';
function serveFile(req, res, root, rel) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep) || path.basename(file).startsWith('.') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', ch => { size += ch.length; if (size > limit) { reject(new HttpError(413, 'That upload is too large (max 4 MB)')); req.destroy(); } else chunks.push(ch); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const expectedOrigin = req => (config.publicUrl ? new URL(config.publicUrl).origin : `${reqProto(req)}://${req.headers.host}`);

async function handle(req, res) {
  const ip = clientIp(req);
  if (config.secure && reqProto(req) === 'http') { res.writeHead(301, { Location: config.publicUrl + req.url }); return res.end(); }
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }); res.end(JSON.stringify(obj)); };
  if (S.limited('g' + ip, 900, 60e3)) return send(429, { error: 'Too many requests. Wait a minute and try again.' });
  let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (p === '/healthz') return send(200, { ok: true });
  if (!p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY_HEADERS); return res.end(); }
    if (p.startsWith('/uploads/')) return serveFile(req, res, UPLOADS, p.slice(9));
    return serveFile(req, res, PUBLIC, p === '/' ? 'index.html' : p === '/admin' ? 'admin.html' : p.slice(1));
  }
  let m; const r = routes.find(r => r.method === req.method && (m = r.re.exec(p)));
  if (!r) return send(404, { error: 'Not found' });
  const c = { req, res, ip, body: {}, raw: null };
  if (m[1] !== undefined) { c.ref = m[1]; if (/^\d+$/.test(m[1])) c.id = Number(m[1]); }
  if (req.method !== 'GET') {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) bad('Invalid request', 415);
    // Browsers send Origin on these requests; a request started by another website is refused.
    if (!r.opts.noOriginCheck && req.headers.origin && req.headers.origin !== expectedOrigin(req)) bad('Request blocked: it came from another website', 403);
    c.raw = await readRaw(req, 6e6);
    if (!r.opts.raw) { try { c.body = c.raw.length ? JSON.parse(c.raw.toString('utf8')) : {}; } catch { bad('Invalid request'); } if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) c.body = {}; }
  }
  const kind = String(r.auth || '').replace('?', '');
  if (kind === 'user') { c.userSession = S.getSession(req, 'user'); c.user = c.userSession ? one('SELECT * FROM users WHERE id = ?', c.userSession.subject) : null; }
  if (kind === 'admin') { c.adminSession = S.getSession(req, 'admin'); c.admin = c.adminSession ? one('SELECT * FROM admins WHERE id = ?', c.adminSession.subject) : null; }
  if (p === '/api/me') { c.userSession = S.getSession(req, 'user'); c.user = c.userSession ? one('SELECT * FROM users WHERE id = ?', c.userSession.subject) : null; }
  if (r.auth === 'user' && !c.user) bad('Please log in first', 401);
  if (r.auth === 'admin' && !c.admin) bad('Admin login required', 401);
  // Every change made while logged in must carry the secret token the page received at login.
  if (req.method !== 'GET' && kind) {
    const s = kind === 'user' ? c.userSession : c.adminSession;
    if (s && !S.csrfOk(s, req.headers['x-csrf-token'])) bad('Your session has expired. Reload the page and try again.', 403);
  }
  if (kind === 'admin' && c.admin && c.admin.default_password && !['/api/admin/me', '/api/admin/password', '/api/admin/logout'].includes(p))
    bad('Change the default admin password first', 403);
  send(200, await r.fn(c));
}
const server = http.createServer((req, res) => handle(req, res).catch(e => {
  if (!(e instanceof HttpError)) console.error(new Date().toISOString(), req.method, req.url, e);
  if (res.headersSent) return res.end();
  res.writeHead(e instanceof HttpError ? e.code : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'Something went wrong on the server. Please try again.' }));
}));
server.headersTimeout = 20e3; server.requestTimeout = 60e3;

function start() {
  const { isNew } = D.open(config.dataDir);
  seedOrImport(isNew);
  try { D.backup(config.dataDir, config.backupDays); } catch (e) { console.error('Backup failed:', e.message); }
  const safe = fn => () => Promise.resolve().then(fn).catch(e => console.error('Background task failed:', e.message));
  safe(expireUnpaidOrders)();
  setInterval(safe(expireUnpaidOrders), 15 * 60e3).unref();
  setInterval(safe(() => D.backup(config.dataDir, config.backupDays)), 6 * 3600e3).unref();
  const stop = () => { try { D.raw().close(); } catch {} process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);

  let port = config.port, tries = 0;
  server.on('error', e => {
    if (e.code === 'EADDRINUSE' && tries++ < 10 && !process.env.PORT) { console.log(`Port ${port} is busy, trying ${port + 1}...`); port++; setTimeout(() => server.listen(port, config.host), 200); }
    else { console.error('Could not start the shop:', e.message); process.exit(1); }
  });
  server.listen(port, config.host, () => {
    const url = config.publicUrl || `http://localhost:${port}`;
    console.log(`\nShop is running.\n  Shop:   ${url}\n  Admin:  ${url}/admin\n  MoMo:   ${config.paystack.enabled ? `confirmed automatically by Paystack (${config.paystack.mode} mode)` : 'confirmed by you in the admin'}\n  Data:   ${config.dataDir}\n\nKeep this window open. Press Ctrl+C to stop.\n`);
    if (process.argv.includes('--open')) {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url + '/admin']] : process.platform === 'darwin' ? ['open', [url + '/admin']] : ['xdg-open', [url + '/admin']];
      try { require('child_process').spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
  });
}
if (require.main === module) start();
module.exports = { quote };
