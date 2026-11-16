// friendbook 的 Cloudflare Worker：
//   小紅書形式的內容（短筆記、按讚、留言、追蹤、熱門）＋ Threads 的美術風格。
//   /api/*  帳號、貼文、留言、讚、追蹤（D1）
//   KV     讚數快取（like:*）、瀏覽數（views:*）、熱門排行（hot:*），避免每頁都 COUNT
//   其他    靜態檔案（public/，由 Assets 提供）

const COOKIE = 'session';
const SESSION_DAYS = 30;
const enc = new TextEncoder();
const PAGE_SIZE = 20;

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

// ---------- 共用 ----------

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

// KV 上的讚數快取：讀取時用快取值，沒有才 COUNT 一次並寫回
async function likeCount(db, kv, postId) {
  const cached = await kv.get(`like:${postId}`);
  if (cached !== null) return Number(cached);
  const row = await db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').bind(postId).first();
  const n = row.n;
  await kv.put(`like:${postId}`, String(n), { expirationTtl: 86400 * 7 });
  return n;
}

// 按讚時直接對快取 +1（PROCESSê頻率最高的動作，不必每次去 D1 數）
async function bumpLike(kv, postId, delta) {
  const key = `like:${postId}`;
  const n = Math.max(0, Number(await kv.get(key) || 0) + delta);
  await kv.put(key, String(n), { expirationTtl: 86400 * 7 });
  return n;
}

// 熱門排行：每次按讚都把這篇的分數記進當天的 hot:{day} rank
async function bumpHot(kv, postId) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const key = `hot:${day}`;
  const rank = new Map(Object.entries(await kv.get(key, 'json') || {}).map(([k, v]) => [Number(k), Number(v)]));
  rank.set(postId, (rank.get(postId) || 0) + 1);
  await kv.put(key, JSON.stringify(Object.fromEntries([...rank.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 20))), { expirationTtl: 86400 * 2 });
}

// ---------- 顯示層：把資料列轉成前端格式 ----------

async function decoratePost(db, kv, post, meId) {
  const [likes, commentCount, liked, author] = await Promise.all([
    likeCount(db, kv, post.id),
    db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ? AND deleted = 0').bind(post.id).first(),
    meId ? db.prepare('SELECT 1 AS x FROM likes WHERE post_id = ? AND user_id = ?').bind(post.id, meId).first() : Promise.resolve(null),
    db.prepare('SELECT id, name, bio FROM users WHERE id = ?').bind(post.user_id).first(),
  ]);
  return {
    id: post.id,
    text: post.text,
    image: post.image || '',
    createdAt: post.created_at,
    author,
    likes,
    comments: commentCount.n,
    likedByMe: !!liked,
    mine: meId === post.user_id,
  };
}

function tagsOf(text) {
  return [...new Set([...text.matchAll(/#([^\s#<>]{1,24})/g)].map((m) => m[1]))];
}

// ---------- 帳號 ----------

async function signup(request, env, db) {
  return handle(async () => {
    if (!env.AUTH_SECRET) throw new HttpError(500, 'Worker 缺少密鑰 AUTH_SECRET。請執行：npx wrangler secret put AUTH_SECRET');
    const { email, password, name } = await readJson(request);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) throw new HttpError(400, '請輸入正確的 email');
    if (String(password || '').length < 6) throw new HttpError(400, '密碼至少 6 個字');
    const handle_ = String(name || '').trim().replace(/^@+/, '');
    if (!/^[a-z0-9_\.]{2,20}$/i.test(handle_)) throw new HttpError(400, '帳號代號要是 2–20 個英數字、底線或點');
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    let result;
    try {
      result = await db.prepare('INSERT INTO users (email, name, pass_hash, pass_salt) VALUES (?, ?, ?, ?)')
        .bind(String(email).toLowerCase(), handle_, hash, salt).run();
    } catch (e) {
      throw new HttpError(400, '這個 email 或帳號代號已經有人用了');
    }
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(result.meta.last_row_id, env) });
  });
}

async function login(request, env, db) {
  return handle(async () => {
    if (!env.AUTH_SECRET) throw new HttpError(500, 'Worker 缺少密鑰 AUTH_SECRET。請執行：npx wrangler secret put AUTH_SECRET');
    const { email, password } = await readJson(request);
    const user = await db.prepare('SELECT * FROM users WHERE email = ?')
      .bind(String(email || '').toLowerCase()).first();
    if (!user) throw new HttpError(400, 'email 或密碼不對');
    const hash = await hashPassword(String(password || ''), user.pass_salt);
    if (hash !== user.pass_hash) throw new HttpError(400, 'email 或密碼不對');
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(user.id, env) });
  });
}

