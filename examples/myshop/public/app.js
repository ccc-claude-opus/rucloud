// MyShop 前端：登入 → 開店（模板）→ POS 點單 / 訂單 / 每日報表 / 商品管理。
// 狀態存在記憶體，交易存在 Worker 的 D1 資料庫裡。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&', '<': '<', '>': '>', '"': '"' }[c]));

  // 用使用者當地日期（報表結算的單位）
  const today = () => new Date().toLocaleDateString('sv');  // sv-SE 給 YYYY-MM-DD

  let user = null;
  let shop = null;
  let products = [];
  let templates = [];
  let cart = new Map();          // productId -> qty
  let chosenTemplate = null;

  // ---------- 提示訊息 ----------
  let toastTimer = null;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  // ---------- API ----------
  async function api(path, options = {}) {
    const resp = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || `錯誤 ${resp.status}`);
    return data;
  }

  // ---------- 畫面切換 ----------
  function show(id) {
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
  }
  function showTab(name) {
    for (const t of document.querySelectorAll('.tab-body')) t.hidden = t.id !== `tab-${name}`;
    for (const b of document.querySelectorAll('[data-goto]')) b.classList.toggle('active', b.dataset.goto === name);
    if (name === 'orders') loadOrders();
    if (name === 'report') loadReport();
    if (name === 'products') renderProducts();
  }

  // ---------- 登入 / 註冊 ----------
  let authMode = 'login';
  document.querySelectorAll('[data-auth]').forEach((b) => b.addEventListener('click', () => {
    authMode = b.dataset.auth;
    document.querySelectorAll('[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
    $('a-name-row').hidden = authMode !== 'signup';
    $('a-go').textContent = authMode === 'signup' ? '註冊並開始' : '登入';
    $('a-msg').textContent = '';
  }));
  $('a-go').addEventListener('click', async () => {
    const body = { email: $('a-email').value.trim(), password: $('a-pass').value, name: $('a-name').value.trim() };
    try {
      if (authMode === 'signup') {
        await api('/api/signup', { method: 'POST', body });
        await api('/api/login', { method: 'POST', body });
        toast(`註冊成功，歡迎${body.name ? '，' + body.name : ''}！接著開一家店吧。`);
      } else {
        await api('/api/login', { method: 'POST', body });
        toast('登入成功，歡迎回來！');
      }
      await enter();
    } catch (e) {
      $('a-msg').textContent = e.message;
    }
  });

  // ---------- 開店 ----------
  function renderTemplates() {
    $('s-templates').innerHTML = templates.map((t) => `
      <button type="button" class="template${chosenTemplate === t.key ? ' active' : ''}" data-t="${t.key}">
        <span class="icon">${t.icon}</span>
        <span class="name">${esc(t.name)}</span>
        <span class="count">${t.items.length} 項商品</span>
      </button>`).join('');
    $('s-templates').querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => {
      chosenTemplate = b.dataset.t;
      renderTemplates();
    }));
  }
  $('s-go').addEventListener('click', async () => {
    try {
      if (!chosenTemplate) throw new Error('請先挑一個模板');
      const data = await api('/api/shop', { method: 'POST', body: { name: $('s-name').value.trim(), template: chosenTemplate } });
      applyMe(data);
      toast('開店成功，開始營業！');
    } catch (e) {
      $('s-msg').textContent = e.message;
    }
  });

  // ---------- 主畫面 ----------
  function applyMe(data) {
    user = data.user;
    shop = data.shop;
    products = data.products || [];
    templates = data.templates || [];
    if (!user) { show('view-auth'); return; }
    if (!shop) {
      renderTemplates();
      $('s-name').value = user.name || '';
      show('view-setup');
      return;
    }
    $('h-shop').textContent = shop.name;
    $('h-user').textContent = user.email;
    renderPos();
    renderProducts();
    $('o-day').value = today();
    $('r-day').value = today();
    show('view-app');
    showTab('pos');
  }

  async function enter() {
    applyMe(await api('/api/me'));
  }

  $('h-logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST' });
    show('view-auth');
  });
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));

  // ---------- POS ----------
  function renderPos() {
    $('pos-products').innerHTML = products.map((p) => `
      <button type="button" class="item" data-id="${p.id}">
        <span class="name">${esc(p.name)}</span>
        <span class="price">$${p.price}</span>
        ${p.category ? `<span class="cat">${esc(p.category)}</span>` : ''}
      </button>`).join('') || '<p class="muted">還沒有商品，先到「商品」新增。</p>';
    $('pos-products').querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.id);
      cart.set(id, (cart.get(id) || 0) + 1);
      renderCart();
    }));
    renderCart();
  }

  function renderCart() {
    const box = $('cart-items');
    if (!cart.size) { box.innerHTML = '<p class="muted">點左邊的商品加入</p>'; }
    else {
      box.innerHTML = [...cart].map(([id, qty]) => {
        const p = products.find((x) => x.id === id);
        return `<div class="cart-line">
          <button data-dec="${id}">−</button><b>${qty}</b><button data-inc="${id}">＋</button>
          <span class="n">${esc(p.name)} <span class="muted">$${p.price}</span></span>
          <span>$${p.price * qty}</span>
        </div>`;
      }).join('');
      box.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => { cart.set(Number(b.dataset.inc), cart.get(Number(b.dataset.inc)) + 1); renderCart(); }));
      box.querySelectorAll('[data-dec]').forEach((b) => {
        const id = Number(b.dataset.dec);
        b.addEventListener('click', () => { cart.set(id, cart.get(id) - 1); if (cart.get(id) <= 0) cart.delete(id); renderCart(); });
      });
    }
    const total = [...cart].reduce((s, [id, qty]) => s + products.find((x) => x.id === id).price * qty, 0);
    $('cart-total').textContent = total;
  }

  $('pos-submit').addEventListener('click', async () => {
    $('pos-msg').textContent = '';
    if (!cart.size) { $('pos-msg').textContent = '購物車是空的'; return; }
    try {
      await api('/api/orders', {
        method: 'POST',
        body: { day: today(), items: [...cart].map(([id, qty]) => ({ id, qty })) },
      });
      cart.clear();
      renderCart();
      $('pos-msg').textContent = '';
      $('pos-submit').textContent = '✓ 已記錄';
      toast('交易已記錄');
      setTimeout(() => { $('pos-submit').textContent = '完成這筆交易'; }, 1200);
      if (!$('tab-orders').hidden) loadOrders();
      if (!$('tab-report').hidden) loadReport();
    } catch (e) {
      $('pos-msg').textContent = e.message;
    }
  });

  // ---------- 訂單 ----------
  async function loadOrders() {
    const day = $('o-day').value || today();
    try {
      const data = await api(`/api/orders?day=${day}`);
      $('o-summary').textContent = `本日 ${data.summary.count} 筆，共 $${data.summary.total}`;
      $('o-list').innerHTML = data.orders.map((o) => `
        <div class="order">
          <div class="head">
            <b>#${o.id}</b><span class="time">${o.created_at} UTC</span>
            <span class="total">$${o.total}</span>
          </div>
          <div class="lines">${o.items.map((it) => `${esc(it.name)}×${it.qty}`).join('、')}</div>
        </div>`).join('') || '<p class="muted">這天還沒有訂單。</p>';
    } catch (e) {
      $('o-list').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }
  $('o-day').addEventListener('change', loadOrders);

  // ---------- 報表 ----------
  async function loadReport() {
    const day = $('r-day').value || today();
    try {
      const r = await api(`/api/report?day=${day}`);
      $('r-cards').innerHTML = `
        <div class="card"><div class="k">交易筆數</div><div class="v">${r.count}</div></div>
        <div class="card"><div class="k">本日總額</div><div class="v">$${r.total}</div></div>
        <div class="card"><div class="k">平均單筆</div><div class="v">$${r.average}</div></div>`;
      $('r-table').querySelector('tbody').innerHTML = r.byProduct.map((p) => `
        <tr><td>${esc(p.name)}</td><td class="num">${p.qty}</td><td class="num amount">$${p.amount}</td></tr>`).join('')
        || '<tr><td colspan="3" class="muted">這天還沒有交易。</td></tr>';
    } catch (e) {
      $('r-cards').innerHTML = `<p class="error">${esc(e.message)}</p>`;
    }
  }
  $('r-day').addEventListener('change', loadReport);

  // ---------- 商品管理 ----------
  function renderProducts() {
    $('p-list').innerHTML = products.map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td class="num">$${p.price}</td>
        <td>${esc(p.category || '')}</td>
        <td class="num"><button class="ghost small" data-del="${p.id}">刪除</button></td>
      </tr>`).join('');
    $('p-list').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('刪除這個商品？（舊訂單不受影響）')) return;
      await api(`/api/products/${b.dataset.del}`, { method: 'DELETE' });
      await refreshProducts();
    }));
  }
  $('p-add').addEventListener('click', async () => {
    $('p-msg').textContent = '';
    try {
      await api('/api/products', {
        method: 'POST',
        body: { name: $('p-name').value.trim(), price: Number($('p-price').value), category: $('p-cat').value.trim() },
      });
      $('p-name').value = ''; $('p-price').value = ''; $('p-cat').value = '';
      await refreshProducts();
    } catch (e) {
      $('p-msg').textContent = e.message;
    }
  });
  async function refreshProducts() {
    const data = await api('/api/me');
    products = data.products;
    renderPos();
    renderProducts();
  }

  // ---------- 啟動 ----------
  enter().catch(() => show('view-auth'));
})();
