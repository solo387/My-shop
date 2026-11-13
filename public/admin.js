const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cedi = p => 'GH₵ ' + (p / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = p => (p / 100).toFixed(2);
const when = s => s ? new Date(s).toLocaleString() : '';
const STATUS = { awaiting_payment: 'Awaiting payment', paid: 'Paid', delivered: 'Delivered', cancelled: 'Cancelled' };
const A = { me: null, tab: 'dashboard', products: [], customers: [], orders: [], filter: '', orderFilter: 'open' };

async function api(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && A.me && A.me.csrf) headers['X-CSRF-Token'] = A.me.csrf;
  let r;
  try { r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw new Error('No connection to the shop server. Is the black shop window still open?'); }
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && A.me) { A.me = null; loginView(); toast('You were signed out. Log in again.', 'err'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong. Please try again.');
  return j;
}
function toast(text, kind = '') {
  let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; box.setAttribute('aria-live', 'polite'); document.body.append(box); }
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = text; box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2600);
}
function openDlg(html) { $('#dlg').innerHTML = '<button class="x" data-close aria-label="Close">×</button>' + html; if (!$('#dlg').open) $('#dlg').showModal(); }
function closeDlg() { $('#dlg').close(); }
function formErr(form, msg) { let e = form.querySelector('.formErr'); if (!e) { e = document.createElement('div'); e.className = 'formErr'; form.prepend(e); } e.innerHTML = msg ? `<div class="msg">${esc(msg)}</div>` : ''; }
const fileToDataUrl = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });

// ---------- login ----------
function loginView() {
  $('#logoutBtn').hidden = true;
  $('#view').innerHTML = `<div class="card login"><h2>Admin login</h2><form id="loginForm">
    <label for="lu">Username</label><input id="lu" name="username" required autocomplete="username" autofocus>
    <label for="lp">Password</label><input id="lp" name="password" type="password" required autocomplete="current-password">
    <p><button class="primary">Log in</button></p></form></div>`;
}

