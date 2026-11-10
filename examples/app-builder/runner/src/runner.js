// app-runner：執行 app-builder 產生的 app
//   /apps/:id/...   靜態網站直接回傳；全端專案動態載入 src/worker.js，env.DB 是該專案專屬的 SQLite Durable Object
//
// 為什麼和 app-builder 分開：產生的程式碼是使用者（透過 AI）寫的，等於不可信的程式。
// 和 app-builder 在同一個程序裡，它就能讀到 env（AUTH_SECRET、AI 金鑰）、改掉 crypto / fetch 偷密碼。
// 這裡是另一個 Node 程序，env 只有 BUILDER（只能讀專案檔案的 RPC）和 PROJECT_DB，
// 而且要用和 app-builder 不同的主機名稱開（cookie 不分埠號），瀏覽器才不會把 app-builder 的登入 cookie 送過來。
//
// 限制：所有產生的 app 共用這一個程序，彼此之間沒有隔離（可以互相干擾、讀別的專案的資料）。

import { DurableObject } from 'cloudflare:workers';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

const page = (status, msg) => new Response(`<!doctype html><meta charset="utf-8"><h1>${msg}</h1>`, {
  status, headers: { 'content-type': 'text/html; charset=utf-8' },
});

// ---------- 每個全端專案一個 SQLite Durable Object（名字 p<專案id>），當作它專屬的 D1 ----------