function logout() {
  return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });
}

async function mePayload(db, userId) {
  const user = await db.prepare('SELECT id, name, bio FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw new HttpError(401, '帳號不存在');
  return { user };
}

// ---------- 圖片（KV，25MB 以下都能放；之後量大再升級 R2）----------

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const IMAGE_MAX = 5 * 1024 * 1024;

async function uploadImage(request, env, userId) {
  return handle(async () => {
    const form = await request.formData().catch(() => { throw new HttpError(400, '格式不對'); });
    const file = form.get('image');
    if (!file || typeof file === 'string') throw new HttpError(400, '沒有收到圖片');
    const ext = IMAGE_TYPES[file.type];
    if (!ext) throw new HttpError(400, '只支援 jpeg / png / webp / gif');
    if (file.size > IMAGE_MAX) throw new HttpError(400, '圖片最大 5MB');
    const key = `img:p${userId}-${Date.now().toString(36)}${randomHex(4)}.${ext}`;
    await env.KV.put(key, await file.arrayBuffer(), {
      metadata: { type: file.type },
    });
    return json({ url: `/img/${key.slice(4)}` });
  });
}

// 公開取回圖片（feed 也要顯示）
function serveImage(env, key) {
  if (!/^[a-z0-9-]+\.(jpg|png|webp|gif)$/.test(key)) return json({ error: '找不到圖片' }, 404);
  return env.KV.getWithMetadata(`img:${key}`, 'arrayBuffer').then((r) => {
    if (!r.value) return json({ error: '找不到圖片' }, 404);
    const type = (r.metadata && r.metadata.type) || ({
      jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    })[key.split('.').pop()] || 'application/octet-stream';
    return new Response(r.value, {
      headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' },
    });
  }).catch(() => json({ error: '讀取圖片失敗' }, 500));
}

// ---------- 貼文 ----------

async function createPost(request, env, db, userId) {
  return handle(async () => {
    const { text, image } = await readJson(request);
    const body = String(text || '').trim();
    const posted = await verifyOwnImage(env, userId, image); // 檢查網址是本帳號剛上傳的
    if (!body && !posted) throw new HttpError(400, '寫點內容吧，或貼一張圖');
    if (body.length > 10000) throw new HttpError(400, '貼文最長 10000 字');
    const r = await db.prepare('INSERT INTO posts (user_id, text, image) VALUES (?, ?, ?)')
      .bind(userId, body, posted || '').run();
    return json({ id: r.meta.last_row_id, tags: tagsOf(body) });
  });
}

// 圖片網址只能是 /img/p{自己userId}-... 的 key，避免連到別人的或任意
async function verifyOwnImage(env, userId, url) {
  const u = String(url || '');
  if (!u) return '';
  const m = u.match(/^\/img\/(p(\d+)-[a-z0-9-]+\.(jpg|png|webp|gif))$/);
  if (!m) throw new HttpError(400, '圖片網址不對，請重新上傳');
  if (Number(m[2]) !== userId) throw new HttpError(403, '不能用其他帳號的圖片');
  if (!(await env.KV.get(`img:${m[1]}`))) throw new HttpError(400, '找不到上傳的圖片，請重新上傳');
  return u;
}

async function getPost(db, env, userId, id) {
  return handle(async () => {
    const post = await db.prepare('SELECT * FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
    if (!post) throw new HttpError(404, '找不到這篇貼文');
    const comments = (await db.prepare(
      `SELECT c.id, c.text, c.created_at, u.name, u.id AS user_id
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = ? AND c.deleted = 0 ORDER BY c.id`)
      .bind(id).all()).results;
    const viewKey = `views:${id}`;
    const views = Number(await env.KV.get(viewKey) || 0) + 1;
    await env.KV.put(viewKey, String(views), { expirationTtl: 86400 * 7 });
    return json({
      post: await decoratePost(db, env.KV, post, userId),
      comments: comments.map((c) => ({ ...c, mine: userId === c.user_id })),
      views,
    });
  });
}

async function deletePost(env, db, kv, userId, id) {
  return handle(async () => {
    const owned = await db.prepare('SELECT id FROM posts WHERE id = ? AND user_id = ? AND deleted = 0')
      .bind(id, userId).first();
    if (!owned) throw new HttpError(404, '找不到自己的這篇貼文');
    const post = await db.prepare('SELECT image FROM posts WHERE id = ?').bind(id).first();
    await db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').bind(id).run();
    await kv.delete(`like:${id}`);
    if (post && post.image.startsWith('/img/')) await env.KV.delete(`img:${post.image.slice(5)}`).catch(() => {});
    return json({ ok: true });
  });
}

// ---------- 按讚（toggle）----------

async function toggleLike(db, env, userId, id) {
  return handle(async () => {
    const post = await db.prepare('SELECT id, user_id FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
    if (!post) throw new HttpError(404, '找不到這篇貼文');
    const liked = await db.prepare('SELECT 1 AS x FROM likes WHERE post_id = ? AND user_id = ?')
      .bind(id, userId).first();
    if (liked) {
      await db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?').bind(id, userId).run();
    } else {
      await db.prepare('INSERT INTO likes (post_id, user_id) VALUES (?, ?)').bind(id, userId).run();
      await bumpHot(env.KV, id);
    }
    const likes = await bumpLike(env.KV, id, liked ? -1 : 1);
    return json({ liked: !liked, likes });
  });
}

// ---------- 留言 ----------

async function createComment(request, db, userId, id) {
  return handle(async () => {
    const { text } = await readJson(request);
    const body = String(text || '').trim().slice(0, 500);
    if (!body) throw new HttpError(400, '留言不能是空的');
    const post = await db.prepare('SELECT id FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
    if (!post) throw new HttpError(404, '找不到這篇貼文');
    const r = await db.prepare('INSERT INTO comments (post_id, user_id, text) VALUES (?, ?, ?)')
      .bind(id, userId, body).run();
    return json({ id: r.meta.last_row_id });
  });
}

async function deleteComment(db, userId, cid) {
  return handle(async () => {
    const owned = await db.prepare('SELECT id FROM comments WHERE id = ? AND user_id = ? AND deleted = 0')
      .bind(cid, userId).first();
    if (!owned) throw new HttpError(404, '找不到這則留言');
    await db.prepare('UPDATE comments SET deleted = 1 WHERE id = ?').bind(cid).run();
    return json({ ok: true });
  });
}

// ---------- 動態牆 ----------

async function feed(db, kv, userId, tab, cursor) {
  return handle(async () => {
    const bind = [];
    let where = '';
    if (tab === 'following') {
      where = `AND p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)
               AND p.user_id != ?`;
      bind.push(userId, userId);
    } else if (tab === 'mine') {
      where = 'AND p.user_id = ?';
      bind.push(userId);
    } else {
      // 為你推薦：最新的公開貼文
      where = '';
    }
    if (cursor) { where += ' AND p.id < ?'; bind.push(cursor); }
    const rows = (await db.prepare(
      `SELECT p.* FROM posts p
       WHERE p.deleted = 0 ${where}
       ORDER BY p.id DESC LIMIT ?`).bind(...bind, PAGE_SIZE + 1).all()).results;
    const hasMore = rows.length > PAGE_SIZE;
    const list = rows.slice(0, PAGE_SIZE); // 用 id 作為下次的分頁游標
    return json({
      posts: await Promise.all(list.map((p) => decoratePost(db, kv, p, userId))),
      nextCursor: hasMore ? list[list.length - 1].id : null,
    });
  });
}

// ---------- 追蹤 ----------

async function toggleFollow(db, userId, target) {
  return handle(async () => {
    if (target === userId) throw new HttpError(400, '不能追蹤自己');
    const exists = await db.prepare('SELECT id FROM users WHERE id = ?').bind(target).first();
    if (!exists) throw new HttpError(404, '找不到這位使用者');
    const followed = await db.prepare('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?')
      .bind(userId, target).first();
    if (followed) {
      await db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').bind(userId, target).run();
    } else {
      await db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)').bind(userId, target).run();
    }
    return json({ following: !followed });
  });
}

// ---------- 個人頁 ----------

async function profile(db, kv, meId, name) {
  return handle(async () => {
    const user = await db.prepare('SELECT id, name, bio FROM users WHERE name = ?')
      .bind(decodeURIComponent(name).replace(/^@+/, '')).first();
    if (!user) throw new HttpError(404, '找不到這位使用者');
    const posts = (await db.prepare(
      'SELECT * FROM posts WHERE user_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 30').bind(user.id).all()).results;
    const followers = await db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?')
      .bind(user.id).first();
    const followingN = await db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?')
      .bind(user.id).first();
    const meFollows = meId
      ? await db.prepare('SELECT 1 AS x FROM follows WHERE follower_id = ? AND followee_id = ?')
          .bind(meId, user.id).first()
      : null;
    return json({
      user,
      followers: followers.n,
      following: followingN.n,
      meFollows: !!meFollows,
      isMe: meId === user.id,
      posts: await Promise.all(posts.map((p) => decoratePost(db, kv, p, meId))),
    });
  });
}

// ---------- 熱門（KV rank）----------

async function hot(db, kv) {
  return handle(async () => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rank = await kv.get(`hot:${day}`, 'json') || {};
    const ids = Object.keys(rank).map(Number);
    const posts = [];
    for (const id of ids) {
      const p = await db.prepare('SELECT * FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
      if (p) posts.push(await decoratePost(db, kv, p, null));
    }
    return json({ posts });
  });
}

// ---------- 路由 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const db = env.DB;
    if (!db) return json({ error: 'Worker 缺少 D1 綁定 DB' }, 500);
    if (!env.KV) return json({ error: 'Worker 缺少 KV 綁定 KV' }, 500);

    if (p === '/api/signup') return signup(request, env, db);
    if (p === '/api/login') return login(request, env, db);
    if (p === '/api/logout') return logout();
    const ia = p.match(/^\/img\/([a-z0-9-]+\.(jpg|png|webp|gif))$/);
    if (ia && request.method === 'GET') return serveImage(env, ia[1]);

    const userId = await currentUserId(request, env);

    // 公開端點：訪客也能看
    if (p === '/api/feed') return feed(db, env.KV, userId, url.searchParams.get('tab') || 'recommend',
      url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : null);
    const ma = p.match(/^\/api\/posts\/(\d+)$/);
    if (ma && request.method === 'GET') return getPost(db, env, userId, Number(ma[1]));
    const pu = p.match(/^\/api\/u\/(.+)$/);
    if (pu && request.method === 'GET') return profile(db, env.KV, userId, pu[1]);
    if (p === '/api/hot') return hot(db, env.KV);

    if (!userId) return json({ error: '請先登入' }, 401);

    if (p === '/api/me') return handle(async () => json(await mePayload(db, userId)));
    if (p === '/api/upload' && request.method === 'POST') return uploadImage(request, env, userId);
    if (p === '/api/posts' && request.method === 'POST') return createPost(request, env, db, userId);
    const ma2 = p.match(/^\/api\/posts\/(\d+)$/);
    if (ma2 && request.method === 'DELETE') return deletePost(env, db, env.KV, userId, Number(ma2[1]));
    const la = p.match(/^\/api\/posts\/(\d+)\/like$/);
    if (la && request.method === 'POST') return toggleLike(db, env, userId, Number(la[1]));
    const ca = p.match(/^\/api\/posts\/(\d+)\/comments$/);
    if (ca && request.method === 'POST') return createComment(request, db, userId, Number(ca[1]));
    const cd = p.match(/^\/api\/comments\/(\d+)$/);
    if (cd && request.method === 'DELETE') return deleteComment(db, userId, Number(cd[1]));
    const fa = p.match(/^\/api\/follow\/(\d+)$/);
    if (fa && request.method === 'POST') return toggleFollow(db, userId, Number(fa[1]));

    if (p === '/') return Response.redirect(new URL('/index.html', request.url), 302);
    return env.ASSETS.fetch(request);
  },
};
