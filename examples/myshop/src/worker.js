// myshop 的 Cloudflare Worker：
//   /api/*  帳號（signup/login/logout，HMAC 簽章 cookie）、商店、商品、訂單與報表（D1）
//   其他    靜態檔案（public/，由 Assets 提供）
// 沒有金流：交易只記錄在資料庫，是純 POS 系統。

import { TEMPLATES, TEMPLATE_LIST } from './templates.js';

const COOKIE = 'session';
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
});

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((b) => parseInt(b, 16)));
const randomHex = (bytes) => hex(crypto.getRandomValues(new Uint8Array(bytes)));

async function hmacHex(data, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: unhex(saltHex), iterations: 100_000, hash: 'SHA-256' }, key, 256));
}

// ---------- session cookie：userId.expiry.hmac，不查資料庫 ----------

function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m && decodeURIComponent(m[1]);
}

async function sessionCookie(userId, env) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = `${userId}.${exp}`;
  const token = `${payload}.${await hmacHex(payload, env.AUTH_SECRET)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

async function currentUserId(request, env) {
  const token = getCookie(request, COOKIE);
  if (!token) return null;
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
  if ((await hmacHex(`${id}.${exp}`, env.AUTH_SECRET)) !== sig) return null;
  return Number(id);
}

// ---------- 共用查詢 ----------

async function shopOf(db, userId) {
  return db.prepare('SELECT * FROM shops WHERE user_id = ? ORDER BY id LIMIT 1').bind(userId).first();
}

async function requireShop(db, userId) {
  const shop = await shopOf(db, userId);
  if (!shop) throw new HttpError(400, '還沒有開店，請先選模板開店。');
  return shop;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { throw new HttpError(400, '格式不對'); }
}

async function handle(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: `伺服器錯誤：${e.message}` }, 500);
  }
}

async function mePayload(db, userId) {
  const user = await db.prepare('SELECT id, email, name FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw new HttpError(401, '帳號不存在');
  const shop = await shopOf(db, userId);
  let products = [];
  if (shop) {
    products = (await db.prepare('SELECT id, name, price, category, sort FROM products WHERE shop_id = ? AND deleted = 0 ORDER BY sort, id')
      .bind(shop.id).all()).results;
  }
  return { user, shop, products, templates: TEMPLATE_LIST };
}

// ---------- 帳號 ----------

async function signup(request, env, db) {
  return handle(async () => {
    if (!env.AUTH_SECRET) throw new HttpError(500, 'Worker 缺少密鑰 AUTH_SECRET。請執行：npx wrangler secret put AUTH_SECRET');
    const { email, password, name } = await readJson(request);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) throw new HttpError(400, '請輸入正確的 email');
    if (String(password || '').length < 6) throw new HttpError(400, '密碼至少 6 個字');
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    let result;
    try {
      result = await db.prepare('INSERT INTO users (email, name, pass_hash, pass_salt) VALUES (?, ?, ?, ?)')
        .bind(String(email).toLowerCase(), String(name || '').slice(0, 40), hash, salt).run();
    } catch (e) {
      throw new HttpError(400, '這個 email 已經註冊過了');
    }
    const userId = result.meta.last_row_id;
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(userId, env) });
  });
}

async function login(request, env, db) {
  return handle(async () => {
    if (!env.AUTH_SECRET) throw new HttpError(500, 'Worker 缺少密鑰 AUTH_SECRET。請執行：npx wrangler secret put AUTH_SECRET');
    const { email, password } = await readJson(request);
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(String(email || '').toLowerCase()).first();
    if (!user) throw new HttpError(400, 'email 或密碼不對');
    const hash = await hashPassword(String(password || ''), user.pass_salt);
    if (hash !== user.pass_hash) throw new HttpError(400, 'email 或密碼不對');
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(user.id, env) });
  });
}

function logout() {
  return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
}

// ---------- 商店 ----------

async function createShop(request, env, db, userId) {
  return handle(async () => {
    if (await shopOf(db, userId)) throw new HttpError(400, '你已經有商店了');
    const { name, template } = await readJson(request);
    const shopName = String(name || '').trim().slice(0, 40);
    if (!shopName) throw new HttpError(400, '請輸入店名');
    const items = TEMPLATES[template];
    if (!items) throw new HttpError(400, '請選一個開店模板');
    const result = await db.prepare('INSERT INTO shops (user_id, name, template) VALUES (?, ?, ?)')
      .bind(userId, shopName, template).run();
    const shopId = result.meta.last_row_id;
    await db.batch(items.map((p, i) =>
      db.prepare('INSERT INTO products (shop_id, name, price, category, sort) VALUES (?, ?, ?, ?, ?)')
        .bind(shopId, p.name, p.price, p.category, p.sort)));
    return json(await mePayload(db, userId));
  });
}

// ---------- 商品 ----------

async function listProducts(db, userId) {
  return handle(async () => {
    const shop = await requireShop(db, userId);
    const products = (await db.prepare('SELECT id, name, price, category, sort FROM products WHERE shop_id = ? AND deleted = 0 ORDER BY sort, id')
      .bind(shop.id).all()).results;
    return json({ products });
  });
}

async function createProduct(request, db, userId) {
  return handle(async () => {
    const shop = await requireShop(db, userId);
    const { name, price, category } = await readJson(request);
    const productName = String(name || '').trim().slice(0, 40);
    const productPrice = Math.round(Number(price));
    if (!productName) throw new HttpError(400, '請輸入商品名稱');
    if (!(productPrice >= 0)) throw new HttpError(400, '價格要是 0 以上的整數');
    const result = await db.prepare('INSERT INTO products (shop_id, name, price, category, sort) VALUES (?, ?, ?, ?, 99)')
      .bind(shop.id, productName, productPrice, String(category || '').slice(0, 20)).run();
    return json({ id: result.meta.last_row_id });
  });
}

async function updateProduct(request, db, userId, id) {
  return handle(async () => {
    const shop = await requireShop(db, userId);
    const { name, price, category } = await readJson(request);
    const owned = await db.prepare('SELECT id FROM products WHERE id = ? AND shop_id = ? AND deleted = 0')
      .bind(id, shop.id).first();
    if (!owned) throw new HttpError(404, '找不到這個商品');
    await db.prepare('UPDATE products SET name = ?, price = ?, category = ? WHERE id = ?')
      .bind(String(name || '').trim().slice(0, 40) || '未命名', Math.round(Number(price)) || 0,
            String(category || '').slice(0, 20), id).run();
    return json({ ok: true });
  });
}

async function deleteProduct(db, userId, id) {
  return handle(async () => {
    const shop = await requireShop(db, userId);
    const owned = await db.prepare('SELECT id FROM products WHERE id = ? AND shop_id = ? AND deleted = 0')
      .bind(id, shop.id).first();
    if (!owned) throw new HttpError(404, '找不到這個商品');
    await db.prepare('UPDATE products SET deleted = 1 WHERE id = ?').bind(id).run();
    return json({ ok: true });
  });
}

// ---------- 訂單（POS 交易）----------

async function createOrder(request, db, userId) {
  return handle(async () => {
    const shop = await requireShop(db, userId);
    const { day, items, note } = await readJson(request);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new HttpError(400, '缺日期');
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, '購物車是空的');

    // 價格以資料庫為準，不信前端
    const products = (await db.prepare('SELECT id, name, price FROM products WHERE shop_id = ? AND deleted = 0')
      .bind(shop.id).all()).results;
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = [];
    for (const it of items) {
      const p = byId.get(Number(it.id));
      const qty = Math.round(Number(it.qty));
      if (!p || !(qty > 0)) throw new HttpError(400, '商品或數量不對');
      lines.push({ product_id: p.id, name: p.name, price: p.price, qty });
    }
    const total = lines.reduce((s, l) => s + l.price * l.qty, 0);

    const result = await db.prepare('INSERT INTO orders (shop_id, total, day) VALUES (?, ?, ?)')
      .bind(shop.id, total, day).run();
    const orderId = result.meta.last_row_id;
    await db.batch(lines.map((l) =>
      db.prepare('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)')
        .bind(orderId, l.product_id, l.name, l.price, l.qty)));
    return json({ id: orderId, total });
  });
}

async function listOrders(db, userId, day) {
  return handle(async () => {
    const shop = await requireShop(db, userId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new HttpError(400, '缺日期');
    const orders = (await db.prepare(
      'SELECT id, total, day, created_at FROM orders WHERE shop_id = ? AND day = ? ORDER BY id DESC LIMIT 200')
      .bind(shop.id, day).all()).results;
    // 一個查詢抓這天所有明細，在 JS 分組
    const ids = orders.map((o) => o.id);
    const items = ids.length
      ? (await db.prepare(
          `SELECT order_id, name, price, qty FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`)
          .bind(...ids).all()).results
      : [];
    const byOrder = new Map();
    for (const it of items) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id).push(it);
    }
    return json({
      orders: orders.map((o) => ({ ...o, items: byOrder.get(o.id) || [] })),
      summary: {
        count: orders.length,
        total: orders.reduce((s, o) => s + o.total, 0),
      },
    });
  });
}

// ---------- 每日結算報表 ----------

async function dailyReport(db, userId, day) {
  return handle(async () => {
    const shop = await requireShop(db, userId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) throw new HttpError(400, '缺日期');
    const summary = await db.prepare(
      'SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM orders WHERE shop_id = ? AND day = ?')
      .bind(shop.id, day).first();
    const byProduct = (await db.prepare(
      `SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.qty * oi.price) AS amount
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.shop_id = ? AND o.day = ?
       GROUP BY oi.name ORDER BY amount DESC`)
      .bind(shop.id, day).all()).results;
    return json({
      day,
      count: summary.count,
      total: summary.total,
      average: summary.count ? Math.round(summary.total / summary.count) : 0,
      byProduct,
    });
  });
}

// ---------- 路由 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const db = env.DB;
    if (!db) return json({ error: 'Worker 缺少 D1 綁定 DB' }, 500);

    if (p === '/api/signup') return signup(request, env, db);
    if (p === '/api/login') return login(request, env, db);
    if (p === '/api/logout') return logout();

    const userId = await currentUserId(request, env);
    if (!userId) return json({ error: '請先登入' }, 401);

    if (p === '/api/me') return handle(async () => json(await mePayload(db, userId)));
    if (p === '/api/shop' && request.method === 'POST') return createShop(request, env, db, userId);
    if (p === '/api/products' && request.method === 'GET') return listProducts(db, userId);
    if (p === '/api/products' && request.method === 'POST') return createProduct(request, db, userId);
    if (p.startsWith('/api/products/') && request.method === 'PUT') return updateProduct(request, db, userId, Number(p.split('/')[3]));
    if (p.startsWith('/api/products/') && request.method === 'DELETE') return deleteProduct(db, userId, Number(p.split('/')[3]));
    if (p === '/api/orders' && request.method === 'POST') return createOrder(request, db, userId);
    if (p === '/api/orders' && request.method === 'GET') return listOrders(db, userId, url.searchParams.get('day'));
    if (p === '/api/report' && request.method === 'GET') return dailyReport(db, userId, url.searchParams.get('day'));

    if (p === '/') return Response.redirect(new URL('/index.html', request.url), 302);
    return env.ASSETS.fetch(request);
  },
};