export class ProjectDb extends DurableObject {
  async init({ schema }) {
    const cur = (schema || '').trim();
    const applied = await this.ctx.storage.kv.get('schema') || '';
    if (!cur || cur === applied) return { ok: true };
    try {
      this.ctx.storage.sql.exec(cur);
      await this.ctx.storage.kv.put('schema', cur);
      return { ok: true, applied: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  async exec({ sql, params = [], mode, col }) {
    try {
      const db = this.ctx.storage.sql;
      const cursor = db.exec(sql, ...params);
      const rows = cursor.toArray();
      const changes = cursor.rowsWritten ?? 0;
      if (mode === 'first') {
        const row = rows[0] ?? null;
        return { value: col != null ? (row ? row[col] : null) : row };
      }
      if (mode === 'raw') return { rows };
      let lastRowId = null;
      if (mode === 'run' && /\binsert\b/i.test(sql)) {
        lastRowId = db.exec('SELECT last_insert_rowid() AS id').one().id;
      }
      return { rows, changes, lastRowId };
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }
}

const dbErr = (r) => { throw new Error(`D1_ERROR: ${r.error}`); };

// D1 相容介面（prepare/bind/all/first/run/raw/batch/exec），背後走 ProjectDb
function makeD1(stub) {
  const exec = (body) => stub.exec(body).then((r) => (r.error ? dbErr(r) : r));
  return {
    prepare(sql) {
      const stmt = { sql, params: [] };
      stmt.bind = (...p) => { stmt.params = p; return stmt; };
      stmt.run = async () => {
        const r = await exec({ sql, params: stmt.params, mode: 'run' });
        return { success: true, meta: { changes: r.changes ?? 0, last_row_id: r.lastRowId ?? null, duration: 0 } };
      };
      stmt.all = async () => {
        const r = await exec({ sql, params: stmt.params, mode: 'all' });
        return { results: r.rows ?? [], success: true, meta: { changes: r.changes ?? 0, duration: 0 } };
      };
      stmt.first = async (col) => (await exec({ sql, params: stmt.params, mode: 'first', col })).value;
      stmt.raw = async () => (await exec({ sql, params: stmt.params, mode: 'raw' })).rows ?? [];
      return stmt;
    },
    async batch(stmts) {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
    async exec(sql) {
      const r = await exec({ sql, mode: 'raw' });
      return { count: (r.rows ?? []).length };
    },
    async dump() { return null; },
  };
}

const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', ico: 'image/x-icon' };
const mimeOf = (p) => MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';

// env.ASSETS：從專案檔案回傳前端
function makeAssets(files) {
  return {
    async fetch(request) {
      const p = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
      const key = p === '' || p === 'index.html' ? 'public/index.html'
        : files.has('public/' + p) ? 'public/' + p
        : files.has(p) ? p : 'public/index.html'; // SPA fallback
      const content = files.get(key);
      if (content == null) return new Response('Not found', { status: 404 });
      return new Response(content, { headers: { 'content-type': mimeOf(key) } });
    },
  };
}

// 載入產生的 src/worker.js（export default { fetch }，不可使用 import）
function loadGenWorker(code) {
  if (/^\s*import\s/m.test(code)) throw new Error('產生的 worker.js 使用了 import，無法執行。請請 AI 改成單檔、只用 export default。');
  const js = code.replace(/export\s+default\s*/, 'const __default =');
  return new Function(js + '\n;return typeof __default !== "undefined" ? __default : null;')();
}

const cache = new Map(); // "id:version" → { mode, files, worker, note, db }

async function load(env, id, v) {
  const r = await env.BUILDER.resolve(id, v);
  if (!r) return null;
  const key = `${id}:${r.version}`;
  let entry = cache.get(key);
  if (entry) return entry;
  const files = new Map((await env.BUILDER.files(id, r.version)).map((f) => [f.path, f.content]));
  entry = { mode: r.mode, files, worker: null, note: '', db: null };
  if (r.mode === 'full') {
    const code = files.get('src/worker.js');
    if (code) {
      try { entry.worker = loadGenWorker(code); } catch (e) { entry.note = String(e?.message || e); }
    }
    const stub = env.PROJECT_DB.getByName('p' + id);
    const schema = files.get('schema.sql');
    if (schema) await stub.init({ schema });
    entry.db = makeD1(stub);
  }
  cache.set(key, entry);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return entry;
}

async function serve(request, env, id, rest, search, v) {
  const entry = await load(env, id, v);
  if (!entry) return page(404, '找不到這個 app，或它還沒有任何版本');
  const noStore = { 'cache-control': 'no-store' };

  if (entry.mode !== 'full') {
    return new Response(entry.files.get('index.html') ?? '', { headers: { 'content-type': MIME.html, ...noStore } });
  }

  // 掛在 /apps/<id>/ 底下，前端才能用相對路徑呼叫自己的 API
  if (rest === '' && !new URL(request.url).pathname.endsWith('/')) {
    return Response.redirect(new URL(`/apps/${id}/${search}`, request.url), 307);
  }

  if (entry.worker && (rest.startsWith('/api/') || rest === '/api')) {
    const req2 = new Request(new URL('https://generated.local' + rest + search), request);
    try {
      return await entry.worker.fetch(req2, { DB: entry.db, ASSETS: makeAssets(entry.files) }, { waitUntil() {}, passThroughOnException() {} });
    } catch (e) {
      return json({ error: `產生的 app 執行錯誤：${e?.message || e}` }, 500);
    }
  }

  // 其他路徑 → 靜態檔案（找不到就回 index.html，SPA 友善）
  const p = decodeURIComponent(rest).replace(/^\/+/, '') || 'index.html';
  const keys = p === 'index.html' ? ['public/index.html'] : ['public/' + p, p];
  let content = null;
  for (const k of keys) if (entry.files.has(k)) { content = entry.files.get(k); break; }
  if (content == null) content = entry.files.get('public/index.html') ?? `<h1>Not found</h1><pre>${entry.note}</pre>`;
  return new Response(content, { headers: { 'content-type': mimeOf(p === 'index.html' ? 'a.html' : p), ...noStore } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/apps\/(\d+)(\/.*)?$/);
    if (!m) return page(404, 'app-runner：這裡只提供 /apps/&lt;id&gt;/');
    const v = Number(url.searchParams.get('v')) || null;
    try {
      return await serve(request, env, Number(m[1]), m[2] || '', url.search, v);
    } catch (e) {
      return page(500, `app-runner 錯誤：${String(e?.message || e).replace(/</g, '&lt;')}`);
    }
  },
};