// ---------- shell ----------
const TABS = [['dashboard', 'Overview'], ['orders', 'Orders'], ['products', 'Products'], ['customers', 'Customers and wallets'], ['activity', 'Activity log'], ['settings', 'Settings']];
function shell(inner) {
  $('#logoutBtn').hidden = false;
  $('#brand').textContent = A.me.settings.shopName || 'Shop';
  document.title = (A.me.settings.shopName || 'Shop') + ' admin';
  $('#view').innerHTML = `
    ${A.me.defaultPassword ? '<div class="msg warn" style="margin-top:0">You are still using the default admin password. Change it under <a href="#" data-tab="settings">Settings</a>.</div>' : ''}
    <div class="admin"><nav class="rail" aria-label="Admin sections">
      <div class="who">Signed in as ${esc(A.me.username)}</div>
      ${TABS.map(([k, l]) => `<button class="ghost ${A.tab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}
      <div class="sep"></div><a class="admin-link" href="/" target="_blank" rel="noopener" style="padding:0 12px">Open the shop</a>
    </nav><div id="tab">${inner}</div></div>`;
}
async function show(tab) {
  A.tab = tab || A.tab;
  try {
    if (A.tab === 'dashboard') await dashboard();
    else if (A.tab === 'orders') await orders();
    else if (A.tab === 'products') await products();
    else if (A.tab === 'customers') await customers();
    else if (A.tab === 'activity') await activity();
    else settings();
  } catch (e) { shell(`<div class="msg">${esc(e.message)}</div>`); }
}

// ---------- dashboard ----------
async function dashboard() {
  const s = await api('GET', '/api/admin/summary');
  const stat = (k, v, cls = '') => `<div class="stat ${cls}"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  shell(`<h1>Overview</h1><div class="stats">
    ${stat('Awaiting payment', s.awaiting, 'dark')}${stat('Paid or delivered', s.paidOrders)}${stat('Customers', s.customers)}
    ${stat('MoMo received', cedi(s.momoCollected))}${stat('Cash received', cedi(s.cashCollected))}
    ${stat('Discount credit redeemed', cedi(s.walletUsed), 'gold')}${stat('Credit still in wallets', cedi(s.walletOutstanding), 'gold')}</div>
    ${s.awaiting ? `<div class="msg warn" style="margin-top:0">${s.awaiting} order${s.awaiting === 1 ? ' is' : 's are'} waiting for payment. <a href="#" data-tab="orders">Review orders</a></div>` : ''}
    ${s.paymentProblems.length ? `<div class="card" style="border-color:var(--red)"><h3>Payments that need a refund</h3>
      <div class="hint" style="margin-bottom:8px">Money arrived for an order that was already cancelled or paid, or the amount did not match. Refund it from your Paystack dashboard, then mark it here.</div>
      ${s.paymentProblems.map(p => `<div class="row" style="padding:8px 0;border-top:1px solid var(--rule)"><span class="grow"><b>${esc(p.number)}</b> <span class="hint">${esc(p.reference)}</span></span>
        <b>${cedi(p.amount)}</b><span class="badge cancelled">${p.status === 'mismatch' ? 'Amount did not match' : `Order ${esc(STATUS[p.orderStatus] || p.orderStatus).toLowerCase()}`}</span>
        <button class="small" data-refunded="${esc(p.reference)}">Mark refunded</button></div>`).join('')}</div>` : ''}
    ${s.lowStock.length ? `<div class="card"><h3>Running low</h3><div class="hint" style="margin-bottom:8px">Three or fewer left in stock.</div>${s.lowStock.map(p => `<div class="row" style="padding:6px 0;border-top:1px solid var(--rule)"><span class="grow">${esc(p.name)}</span><span class="badge awaiting_payment">${p.stock} left</span></div>`).join('')}</div>` : ''}
    <div class="card"><h3>How the discount wallet works</h3>
      <div class="hint">On MoMo orders, the order amount is covered by the customer's discount wallet as far as the balance goes. The customer then pays
      <b>${A.me.settings.momoPercent}%</b> of what the wallet covered by MoMo, plus any part of the order the wallet did not cover.
      Cash orders do not use the wallet; the full price is paid in cash. The percentage can be changed under Settings.</div></div>`);
}

