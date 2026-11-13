const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cedi = p => 'GH₵ ' + (p / 100).toLocaleString('en-GH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STATUS = { awaiting_payment: 'Awaiting payment', paid: 'Paid', delivered: 'Delivered', cancelled: 'Cancelled' };
const TILES = ['#e4ecfa', '#e3f1e8', '#fff1c2', '#f6e3dc', '#ebe5f6', '#dff0ef'];
const S = { user: null, csrf: '', online: false, settings: { momoPercent: 40 }, products: [], cart: {}, view: 'shop', method: 'momo', q: '', cat: '', sort: 'featured', step: 'cart', afterLogin: null, payQuote: null };
try { S.cart = JSON.parse(localStorage.getItem('cart') || '{}'); } catch {}

async function api(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && S.csrf) headers['X-CSRF-Token'] = S.csrf;
  let r;
  try { r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw new Error('No connection to the shop. Check your internet and try again.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
  return j;
}
const cartItems = () => cartLines().map(l => ({ id: l.p.id, qty: l.qty }));
// Every amount shown before paying comes from the server, so the page and the order always agree.
const serverQuote = (items, method) => api('POST', '/api/quote', { items, method }).then(r => r.quote);
function toast(text, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = text; $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2600);
}
const tile = p => TILES[p.id % TILES.length];
const imgStyle = p => `--tile:${tile(p)};${p.image ? `background-image:url('${esc(p.image)}')` : ''}`;
const ph = p => p.image ? '' : `<span class="ph">${esc((p.name.replace(/^sample:\s*/i, '')[0] || '').toUpperCase())}</span>`;
const pct = () => S.settings.momoPercent;
function saveCart() { try { localStorage.setItem('cart', JSON.stringify(S.cart)); } catch {} header(); }
function cartLines() { return Object.entries(S.cart).map(([id, qty]) => ({ p: S.products.find(p => p.id == id), qty })).filter(l => l.p); }
const cartTotal = () => cartLines().reduce((s, l) => s + l.p.price * l.qty, 0);

function breakdown(q, total, method, percent) {
  if (method === 'cash') return `<div class="lines"><div><span>Items</span><span>${cedi(total)}</span></div>
    <div><span>Discount wallet</span><span>Not used for cash</span></div>
    <div class="due"><span>Pay in cash</span><span>${cedi(q.cashDue)}</span></div></div>`;
  return `<div class="lines"><div><span>Items</span><span>${cedi(total)}</span></div>
    ${q.walletDeducted ? `<div class="wallet"><span>Covered by your discount wallet</span><span>− ${cedi(q.walletDeducted)}</span></div>
    <div><span>${percent}% of the wallet amount</span><span>${cedi(q.walletFee)}</span></div>` : '<div><span>Discount wallet</span><span>Empty, nothing to apply</span></div>'}
    ${q.remainder && q.walletDeducted ? `<div><span>Not covered by wallet</span><span>${cedi(q.remainder)}</span></div>` : ''}
    <div class="due"><span>Pay with MoMo</span><span>${cedi(q.momoDue)}</span></div></div>`;
}

// ---------- header ----------
let lastCount = 0;
function header() {
  const name = S.settings.shopName || 'Shop';
  $('#brand').textContent = name; document.title = name;
  $('#navOrders').hidden = !S.user; $('#wallet').hidden = !S.user;
  $('#navOrders').classList.toggle('on', S.view === 'orders');
  if (S.user) $('#wallet').textContent = 'Wallet ' + cedi(S.user.wallet);
  $('#authBtn').textContent = S.user ? 'Log out' : 'Log in';
  const n = cartLines().reduce((s, l) => s + l.qty, 0), c = $('#count');
  c.hidden = !n; c.textContent = n;
  if (n > lastCount) { c.classList.remove('bump'); void c.offsetWidth; c.classList.add('bump'); }
  lastCount = n;
}

// ---------- shop ----------
function hero() {
  const u = S.user;
  return `<section class="hero">
    <div>
      <h1>${esc(S.settings.shopName || 'Shop')}</h1>
      <p>${u ? `Welcome back, ${esc(u.name.split(' ')[0])}. ` : ''}Your discount wallet covers your order first. When you pay by MoMo, you only pay <b>${pct()}%</b> of what the wallet covered.</p>
      <div class="row">
        <button class="primary" data-scroll="catalogue">Start shopping</button>
        ${u ? '<button class="outline" data-go="orders">My orders</button>' : '<button class="outline" data-auth="register">Create an account</button>'}
      </div>
    </div>
    <div class="wallet-card" aria-label="Discount wallet">
      <div class="wc-top"><span>Discount wallet</span><span class="wc-chip"></span></div>
      <div><div class="wc-bal">${u ? cedi(u.wallet) : 'GH₵ ••••'}</div></div>
      <div class="wc-foot"><span>${u ? esc(u.name) : 'Log in to see your balance'}</span><span>${pct()}% by MoMo</span></div>
    </div>
  </section>`;
}
function visibleProducts() {
  const q = S.q.trim().toLowerCase();
  let list = S.products.filter(p => (!S.cat || p.category === S.cat) && (!q || (p.name + ' ' + (p.description || '') + ' ' + (p.category || '')).toLowerCase().includes(q)));
  if (S.sort === 'low') list = [...list].sort((a, b) => a.price - b.price);
  else if (S.sort === 'high') list = [...list].sort((a, b) => b.price - a.price);
  else if (S.sort === 'new') list = [...list].sort((a, b) => b.id - a.id);
  return list;
}
function productCard(p, i) {
  const tag = p.stock < 1 ? '<span class="tag out">Sold out</span>' : p.stock <= 3 ? `<span class="tag low">Only ${p.stock} left</span>` : '';
  return `<article class="product" style="animation-delay:${Math.min(i, 12) * 40}ms">
    <div class="img" role="button" tabindex="0" data-open="${p.id}" aria-label="View ${esc(p.name)}" style="${imgStyle(p)}">
      ${tag}${ph(p)}
      ${p.stock > 0 ? `<button class="dark quick" data-add="${p.id}">Add to cart</button>` : ''}
    </div>
    <div class="body"><div><h3>${esc(p.name)}</h3>${p.category ? `<div class="cat">${esc(p.category)}</div>` : ''}</div><div class="price">${cedi(p.price)}</div></div>
    ${p.stock > 0 ? `<button class="small add-mobile" data-add="${p.id}">Add to cart</button>` : ''}
  </article>`;
}
function catalogue() {
  const cats = [...new Set(S.products.map(p => p.category).filter(Boolean))].sort();
  const list = visibleProducts();
  return `<section id="catalogue">
    <div class="catbar">
      <h2>${S.q ? `Results for “${esc(S.q)}”` : S.cat ? esc(S.cat) : 'All products'}</h2>
      ${cats.length ? `<div class="pills"><button class="${!S.cat ? 'on' : ''}" data-cat="">All</button>${cats.map(c => `<button class="${S.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
      <label for="sort" class="sr">Sort products</label>
      <select id="sort">${[['featured', 'Featured'], ['new', 'Newest'], ['low', 'Price: low to high'], ['high', 'Price: high to low']].map(([k, l]) => `<option value="${k}" ${S.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
    </div>
    ${list.length ? `<div class="grid">${list.map(productCard).join('')}</div>`
      : `<div class="empty">${S.products.length ? 'Nothing matches that. Try another word or category.' : 'Nothing on the shelves yet. Check back soon.'}${S.q || S.cat ? '<p><button class="small" data-clear>Show all products</button></p>' : ''}</div>`}
  </section>`;
}
function showShop(keepScroll) {
  S.view = 'shop'; header();
  $('#view').innerHTML = (S.q ? '' : hero()) + catalogue();
  if (!keepScroll) window.scrollTo(0, 0);
}
function renderCatalogue() { const c = $('#catalogue'); if (c && S.view === 'shop') c.outerHTML = catalogue(); else showShop(); }

// ---------- product detail ----------
function openDlg(html, cls = '') {
  const d = $('#dlg'); d.className = cls;
  d.innerHTML = '<button class="x" data-close aria-label="Close">×</button>' + html;
  if (!d.open) d.showModal();
}
function productDlg(id, qty = 1) {
  const p = S.products.find(p => p.id == id); if (!p) return;
  qty = Math.max(1, Math.min(qty, p.stock || 1));
  openDlg(`<div class="pd-grid">
    <div class="pd-img" style="${imgStyle(p)}">${p.image ? '' : ph(p).replace('class="ph"', 'class="ph"')}</div>
    <div class="pd-body">
      ${p.category ? `<span class="hint">${esc(p.category)}</span>` : ''}
      <h2>${esc(p.name)}</h2>
      <div class="price">${cedi(p.price)}</div>
      <div class="hint">${p.stock < 1 ? 'Sold out' : p.stock <= 3 ? `Only ${p.stock} left in stock` : 'In stock'}</div>
      ${p.description ? `<div class="desc">${esc(p.description)}</div>` : '<div class="desc"></div>'}
      <div class="wallet-note" id="pdNote">Pay by MoMo and your discount wallet covers this first. You pay ${pct()}% of what it covers.</div>
      ${p.stock > 0 ? `<div class="actions">
        <div class="stepper"><button data-pdq="${p.id}" data-d="-1" aria-label="Fewer">−</button><span>${qty}</span><button data-pdq="${p.id}" data-d="1" aria-label="More">+</button></div>
        <button class="primary" data-add="${p.id}" data-qty="${qty}">Add to cart</button></div>` : ''}
    </div></div>`, 'pd');
  $('#dlg').dataset.qty = qty;
  if (S.user && S.user.wallet > 0 && p.stock > 0) serverQuote([{ id: p.id, qty }], 'momo').then(q => {
    const n = $('#pdNote'); if (!n || Number($('#dlg').dataset.qty) !== qty || !q.walletDeducted) return;
    n.innerHTML = `With your discount wallet, ${qty > 1 ? `${qty} of these cost` : 'this costs'} you <b>${cedi(q.momoDue)}</b> by MoMo instead of ${cedi(p.price * qty)}.`;
  }).catch(() => {});
}

// ---------- cart drawer ----------
function openDrawer(step = 'cart') { S.step = step; drawer(); $('#drawer').classList.add('open'); $('#scrim').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); document.body.classList.add('lock'); }
function closeDrawer() { $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); document.body.classList.remove('lock'); }
function drawer(err) {
  const lines = cartLines(), total = cartTotal(), pay = S.step === 'pay' && lines.length && S.user;
  if (!pay) S.step = 'cart';
  const head = `<div class="drawer-head"><h2>${pay ? 'Checkout' : 'Your cart'}</h2><button class="icon" data-close-drawer aria-label="Close cart"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
    ${lines.length ? `<div class="steps"><span class="on"></span><span class="${pay ? 'on' : ''}"></span></div><div class="steps-label">Step ${pay ? '2 of 2: payment' : '1 of 2: review your items'}</div>` : ''}`;
  if (!lines.length) {
    $('#drawer').innerHTML = head + `<div class="drawer-body"><div class="empty" style="margin-top:20px">Your cart is empty.<p><button class="primary" data-close-drawer data-scroll="catalogue">Browse products</button></p></div></div>`;
    return;
  }
  if (!pay) {
    $('#drawer').innerHTML = head + `<div class="drawer-body">${lines.map(l => `<div class="line">
        <div class="thumb" style="${imgStyle(l.p)};background-size:cover;background-position:center;background-color:${tile(l.p)}">${l.p.image ? '' : esc((l.p.name.replace(/^sample:\s*/i, '')[0] || '').toUpperCase())}</div>
        <div><div class="name">${esc(l.p.name)}</div><div class="hint">${cedi(l.p.price)} each</div>
          <div class="meta"><div class="stepper"><button data-cq="${l.p.id}" data-d="-1" aria-label="One fewer ${esc(l.p.name)}">−</button><span>${l.qty}</span><button data-cq="${l.p.id}" data-d="1" aria-label="One more ${esc(l.p.name)}" ${l.qty >= l.p.stock ? 'disabled' : ''}>+</button></div>
          <button class="link" data-remove="${l.p.id}">Remove</button></div></div>
        <div class="amt">${cedi(l.p.price * l.qty)}</div></div>`).join('')}</div>
      <div class="drawer-foot">
        <div class="subtotal"><span>Subtotal</span><span>${cedi(total)}</span></div>
        <div class="hint" style="margin-bottom:14px">${S.user ? (S.user.wallet ? `Your ${cedi(S.user.wallet)} wallet is applied at the next step.` : 'Your discount wallet is applied at the next step.') : 'Log in to apply your discount wallet.'}</div>
        <button class="dark big" data-checkout>${S.user ? 'Continue to payment' : 'Log in to check out'}</button>
      </div>`;
    return;
  }
  const q = S.payQuote;
  if (!q) { $('#drawer').innerHTML = head + '<div class="drawer-body"><p class="hint">Working out your total…</p></div>'; return; }
  const due = S.method === 'momo' ? q.momoDue : q.cashDue, online = S.online && S.method === 'momo' && q.momoDue > 0;
  $('#drawer').innerHTML = head + `<div class="drawer-body">
      <label>How will you pay?</label>
      <div class="pay-choice">
        <label class="${S.method === 'momo' ? 'on' : ''}"><input type="radio" name="method" value="momo" ${S.method === 'momo' ? 'checked' : ''}><span>MoMo<small>Discount wallet applied</small></span></label>
        <label class="${S.method === 'cash' ? 'on' : ''}"><input type="radio" name="method" value="cash" ${S.method === 'cash' ? 'checked' : ''}><span>Cash<small>Full price, wallet not used</small></span></label></div>
      ${breakdown(q, q.total, S.method, q.momoPercent)}
      <form id="orderForm">
        ${online ? `${S.user.email ? '' : '<label for="oEmail">Email for your payment receipt</label><input id="oEmail" name="email" type="email" required autocomplete="email" placeholder="you@example.com">'}
          <p class="hint">After you place the order you go to Paystack's secure page, choose your MoMo network and approve the payment on your phone.</p>`
        : S.method === 'momo' && q.momoDue > 0 ? `<label for="oMomo">MoMo number you will pay from</label><input id="oMomo" name="momoNumber" inputmode="tel" value="${esc(S.user.phone)}" required>` : ''}
        <label for="oNote">Delivery note (optional)</label><input id="oNote" name="note" maxlength="300" placeholder="Location, landmark">
        ${err ? `<div class="msg">${esc(err)}</div>` : ''}
      </form></div>
    <div class="drawer-foot">
      <button class="primary big" form="orderForm">${S.method === 'momo' && due === 0 ? 'Place order (fully covered by your wallet)' : `Place order: pay ${cedi(due)} ${S.method === 'momo' ? 'by MoMo' : 'in cash'}`}</button>
      <p style="text-align:center;margin:12px 0 0"><button class="link" data-back>Back to cart</button></p>
    </div>`;
}
async function toPay(err) {
  S.step = 'pay'; S.payQuote = null; drawer();
  try { S.payQuote = await serverQuote(cartItems(), S.method); }
  catch (e) { S.step = 'cart'; await refresh(); drawer(); throw e; }
  drawer(err);
}
async function payNow(orderId, mail) {
  if (!mail && !S.user.email) return openDlg(`<h2>Email for your receipt</h2><p class="hint">Paystack sends your MoMo payment receipt to this address.</p>
    <form id="emailForm" data-order="${orderId}"><label for="eMail">Email</label><input id="eMail" name="email" type="email" required autocomplete="email">
    <p><button class="primary big">Continue to payment</button></p></form>`);
  const r = await api('POST', `/api/orders/${orderId}/pay`, mail ? { email: mail } : {});
  toast('Opening the secure MoMo payment page…', 'ok'); location.assign(r.payUrl);
}
function passwordDlg() {
  openDlg(`<h2>Change password</h2><form id="pwForm">
    <label for="pCur">Current password</label><input id="pCur" name="current" type="password" required autocomplete="current-password">
    <label for="pNew">New password (at least 8 characters)</label><input id="pNew" name="next" type="password" required minlength="8" autocomplete="new-password">
    <label for="pAgain">New password again</label><input id="pAgain" name="again" type="password" required minlength="8" autocomplete="new-password">
    <div id="pwErr"></div><p><button class="primary big">Change password</button></p></form>`);
}
function addToCart(id, qty = 1) {
  const p = S.products.find(p => p.id == id); if (!p) return;
  const have = S.cart[p.id] || 0, next = Math.min(have + qty, p.stock);
  if (next === have) return toast(`You already have all ${p.stock} in your cart`, 'err');
  S.cart[p.id] = next; saveCart(); toast(`${p.name} added to cart`, 'ok');
}

// ---------- orders ----------
async function showOrders(flashId) {
  S.view = 'orders'; header(); window.scrollTo(0, 0);
  const orders = await api('GET', '/api/orders');
  const step = o => o.status === 'delivered' ? 3 : o.status === 'paid' ? 2 : 1;
  $('#view').innerHTML = `<div class="orders-head"><h1>My orders</h1><div class="row"><button class="small ghost" data-pw>Change password</button><button class="small" data-go="shop">Continue shopping</button></div></div>` + (orders.length ? orders.map(o => `
    <div class="card order">
      <div class="order-head"><h3>${esc(o.number)}</h3><span class="hint">${new Date(o.createdAt).toLocaleString()}</span><span class="badge ${o.status}">${STATUS[o.status]}</span></div>
      <div class="order-items">${o.items.map(i => `<span>${i.qty} × ${esc(i.name)}</span>`).join('')}</div>
      ${o.status === 'cancelled' ? '' : `<div class="track">${['Placed', 'Paid', 'Delivered'].map((l, i) => `<div class="${i < step(o) ? 'done' : ''}">${l}</div>`).join('')}</div>`}
      ${breakdown(o, o.total, o.method, o.momoPercent)}
      ${o.status === 'awaiting_payment' && o.method === 'momo' && S.online ? `
        <div class="msg ${o.id === flashId ? 'ok' : 'warn'}">${o.id === flashId ? 'Order placed. ' : ''}Pay <b>${cedi(o.momoDue)}</b> with MoMo to complete this order.</div>
        <p><button class="primary" data-paynow="${o.id}">Pay ${cedi(o.momoDue)} now</button></p>` : ''}
      ${o.status === 'awaiting_payment' && o.method === 'momo' && !S.online ? `
        <div class="msg ${o.id === flashId ? 'ok' : 'warn'}">${o.id === flashId ? 'Order placed. ' : ''}Send <b>${cedi(o.momoDue)}</b> by MoMo${S.settings.momoNumber ? ` to <b>${esc(S.settings.momoNumber)}</b>${S.settings.momoName ? ` (${esc(S.settings.momoName)})` : ''}` : ' to the shop'}, then enter the transaction ID below.</div>
        <form class="row" data-ref="${o.id}"><label for="ref${o.id}" class="sr">MoMo transaction ID</label><input id="ref${o.id}" class="grow" name="reference" placeholder="MoMo transaction ID" value="${esc(o.momoRef)}" required>
          <button class="primary">${o.momoRef ? 'Update ID' : 'Send ID'}</button></form>` : ''}
      ${o.paidVia === 'paystack' && o.status !== 'awaiting_payment' ? '<div class="hint">Paid with MoMo through Paystack.</div>' : ''}
      ${o.paidVia === 'wallet' ? '<div class="hint">Fully covered by your discount wallet.</div>' : ''}
      ${o.status === 'awaiting_payment' && o.method === 'cash' ? `<div class="msg warn">Pay <b>${cedi(o.cashDue)}</b> in cash to the shop.</div>` : ''}
      ${o.status === 'awaiting_payment' ? `<p style="margin-bottom:0"><button class="small danger" data-cancel="${o.id}">Cancel order</button></p>` : ''}
    </div>`).join('') : '<div class="empty">No orders yet. Anything you order shows up here with its payment details and progress.<p><button class="primary" data-go="shop">Start shopping</button></p></div>');
}

// ---------- auth ----------
function authDlg(mode = 'login') {
  openDlg(`<h2>${mode === 'login' ? 'Log in' : 'Create an account'}</h2>
    <p class="hint" style="margin-top:-6px">${mode === 'login' ? 'Use the phone number you signed up with.' : 'Your phone number is your login.'}</p>
    <form id="authForm" data-mode="${mode}">
    ${mode === 'register' ? '<label for="aName">Full name</label><input id="aName" name="name" required autocomplete="name" maxlength="80">' : ''}
    <label for="aPhone">Phone number</label><input id="aPhone" name="phone" inputmode="tel" placeholder="0241234567" required autocomplete="tel">
    ${mode === 'register' ? '<label for="aEmail">Email (optional, for payment receipts)</label><input id="aEmail" name="email" type="email" autocomplete="email">' : ''}
    <label for="aPass">Password${mode === 'register' ? ' (at least 8 characters)' : ''}</label><input id="aPass" name="password" type="password" required ${mode === 'register' ? 'minlength="8"' : ''} autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
    <div id="authErr"></div>
    <p><button class="primary big">${mode === 'login' ? 'Log in' : 'Create account'}</button></p></form>
    <p class="hint" style="text-align:center">${mode === 'login' ? 'First time here? <a href="#" data-auth="register">Create an account</a>' : 'Already have an account? <a href="#" data-auth="login">Log in</a>'}</p>`);
}
async function refresh() {
  const [me, products] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/products')]);
  S.user = me.user; S.csrf = me.csrf; S.online = !!me.onlinePayments; S.settings = me.settings; S.products = products;
  for (const id of Object.keys(S.cart)) { const p = products.find(p => p.id == id); if (!p || p.stock < 1) delete S.cart[id]; else if (S.cart[id] > p.stock) S.cart[id] = p.stock; }
  header();
}
function rerender() { if ($('#drawer').classList.contains('open')) drawer(); if (S.view === 'shop') showShop(true); }

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target.closest('button, a, [data-open]'); if (!t) return;
  const d = t.dataset;
  try {
    if (d.close !== undefined) $('#dlg').close();
    else if (d.closeDrawer !== undefined) { closeDrawer(); if (d.scroll) { if (S.view !== 'shop') showShop(); $('#' + d.scroll)?.scrollIntoView({ behavior: 'smooth' }); } }
    else if (d.add) { e.stopPropagation(); addToCart(d.add, Number(d.qty) || 1); if ($('#dlg').open) $('#dlg').close(); }
    else if (d.pdq) productDlg(d.pdq, Number($('#dlg').dataset.qty) + Number(d.d));
    else if (d.open) productDlg(d.open);
    else if (d.cq) { const p = S.products.find(p => p.id == d.cq), n = Math.min((S.cart[p.id] || 0) + Number(d.d), p.stock); if (n > 0) S.cart[p.id] = n; else delete S.cart[p.id]; saveCart(); drawer(); }
    else if (d.remove) { delete S.cart[d.remove]; saveCart(); drawer(); }
    else if (d.checkout !== undefined) { if (!S.user) { S.afterLogin = 'checkout'; return authDlg(); } await refresh(); await toPay(); }
    else if (d.paynow) await payNow(Number(d.paynow));
    else if (d.pw !== undefined) passwordDlg();
    else if (d.back !== undefined) { S.step = 'cart'; drawer(); }
    else if (d.auth) { e.preventDefault(); authDlg(d.auth); }
    else if (d.cat !== undefined) { S.cat = d.cat; renderCatalogue(); }
    else if (d.clear !== undefined) { S.q = ''; S.cat = ''; $('#q').value = ''; showShop(); }
    else if (d.scroll) { $('#' + d.scroll)?.scrollIntoView({ behavior: 'smooth' }); }
    else if (d.go === 'shop') { await refresh(); showShop(); }
    else if (d.go === 'orders') { if (!S.user) return authDlg(); await showOrders(); }
    else if (d.cancel) { if (!confirm('Cancel this order? Any wallet amount used will be returned to your wallet.')) return; await api('POST', `/api/orders/${d.cancel}/cancel`, {}); await refresh(); await showOrders(); toast('Order cancelled'); }
    else if (t.id === 'cartBtn') openDrawer('cart');
    else if (t.id === 'authBtn') { if (S.user) { await api('POST', '/api/logout', {}); await refresh(); showShop(); closeDrawer(); toast('Logged out'); } else authDlg(); }
  } catch (err) { toast(err.message, 'err'); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && $('#drawer').classList.contains('open')) closeDrawer();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.open) { e.preventDefault(); productDlg(e.target.dataset.open); }
});
$('#scrim').addEventListener('click', closeDrawer);
let qTimer;
$('#q').addEventListener('input', e => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { const had = !!S.q; S.q = e.target.value; if (S.view !== 'shop' || had !== !!S.q) showShop(); else renderCatalogue(); }, 160);
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'sort') { S.sort = t.value; renderCatalogue(); }
  if (t.name === 'method') { S.method = t.value; toPay().catch(err => toast(err.message, 'err')); }
});
document.addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, data = Object.fromEntries(new FormData(f));
  const btn = f.querySelector('button.primary') || document.querySelector(`button[form="${f.id}"]`);
  if (btn) btn.disabled = true;
  try {
    if (f.id === 'authForm') {
      try { await api('POST', f.dataset.mode === 'login' ? '/api/login' : '/api/register', data); }
      catch (err) { $('#authErr').innerHTML = `<div class="msg">${esc(err.message)}</div>`; return; }
      await refresh(); $('#dlg').close();
      toast(f.dataset.mode === 'login' ? `Welcome back, ${S.user.name.split(' ')[0]}` : 'Account created', 'ok');
      if (S.afterLogin === 'checkout' && cartLines().length) { S.afterLogin = null; openDrawer('pay'); await toPay(); } else rerender();
    } else if (f.id === 'orderForm') {
      const q = S.payQuote; let r;
      try { r = await api('POST', '/api/orders', { ...data, method: S.method, expectedDue: S.method === 'momo' ? q.momoDue : q.cashDue, items: cartItems() }); }
      catch (err) { await refresh(); await toPay(err.message); return; }
      S.cart = {}; saveCart(); closeDrawer();
      if (r.payUrl) { toast('Opening the secure MoMo payment page…', 'ok'); location.assign(r.payUrl); return; }
      await refresh(); await showOrders(r.order.id);
      if (r.payError) toast(r.payError, 'err'); else toast(r.order.status === 'paid' ? 'Order placed and paid with your wallet' : 'Order placed', 'ok');
    } else if (f.id === 'emailForm') { $('#dlg').close(); await payNow(Number(f.dataset.order), data.email); }
    else if (f.id === 'pwForm') {
      if (data.next !== data.again) { $('#pwErr').innerHTML = '<div class="msg">The two new passwords do not match</div>'; return; }
      try { await api('POST', '/api/me/password', { current: data.current, next: data.next }); }
      catch (err) { $('#pwErr').innerHTML = `<div class="msg">${esc(err.message)}</div>`; return; }
      $('#dlg').close(); toast('Password changed. Other devices have been signed out.', 'ok');
    } else if (f.dataset.ref) { await api('POST', `/api/orders/${f.dataset.ref}/reference`, data); await showOrders(); toast('Transaction ID sent. The shop will confirm your payment.', 'ok'); }
  } catch (err) { toast(err.message, 'err'); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
});
// Back from Paystack: confirm the payment, then show the order.
async function returnedFromPaystack() {
  const qs = new URLSearchParams(location.search), ref = qs.get('reference') || qs.get('trxref');
  if (!ref) return false;
  history.replaceState(null, '', '/');
  if (!S.user) { toast('Log in to see your payment', 'err'); return false; }
  try {
    const r = await api('POST', '/api/payments/verify', { reference: ref });
    await refresh(); await showOrders(r.order.id);
    toast(r.status === 'success' ? 'Payment received. Thank you!' : r.status === 'pending' ? 'Payment not finished yet. If you approved it, it will show here shortly.' : 'This payment needs the shop to check it. Please contact the shop.', r.status === 'success' ? 'ok' : 'err');
  } catch (e) { await showOrders(); toast(e.message, 'err'); }
  return true;
}
refresh().then(async () => { if (!(await returnedFromPaystack())) showShop(); }).catch(e => { $('#view').innerHTML = `<div class="msg">${esc(e.message)}</div>`; });
