(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    products: [],
    config: { usdRate: 3700, providers: {}, company: {} },
    cart: [],
    category: 'All',
    view: 'cart',
    currency: 'UGX'
  };

  /* ---------- helpers ---------- */
  const ugx = n => 'UGX ' + Math.round(n).toLocaleString('en-UG');
  const usd = n => '$' + (Math.ceil((n / state.config.usdRate) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmt = (n, cur = state.currency) => (cur === 'USD' ? usd(n) : ugx(n));

  function loadCart() {
    try { state.cart = JSON.parse(localStorage.getItem('aura_cart') || '[]'); } catch { state.cart = []; }
    if (!Array.isArray(state.cart)) state.cart = [];
  }
  function saveCart() {
    try { localStorage.setItem('aura_cart', JSON.stringify(state.cart)); } catch { /* storage unavailable */ }
    $('#cartCount').textContent = state.cart.reduce((n, i) => n + i.qty, 0);
  }
  const lineItems = () => state.cart
    .map(i => ({ ...i, p: state.products.find(p => p.id === i.id) }))
    .filter(i => i.p);
  const total = () => lineItems().reduce((s, i) => s + i.p.price_ugx * i.qty, 0);

  /* ---------- catalogue ---------- */
  function renderFilters() {
    const cats = ['All', ...new Set(state.products.map(p => p.category))];
    $('#filters').innerHTML = cats
      .map(c => `<button type="button" class="chip${c === state.category ? ' active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`)
      .join('');
  }
  function renderProducts() {
    const list = state.products.filter(p => state.category === 'All' || p.category === state.category);
    $('#products').innerHTML = list.length
      ? list.map(p => `
        <article class="card">
          <span class="tag">${esc(p.category)}</span>
          <h3>${esc(p.name)}</h3>
          <p>${esc(p.description)}</p>
          <div class="row">
            <div class="price">${ugx(p.price_ugx)}<br><small>≈ ${usd(p.price_ugx)}</small></div>
            <button class="btn small" type="button" data-add="${p.id}">Add to cart</button>
          </div>
        </article>`).join('')
      : '<p class="lead">No items in this category yet.</p>';
  }

  /* ---------- cart drawer ---------- */
  function openDrawer(view = 'cart') {
    state.view = view;
    renderDrawer();
    $('#drawer').classList.add('open');
    $('#overlay').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#overlay').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
  }

  function renderDrawer() {
    const body = $('#drawerBody'), foot = $('#drawerFooter');
    const items = lineItems();

    if (state.view === 'checkout' && items.length) return renderCheckout(body, foot, items);

    state.view = 'cart';
    $('#drawerTitle').textContent = 'Your cart';
    if (!items.length) {
      body.innerHTML = '<p class="lead">Your cart is empty. Add a service or product to get started.</p>';
      foot.innerHTML = '';
      return;
    }
    body.innerHTML = items.map(i => `
      <div class="line">
        <div><b>${esc(i.p.name)}</b><br><small>${ugx(i.p.price_ugx)} each</small></div>
        <div style="text-align:right"><b>${ugx(i.p.price_ugx * i.qty)}</b></div>
        <div class="qty">
          <button type="button" data-dec="${i.id}" aria-label="Decrease">−</button>
          <span>${i.qty}</span>
          <button type="button" data-inc="${i.id}" aria-label="Increase">+</button>
        </div>
        <div style="text-align:right"><button class="link-btn" type="button" data-del="${i.id}">Remove</button></div>
      </div>`).join('');
    foot.innerHTML = `
      <div class="total"><span>Total</span><span>${ugx(total())}</span></div>
      <button class="btn" style="width:100%" type="button" id="toCheckout">Checkout</button>`;
  }

  function renderCheckout(body, foot, items) {
    $('#drawerTitle').textContent = 'Checkout';
    const p = state.config.providers;
    const method = (id, title, sub) => `
      <label class="method${p[id] ? '' : ' off'}">
        <input type="radio" name="provider" value="${id}" ${p[id] ? '' : 'disabled'}>
        <span><b>${title}</b><small>${sub}${p[id] ? '' : ' (not set up yet)'}</small></span>
      </label>`;
    body.innerHTML = `
      <form class="stack" id="checkoutForm" novalidate>
        <label>Full name <input name="name" required maxlength="100" autocomplete="name"></label>
        <label>Email (receipt &amp; updates) <input name="email" type="email" required maxlength="150" autocomplete="email"></label>
        <label>Phone (for Mobile Money) <input name="phone" maxlength="30" autocomplete="tel" placeholder="0772 123456"></label>
        <label>Currency
          <select name="currency" id="currencySel">
            <option value="UGX">UGX (Ugandan Shilling)</option>
            <option value="USD">USD (US Dollar)</option>
          </select>
        </label>
        <div class="methods">
          ${method('flutterwave', 'Mobile Money &amp; Cards', 'MTN / Airtel Money (UGX) and cards, via Flutterwave')}
          ${method('pesapal', 'Pesapal', 'Mobile Money, cards and bank, Uganda')}
          ${method('stripe', 'International card (USD)', 'Visa / Mastercard via Stripe')}
        </div>
        <label class="check"><input type="checkbox" name="agree" required> <span>I agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
        <div class="msg" id="checkoutMsg" role="alert"></div>
      </form>`;
    foot.innerHTML = `
      <div class="total"><span>Total</span><span id="checkoutTotal">${fmt(total())}</span></div>
      <div style="display:flex;gap:10px">
        <button class="btn ghost" type="button" id="backToCart">Back</button>
        <button class="btn" style="flex:1" type="button" id="payNow">Pay now</button>
      </div>`;
    const first = body.querySelector('input[name=provider]:not([disabled])');
    if (first) first.checked = true;
    syncCurrency();
  }

  function syncCurrency() {
    const form = $('#checkoutForm');
    if (!form) return;
    const sel = $('#currencySel');
    const provider = (form.querySelector('input[name=provider]:checked') || {}).value;
    if (provider === 'stripe') { sel.value = 'USD'; sel.disabled = true; } else { sel.disabled = false; }
    state.currency = sel.value;
    $('#checkoutTotal').textContent = fmt(total());
  }

  async function pay() {
    const form = $('#checkoutForm'), msg = $('#checkoutMsg'), btn = $('#payNow');
    const fd = new FormData(form);
    const show = (t, cls = 'err') => { msg.textContent = t; msg.className = 'msg ' + cls; };
    if (!fd.get('name') || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(fd.get('email') || '')) return show('Please enter your name and a valid email.');
    if (!fd.get('provider')) return show('Please choose a payment method.');
    if (!fd.get('agree')) return show('Please accept the Terms and Privacy Policy to continue.');

    btn.disabled = true; btn.textContent = 'Starting payment…';
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: state.cart.map(i => ({ id: i.id, qty: i.qty })),
          customer: { name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone') },
          provider: fd.get('provider'),
          currency: form.querySelector('#currencySel').value
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Payment could not be started.');
      state.cart = []; saveCart();
      window.location.href = data.redirectUrl;
    } catch (e) {
      show(e.message);
      btn.disabled = false; btn.textContent = 'Pay now';
    }
  }

  /* ---------- contact ---------- */
  async function sendContact(e) {
    e.preventDefault();
    const form = e.target, msg = $('#contactMsg'), fd = new FormData(form);
    const show = (t, ok) => { msg.textContent = t; msg.className = 'msg ' + (ok ? 'ok' : 'err'); };
    if (fd.get('website')) return show('Thanks! We will be in touch.', true); // honeypot: pretend success for bots
    if (!fd.get('consent')) return show('Please agree to the Privacy Policy.');
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(['name', 'email', 'phone', 'subject', 'message'].map(k => [k, fd.get(k)])))
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not send your message.');
      show('Thank you! Your message has been received.', true);
      form.reset();
    } catch (err) { show(err.message); }
    btn.disabled = false;
  }

  /* ---------- events ---------- */
  document.addEventListener('click', e => {
    const t = e.target.closest('button, a');
    if (!t) return;
    if (t.dataset.cat) { state.category = t.dataset.cat; renderFilters(); renderProducts(); }
    else if (t.dataset.add) {
      const id = +t.dataset.add, ex = state.cart.find(i => i.id === id);
      ex ? ex.qty++ : state.cart.push({ id, qty: 1 });
      saveCart(); openDrawer('cart');
    }
    else if (t.dataset.inc) { state.cart.find(i => i.id === +t.dataset.inc).qty++; saveCart(); renderDrawer(); }
    else if (t.dataset.dec) {
      const it = state.cart.find(i => i.id === +t.dataset.dec);
      it.qty--; if (it.qty < 1) state.cart = state.cart.filter(i => i !== it);
      saveCart(); renderDrawer();
    }
    else if (t.dataset.del) { state.cart = state.cart.filter(i => i.id !== +t.dataset.del); saveCart(); renderDrawer(); }
    else if (t.id === 'toCheckout') { state.view = 'checkout'; renderDrawer(); }
    else if (t.id === 'backToCart') { state.view = 'cart'; renderDrawer(); }
    else if (t.id === 'payNow') pay();
    else if (t.id === 'openCart') openDrawer('cart');
    else if (t.id === 'closeCart') closeDrawer();
    else if (t.id === 'menuBtn') {
      const open = $('#nav').classList.toggle('open');
      t.setAttribute('aria-expanded', String(open));
    }
    else if (t.closest('#nav')) $('#nav').classList.remove('open');
  });
  document.addEventListener('change', e => {
    if (e.target.name === 'provider' || e.target.id === 'currencySel') syncCurrency();
  });
  $('#overlay').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  $('#contactForm').addEventListener('submit', sendContact);

  /* ---------- init ---------- */
  async function init() {
    $('#year').textContent = new Date().getFullYear();
    loadCart(); saveCart();
    try {
      const [cfg, prods] = await Promise.all([
        fetch('/api/config').then(r => r.json()),
        fetch('/api/products').then(r => r.json())
      ]);
      state.config = cfg; state.products = prods;
      const { email, phone } = cfg.company || {};
      const a = $('#contactEmail');
      if (email) { a.textContent = email; a.href = 'mailto:' + email; }
      if (phone) $('#contactPhone').textContent = phone;
      renderFilters(); renderProducts();
      // drop cart lines for items that no longer exist
      state.cart = state.cart.filter(i => state.products.some(p => p.id === i.id)); saveCart();
    } catch {
      $('#products').innerHTML = '<p class="lead">We could not load the catalogue. Please refresh or contact us.</p>';
    }
  }
  init();
})();