// ---------- orders ----------
async function orders() {
  A.orders = await api('GET', '/api/admin/orders');
  const f = A.orderFilter, list = A.orders.filter(o => f === 'all' || (f === 'open' ? ['awaiting_payment', 'paid'].includes(o.status) : o.status === f));
  const cnt = k => A.orders.filter(o => k === 'all' || (k === 'open' ? ['awaiting_payment', 'paid'].includes(o.status) : o.status === k)).length;
  shell(`<h1>Orders</h1>
    <div class="toolbar pills">${[['open', 'Open'], ['awaiting_payment', 'Awaiting payment'], ['paid', 'To deliver'], ['delivered', 'Delivered'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-ofilter="${k}">${l} <span style="opacity:.6">${cnt(k)}</span></button>`).join('')}</div>
    ${list.length ? list.map(o => `<div class="card">
      <div class="order-head"><h3>${esc(o.number)}</h3><span class="hint">${when(o.createdAt)}</span><span class="badge ${o.status}">${STATUS[o.status]}</span></div>
      <div style="margin-top:6px">${o.customer ? `<b>${esc(o.customer.name)}</b> <span class="hint">${esc(o.customer.phone)}</span>` : '<span class="hint">Customer no longer exists</span>'}</div>
      ${o.note ? `<div class="hint">Delivery note: ${esc(o.note)}</div>` : ''}
      <div class="hint" style="margin-top:4px">${o.items.map(i => `${i.qty} × ${esc(i.name)} (${cedi(i.price)})`).join(', ')}</div>
      <div class="lines">
        <div><span>Items</span><span>${cedi(o.total)}</span></div>
        ${o.method === 'momo' ? `${o.walletDeducted ? `<div class="wallet"><span>Covered by discount wallet</span><span>− ${cedi(o.walletDeducted)}</span></div>
          <div><span>${o.momoPercent}% of the wallet amount</span><span>${cedi(o.walletFee)}</span></div>
          ${o.remainder ? `<div><span>Not covered by wallet</span><span>${cedi(o.remainder)}</span></div>` : ''}` : '<div><span>Discount wallet</span><span>Empty, nothing applied</span></div>'}
          <div class="due"><span>MoMo due${o.payerMomo ? ` (from ${esc(o.payerMomo)})` : ''}</span><span>${cedi(o.momoDue)}</span></div>
          ${o.paidVia === 'paystack' ? `<div><span>Paid through Paystack</span><span>${esc(o.momoRef)}</span></div>`
            : o.paidVia === 'wallet' ? '<div><span>Payment</span><span>Fully covered by wallet</span></div>'
            : A.me.payments.online ? `<div><span>Paystack attempts</span><span>${o.payments.length ? o.payments.map(p => `${esc(p.status)}`).join(', ') : '<span class="hint" style="font-weight:400">None yet</span>'}</span></div>`
            : `<div><span>MoMo transaction ID from customer</span><span>${o.momoRef ? esc(o.momoRef) : '<span class="hint" style="font-weight:400">Not entered yet</span>'}</span></div>`}`
        : `<div><span>Discount wallet</span><span>Not used for cash</span></div><div class="due"><span>Cash due</span><span>${cedi(o.cashDue)}</span></div>`}
      </div>
      <div class="row">
        ${o.status === 'awaiting_payment' ? `<button class="${A.me.payments.online && o.method === 'momo' ? '' : 'primary '}small" data-status="paid" data-id="${o.id}">${A.me.payments.online && o.method === 'momo' ? 'Mark paid by hand' : 'Confirm payment received'}</button>` : ''}
        ${o.status === 'paid' ? `<button class="primary small" data-status="delivered" data-id="${o.id}">Mark delivered</button>` : ''}
        ${['awaiting_payment', 'paid'].includes(o.status) ? `<button class="danger small" data-status="cancel" data-id="${o.id}">Cancel order</button>` : ''}
        <span class="hint">${o.paidAt ? `Paid ${when(o.paidAt)}. ` : ''}${o.deliveredAt ? `Delivered ${when(o.deliveredAt)}. ` : ''}${o.cancelledAt ? `Cancelled ${when(o.cancelledAt)} ${{ customer: 'by the customer', admin: 'by admin', expired: 'automatically (not paid in time)' }[o.cancelledBy] || ''}.` : ''}</span>
      </div></div>`).join('') : '<div class="empty">No orders match this filter.</div>'}`);
}

// ---------- products ----------
async function products() {
  A.products = await api('GET', '/api/admin/products');
  const q = A.filter.toLowerCase(), list = A.products.filter(p => !q || (p.name + ' ' + (p.category || '')).toLowerCase().includes(q));
  shell(`<h1>Products</h1>
    <div class="toolbar"><button class="primary" data-edit-product="new">Add product</button><input id="search" type="search" placeholder="Search products" value="${esc(A.filter)}" aria-label="Search products"></div>
    <div class="table-wrap"><table class="table"><thead><tr><th></th><th>Product</th><th class="num">Price</th><th class="num">Stock</th><th>In shop</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(p => `<tr class="${p.active ? '' : 'muted-row'}">
      <td><span class="thumb" ${p.image ? `style="background-image:url('${esc(p.image)}')"` : ''}></span></td>
      <td><b>${esc(p.name)}</b>${p.category ? ` <span class="badge cancelled">${esc(p.category)}</span>` : ''}${p.description ? `<div class="hint">${esc(p.description)}</div>` : ''}</td>
      <td class="num">${cedi(p.price)}</td><td class="num">${p.stock}</td>
      <td>${p.active ? '<span class="badge delivered">Shown</span>' : '<span class="badge cancelled">Hidden</span>'}</td>
      <td class="actions"><button class="small" data-edit-product="${p.id}">Edit</button><button class="small danger" data-del-product="${p.id}">Delete</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="hint">${A.filter ? 'No products match your search.' : 'No products yet. Add your first one above.'}</td></tr>`}</tbody></table></div>`);
}
function productDlg(p) {
  const isNew = !p; p = p || { name: '', description: '', price: 0, stock: 0, active: true, image: '' };
  openDlg(`<h2>${isNew ? 'Add product' : 'Edit product'}</h2><form id="productForm" data-id="${p.id || ''}">
    <label for="pn">Name</label><input id="pn" name="name" value="${esc(p.name)}" required maxlength="120">
    <label for="pc2">Category (optional)</label><input id="pc2" name="category" value="${esc(p.category || '')}" maxlength="40" list="cats" placeholder="e.g. Groceries">
    <datalist id="cats">${[...new Set(A.products.map(x => x.category).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('')}</datalist>
    <label for="pd">Description (optional)</label><textarea id="pd" name="description" maxlength="1000">${esc(p.description)}</textarea>
    <div class="row"><div class="grow"><label for="pp">Price (GH₵)</label><input id="pp" name="price" type="number" step="0.01" min="0.01" value="${isNew ? '' : num(p.price)}" required></div>
      <div class="grow"><label for="ps">Stock</label><input id="ps" name="stock" type="number" step="1" min="0" value="${p.stock}" required></div></div>
    <label for="pi">Photo (PNG/JPG/WEBP, max 4 MB)</label><input id="pi" name="image" type="file" accept="image/png,image/jpeg,image/webp">
    ${p.image ? `<p class="row"><span class="thumb" style="background-image:url('${esc(p.image)}')"></span><label class="inline"><input type="checkbox" name="removeImage"> Remove current photo</label></p>` : ''}
    <p><label class="inline"><input type="checkbox" name="active" ${p.active ? 'checked' : ''}> Show in the shop</label></p>
    <p><button class="primary">${isNew ? 'Add product' : 'Save changes'}</button></p></form>`);
}

// ---------- customers & wallets ----------
async function customers() {
  A.customers = await api('GET', '/api/admin/customers');
  const q = A.filter.toLowerCase(), list = A.customers.filter(c => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q));
  shell(`<h1>Customers and wallets</h1>
    <div class="toolbar"><button class="primary" data-edit-customer="new">Add customer</button><input id="search" type="search" placeholder="Search by name or phone" value="${esc(A.filter)}" aria-label="Search customers">
      <span class="chip">Credit in wallets ${cedi(list.reduce((s, c) => s + c.wallet, 0))}</span></div>
    <div class="table-wrap"><table class="table"><thead><tr><th>Customer</th><th>Phone</th><th class="num">Discount wallet</th><th class="num">Orders</th><th>Joined</th><th></th></tr></thead><tbody>
    ${list.length ? list.map(c => `<tr>
      <td><b>${esc(c.name)}</b>${c.locked ? ' <span class="badge awaiting_payment">Locked</span>' : ''}${c.email ? `<div class="hint">${esc(c.email)}</div>` : ''}</td><td>${esc(c.phone)}</td>
      <td class="num"><b>${cedi(c.wallet)}</b></td><td class="num">${c.orders}</td><td class="hint">${when(c.createdAt).split(',')[0]}</td>
      <td class="actions"><button class="primary small" data-wallet="${c.id}">Adjust wallet</button><button class="small" data-history="${c.id}">History</button><button class="small" data-edit-customer="${c.id}">Edit</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="hint">${A.filter ? 'No customers match your search.' : 'No customers yet. Customers can sign up in the shop, or add one here.'}</td></tr>`}</tbody></table></div>`);
}
function customerDlg(c) {
  const isNew = !c; c = c || { name: '', phone: '', email: '' };
  openDlg(`<h2>${isNew ? 'Add customer' : 'Edit customer'}</h2><form id="customerForm" data-id="${c.id || ''}">
    <label for="cn">Full name</label><input id="cn" name="name" value="${esc(c.name)}" required maxlength="80">
    <label for="cp">Phone number (used to log in)</label><input id="cp" name="phone" inputmode="tel" value="${esc(c.phone)}" required>
    <label for="ce">Email (optional)</label><input id="ce" name="email" type="email" value="${esc(c.email || '')}" maxlength="120">
    <label for="cpw">${isNew ? 'Password (at least 8 characters)' : 'New password (leave blank to keep current)'}</label><input id="cpw" name="password" type="password" minlength="8" ${isNew ? 'required' : ''} autocomplete="new-password">
    ${c.locked ? '<p><label class="inline"><input type="checkbox" name="unlock" value="1"> Unlock this account (locked after too many wrong passwords)</label></p>' : ''}
    ${isNew ? '' : '<div class="hint">Setting a new password signs the customer out on all their devices.</div>'}
    ${isNew ? '<label for="cw">Opening discount wallet balance (GH₵, optional)</label><input id="cw" name="wallet" type="number" step="0.01" min="0" value="0">' : ''}
    <p><button class="primary">${isNew ? 'Add customer' : 'Save changes'}</button></p></form>`);
}
function walletDlg(c) {
  openDlg(`<h2>${esc(c.name)}'s wallet</h2><p class="chip">Balance ${cedi(c.wallet)}</p>
    <form id="walletForm" data-id="${c.id}">
    <label for="wa">Amount (GH₵)</label><input id="wa" name="amount" type="number" step="0.01" required placeholder="e.g. 30">
    <div class="row" style="margin-top:8px"><label class="inline"><input type="radio" name="dir" value="add" checked> Add credit</label>
      <label class="inline"><input type="radio" name="dir" value="remove"> Remove credit</label></div>
    <label for="wn">Note (optional)</label><input id="wn" name="note" maxlength="200" placeholder="e.g. Monthly discount credit">
    <p><button class="primary">Update wallet</button></p></form>`);
}
async function historyDlg(c) {
  const tx = await api('GET', `/api/admin/customers/${c.id}/wallet`);
  const label = { credit: 'Added by admin', debit: 'Removed by admin', purchase: 'Used on order', refund: 'Refund (order cancelled)' };
  openDlg(`<h2>${esc(c.name)}'s wallet history</h2><p class="chip">Balance ${cedi(c.wallet)}</p>
    ${tx.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>What</th><th class="num">Amount</th><th class="num">Balance</th></tr></thead><tbody>
    ${tx.map(t => `<tr><td class="hint">${when(t.at)}</td><td>${label[t.type] || t.type}${t.note ? `<div class="hint">${esc(t.note)}</div>` : ''}</td>
      <td class="num" style="color:${t.amount < 0 ? 'var(--red)' : 'var(--green)'}">${t.amount < 0 ? '−' : '+'} ${cedi(Math.abs(t.amount))}</td><td class="num">${cedi(t.balanceAfter)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No wallet activity yet.</div>'}`);
}

// ---------- activity log ----------
const ACTION = {
  'admin.login': 'Logged in', 'admin.logout': 'Logged out', 'admin.login_failed': 'Failed admin login', 'admin.login_locked': 'Admin login blocked (locked)',
  'admin.password_changed': 'Changed admin password', 'product.create': 'Added product', 'product.update': 'Edited product', 'product.delete': 'Deleted product',
  'customer.create': 'Added customer', 'customer.update': 'Edited customer', 'wallet.adjust': 'Adjusted wallet', 'order.paid': 'Order paid', 'order.delivered': 'Order delivered',
  'order.cancel': 'Order cancelled', 'order.expired': 'Unpaid order cancelled automatically', 'settings.update': 'Changed settings', 'payment.refunded': 'Marked payment refunded',
  'payment.needs_refund': 'Payment needs a refund', 'payment.mismatch': 'Payment amount did not match', 'webhook.rejected': 'Rejected a fake payment notice',
  'webhook.unknown_reference': 'Payment notice for an unknown order', 'import.json': 'Imported old shop data',
};
function detail(a) {
  if (!a.detail) return '';
  try {
    const d = JSON.parse(a.detail);
    if (a.action === 'wallet.adjust') return `${d.amount > 0 ? '+' : '−'} ${cedi(Math.abs(d.amount))}, balance ${cedi(d.balance)}${d.note ? ` (${d.note})` : ''}`;
    if (d.due !== undefined) return `${d.method === 'momo' ? 'MoMo' : 'Cash'} ${cedi(d.due)}`;
    if (d.expected !== undefined) return `expected ${cedi(d.expected)}, received ${cedi(Number(d.received))} ${d.currency || ''}`;
    if (d.amount !== undefined && d.reference) return `${cedi(d.amount)} (${d.reference})`;
    const MONEY = new Set(['amount', 'price', 'openingWallet', 'expected', 'received', 'balance', 'due']);
    const LABEL = { openingWallet: 'opening wallet', passwordReset: 'password reset', phoneChanged: 'phone changed', momoPercent: 'MoMo %', unpaidExpiryHours: 'unpaid expiry (hours)', shopName: 'shop name', momoNumber: 'MoMo number', momoName: 'MoMo name' };
    const fmt = (k, v) => MONEY.has(k) && typeof v === 'number' ? cedi(v) : k === 'active' ? (v ? 'shown' : 'hidden') : String(v);
    return Object.entries(d).filter(([, v]) => v !== false && v !== '' && v != null)
      .map(([k, v]) => Array.isArray(v) ? `${LABEL[k] || k}: ${fmt(k, v[0])} → ${fmt(k, v[1])}` : v === true ? (LABEL[k] || k) : `${LABEL[k] || k}: ${fmt(k, v)}`).join(', ');
  } catch { return a.detail; }
}
async function activity() {
  const rows = await api('GET', '/api/admin/audit');
  shell(`<h1>Activity log</h1><p class="hint" style="margin-top:-8px">Every sign-in, money change and edit, newest first. Entries cannot be edited or deleted from here.</p>
    <div class="table-wrap"><table class="table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>
    ${rows.length ? rows.map(a => `<tr><td class="hint" style="white-space:nowrap">${when(a.at)}</td><td>${esc(a.actor)}</td>
      <td><b>${esc(ACTION[a.action] || a.action)}</b>${a.target ? `<div class="hint">${esc(a.target)}</div>` : ''}</td><td class="hint">${esc(detail(a))}${a.ip ? `<div>from ${esc(a.ip)}</div>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="4" class="hint">Nothing recorded yet.</td></tr>'}</tbody></table></div>`);
}

// ---------- settings ----------
function settings() {
  const s = A.me.settings;
  shell(`<h1>Settings</h1>
    <div class="card"><h3>Shop and discount rule</h3><form id="settingsForm">
      <label for="sn">Shop name</label><input id="sn" name="shopName" value="${esc(s.shopName)}" maxlength="60">
      <label for="st">Headline on the shop's front page (optional)</label><input id="st" name="tagline" value="${esc(s.tagline || '')}" maxlength="90" placeholder="Everyday essentials, delivered to your door.">
      <label for="sp">Share of the wallet amount the customer pays by MoMo (%)</label><input id="sp" name="momoPercent" type="number" min="0" max="100" step="1" value="${s.momoPercent}" required>
      <div class="hint">At ${s.momoPercent}%: a customer with GH₵30 in the wallet buying GH₵10 has 10 taken from the wallet and pays GH₵${num(Math.round(1000 * s.momoPercent / 100))} by MoMo. With GH₵5 in the wallet, 5 is taken and they pay GH₵${num(Math.round(500 * s.momoPercent / 100) + 500)} by MoMo.</div>
      <label for="se">Cancel unpaid orders automatically after (hours)</label><input id="se" name="unpaidExpiryHours" type="number" min="0" max="720" step="1" value="${s.unpaidExpiryHours ?? 24}" required>
      <div class="hint">Unpaid orders hold stock and wallet credit. After this many hours they are cancelled and both are released. Enter 0 to never cancel automatically.</div>
      <label for="sm">MoMo number customers pay to</label><input id="sm" name="momoNumber" value="${esc(s.momoNumber)}" placeholder="0241234567" maxlength="20">
      <label for="smn">Name on the MoMo account</label><input id="smn" name="momoName" value="${esc(s.momoName)}" maxlength="80">
      <p><button class="primary">Save settings</button></p></form></div>
    <div class="card"><h3>Change admin password</h3><form id="passwordForm">
      <label for="pc">Current password</label><input id="pc" name="current" type="password" required autocomplete="current-password">
      <label for="pn2">New password (at least 10 characters)</label><input id="pn2" name="next" type="password" required minlength="10" autocomplete="new-password">
      <p><button class="primary">Change password</button></p></form></div>
    <div class="card"><h3>MoMo payments</h3>
      ${A.me.payments.online ? `<p><span class="badge delivered">Paystack connected</span> <span class="hint">${A.me.payments.mode === 'test' ? 'Test mode: no real money moves.' : 'Live mode: real payments.'}</span></p>
        <div class="hint">In your Paystack dashboard, under Settings, API Keys and Webhooks, set the webhook URL to <code>${esc(A.me.payments.webhookUrl)}</code></div>`
        : `<p><span class="badge cancelled">Manual</span></p><div class="hint">Customers send MoMo to your number and you confirm each order. To confirm payments automatically, add your Paystack secret key to the <code>.env</code> file (see README) and restart the shop.</div>`}</div>
    <div class="card"><h3>Security and backups</h3><div class="hint">
      ${A.me.hosting.secure ? 'This shop runs over HTTPS.' : 'This shop runs over plain HTTP, which is fine on your own Wi-Fi. Put it on a hosted server with HTTPS before real customers use it (see README).'}
      Data is stored in <code>shop.db</code> in the <code>data</code> folder. A backup copy is made every day in <code>data/backups</code> (the last 14 are kept). Copy that folder somewhere outside this computer now and then.</div></div>`);
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('button, a'); if (!t) return;
  try {
    if (t.dataset.close !== undefined) closeDlg();
    else if (t.dataset.refunded) { if (!confirm('Only mark this as refunded after you have sent the money back in Paystack. Continue?')) return; await api('POST', `/api/admin/payments/${encodeURIComponent(t.dataset.refunded)}/refunded`, {}); show(); toast('Marked as refunded', 'ok'); }
    else if (t.dataset.ofilter) { A.orderFilter = t.dataset.ofilter; show(); }
    else if (t.dataset.tab) { e.preventDefault(); A.filter = ''; show(t.dataset.tab); }
    else if (t.id === 'logoutBtn') { await api('POST', '/api/admin/logout', {}); A.me = null; loginView(); }
    else if (t.dataset.editProduct) productDlg(t.dataset.editProduct === 'new' ? null : A.products.find(p => p.id == t.dataset.editProduct));
    else if (t.dataset.delProduct) { const p = A.products.find(p => p.id == t.dataset.delProduct); if (!confirm(`Delete "${p.name}" for good? If you may sell it again, untick "Show in the shop" instead.`)) return; await api('DELETE', `/api/admin/products/${p.id}`); show(); toast('Product deleted'); }
    else if (t.dataset.editCustomer) customerDlg(t.dataset.editCustomer === 'new' ? null : A.customers.find(c => c.id == t.dataset.editCustomer));
    else if (t.dataset.wallet) walletDlg(A.customers.find(c => c.id == t.dataset.wallet));
    else if (t.dataset.history) await historyDlg(A.customers.find(c => c.id == t.dataset.history));
    else if (t.dataset.status) {
      const o = A.orders.find(o => o.id == t.dataset.id), a = t.dataset.status;
      const ask = { paid: `Confirm that ${o.method === 'momo' ? 'MoMo' : 'cash'} payment of ${cedi(o.method === 'momo' ? o.momoDue : o.cashDue)} for ${o.number} was received?`, delivered: `Mark ${o.number} as delivered?`, cancel: `Cancel ${o.number}? Stock will be restored${o.walletDeducted ? ` and ${cedi(o.walletDeducted)} returned to the customer's wallet` : ''}.${o.status === 'paid' ? ` This order was already paid: refund the ${cedi(o.method === 'momo' ? o.momoDue : o.cashDue)} to the customer yourself.` : ''}` }[a];
      if (!confirm(ask)) return;
      await api('POST', `/api/admin/orders/${o.id}/status`, { action: a }); show(); toast({ paid: 'Payment confirmed', delivered: 'Marked delivered', cancel: 'Order cancelled' }[a], 'ok');
    }
  } catch (err) { toast(err.message, 'err'); }
});
document.addEventListener('input', e => {
  if (e.target.id === 'search') { A.filter = e.target.value; const pos = e.target.selectionStart; show().then(() => { const s = $('#search'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } }); }
});
document.addEventListener('change', () => {});
document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, d = Object.fromEntries(new FormData(f)), btn = f.querySelector('button.primary');
  btn.disabled = true;
  try {
    if (f.id === 'loginForm') { await api('POST', '/api/admin/login', d); await boot(); }
    else if (f.id === 'productForm') {
      const body = { name: d.name, category: d.category, description: d.description, price: d.price, stock: d.stock, active: !!d.active, removeImage: !!d.removeImage };
      const file = f.querySelector('input[type=file]').files[0];
      if (file) { if (file.size > 4e6) throw new Error('Photo must be under 4 MB'); body.imageData = await fileToDataUrl(file); }
      if (f.dataset.id) await api('PUT', `/api/admin/products/${f.dataset.id}`, body); else await api('POST', '/api/admin/products', body);
      closeDlg(); show(); toast(f.dataset.id ? 'Product saved' : 'Product added', 'ok');
    } else if (f.id === 'customerForm') {
      if (f.dataset.id) await api('PUT', `/api/admin/customers/${f.dataset.id}`, d); else await api('POST', '/api/admin/customers', d);
      closeDlg(); show(); toast(f.dataset.id ? 'Customer saved' : 'Customer added', 'ok');
    } else if (f.id === 'walletForm') {
      const amt = Math.abs(Number(d.amount)) * (d.dir === 'remove' ? -1 : 1);
      const u = await api('POST', `/api/admin/customers/${f.dataset.id}/wallet`, { amount: amt, note: d.note });
      closeDlg(); show(); toast(`Wallet updated: ${cedi(u.wallet)}`, 'ok');
    } else if (f.id === 'settingsForm') { A.me.settings = await api('PUT', '/api/admin/settings', d); show(); toast('Settings saved', 'ok'); }
    else if (f.id === 'passwordForm') {
      if (d.again !== undefined && d.again !== d.next) throw new Error('The two passwords do not match');
      await api('POST', '/api/admin/password', { current: d.current, next: d.next }); A.me.defaultPassword = false;
      await show(f.dataset.first ? 'dashboard' : undefined); toast('Password saved', 'ok');
    }
  } catch (err) { if (f.closest('dialog') || f.id === 'loginForm' || f.dataset.first) formErr(f, err.message); else toast(err.message, 'err'); }
  finally { btn.disabled = false; }
});
function firstPasswordView() {
  $('#logoutBtn').hidden = false;
  $('#view').innerHTML = `<div class="card login"><h2>Set your admin password</h2>
    <p class="hint">The shop can be opened from other phones and computers on your Wi-Fi, so the default password has to be replaced before you continue.</p>
    <form id="passwordForm" data-first="1">
      <input type="hidden" name="current" value="admin123">
      <label for="fp1">New password (at least 10 characters)</label><input id="fp1" name="next" type="password" required minlength="10" autocomplete="new-password" autofocus>
      <label for="fp2">Type it again</label><input id="fp2" name="again" type="password" required minlength="10" autocomplete="new-password">
      <p><button class="primary">Save password and continue</button></p></form></div>`;
}
async function boot() {
  try { A.me = await api('GET', '/api/admin/me'); if (A.me.defaultPassword) return firstPasswordView(); await show('dashboard'); }
  catch { A.me = null; loginView(); }
}
boot();
