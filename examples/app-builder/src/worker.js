// app-builder：AI 網站產生器（rucloud 專用）
//   /api/*            帳號（註冊/登入，HMAC 簽章 cookie）、AI 設定、專案與對話（SSE 串流）
//   /apps/:id/...     產生出來的 app：靜態網站直接回傳；全端專案由「內建執行環境」跑
//                     （動態載入 src/worker.js，env.DB 是該專案專屬的 SQLite Durable Object）
//   其他              靜態檔案（public/，由 Assets 提供）
// AI 金鑰：使用者可在「AI 設定」填自己的 key（存 D1）；沒填就用環境變數
//   NVIDIA_API_KEY / MINIMAX_API_KEY（.dev.vars 或 rucloud.toml 的 env_file）。

import { DurableObject } from 'cloudflare:workers';

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

function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m && decodeURIComponent(m[1]);
}

async function sessionCookie(userId, env) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = `${userId}.${exp}`;
  const token = `${payload}.${await hmacHex(payload, env.AUTH_SECRET)}`;
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

async function currentUserId(request, env) {
  const secret = env.AUTH_SECRET;
  const token = getCookie(request, COOKIE);
  if (!token || !secret) return null;
  const [id, exp, sig] = token.split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
  if ((await hmacHex(`${id}.${exp}`, secret)) !== sig) return null;
  return Number(id);
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(request) {
  try { return await request.json(); } catch { throw new HttpError(400, '格式不對'); }
}

async function handle(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    return json({ error: `伺服器錯誤：${e.message}` }, 500);
  }
}

// ---------- AI 供應商（OpenAI 相容） ----------

const PROVIDERS = {
  nvidia: {
    name: 'NVIDIA NIM',
    url: () => 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    envKey: 'NVIDIA_API_KEY',
  },
  minimax: {
    name: 'MiniMax',
    url: () => 'https://api.minimaxi.com/v1/text/chatcompletion_v2',
    model: 'MiniMax-M2.5',
    envKey: 'MINIMAX_API_KEY',
  },
  custom: {
    name: '自訂（OpenAI 相容）',
    url: (base) => (base || '').replace(/\/+$/, '') + '/chat/completions',
    model: '',
    envKey: null,
  },
};

const SYSTEM_PROMPT = `你是資深網頁工程師，把使用者的需求變成可直接部署的網頁應用。

規則：
1. 產出「單一 HTML 檔」：HTML+CSS+JS 全寫在同一檔，不用後端；需要保存資料就用 localStorage。
2. 可用 CDN（unpkg、jsdelivr）引入第三方函式庫，除此之外不依賴外部服務。
3. UI 要精美、現代、響應式（RWD），介面文字用繁體中文。
4. 若是修改既有的 app，一律輸出「完整」的新版檔案，不要只輸出差異或片段。
5. 輸出格式：先用 1-3 句話說明你做了什麼，最後用 <APP> 與 </APP> 兩行標記包住完整 HTML 原始碼；標記之間不要有任何說明文字或 markdown 圍欄。`;

async function getSettings(db, userId) {
  const row = await db.prepare('SELECT * FROM settings WHERE user_id = ?').bind(userId).first();
  return row || { user_id: userId, provider: 'nvidia', base_url: '', model: '', api_key: '' };
}

function aiConfig(env, settings) {
  const p = PROVIDERS[settings.provider] || PROVIDERS.nvidia;
  return {
    id: settings.provider,
    url: p.url(settings.base_url),
    key: settings.api_key || (p.envKey && env[p.envKey]) || '',
    model: settings.model || p.model,
    envKey: p.envKey,
  };
}

// 從模型回覆中抽出完整的 HTML：優先 <APP> 標記，其次最後一個程式碼區塊，最後整段
function extractHtml(text) {
  const m = [...text.matchAll(/<APP>([\s\S]*?)<\/APP>/g)].pop();
  if (m) return m[1].trim();
  const f = [...text.matchAll(/```(?:html)?\s*\n?([\s\S]*?)(?:```|$)/g)].pop();
  if (f && /^\s*(<!doctype|<html|<div|<style|<script)/i.test(f[1].trim())) return f[1].trim();
  const t = text.trim();
  return /^\s*(<!doctype|<html)/i.test(t) ? t : null;
}

// 全端模式：從模型回覆抽出多個檔案（<FILE path="...">…</FILE>）
function normalizePath(p) {
  return String(p).replace(/^[./\\]+/, '').replace(/\\/g, '/').replace(/\.\./g, '').trim();
}
function extractFiles(text) {
  const out = [];
  for (const m of text.matchAll(/<FILE\s+(?:path|name)\s*=\s*["']([^"']+)["']\s*>\s*\n?([\s\S]*?)<\/FILE>/g)) {
    const path = normalizePath(m[1]);
    if (path) out.push({ path, content: m[2].trimEnd() + '\n' });
  }
  return out;
}

const FULLSTACK_PROMPT = `你是資深 Cloudflare Workers 工程師，把使用者的需求變成完整的 rucloud / Cloudflare Workers 全端專案（前端 + 後端 API + D1 資料庫）。這個專案會被平台即時執行，請嚴守以下規範。

輸出格式：每個檔案用標記包住，例如：
<FILE path="src/worker.js">
（完整檔案內容）
</FILE>

必須輸出這三個檔案，一律輸出「完整」內容、不要節錄：
1. src/worker.js — 只能有一個 export：export default { async fetch(request, env) {...} }。嚴禁使用任何 import 或其他 export（平台會動態載入這個檔案）。用 env.DB（D1，SQLite）做資料庫；/api/* 提供 JSON API；SQL 一律 prepare().bind() 防注入；其他路徑 return env.ASSETS.fetch(request) 回傳靜態檔案
2. public/index.html — 前端單檔（內嵌 CSS/JS，可用 CDN）。呼叫 API 必須用「相對路徑」：fetch('api/tasks')、fetch('api/tasks/1', ...)，千萬不要以 / 開頭（app 被掛在子路徑下）
3. schema.sql — CREATE TABLE IF NOT EXISTS 的資料表結構

其他規則：
- 修改既有專案時，仍要輸出所有「需要變更」檔案的完整內容
- D1 用法：await env.DB.prepare('SELECT ... WHERE id = ?').bind(id).first() / .all()（回傳 {results}）/ .run()（meta.last_row_id 是新資料的 id）
- 前端不使用需要 build 的框架，直接原生 JS；localStorage 可用
- 先用 1-3 句話說明你做了什麼，再輸出檔案；<FILE> 標記之間不要有任何說明文字或 markdown 圍欄`;

// wrangler.jsonc 由平台代產，AI 只需要管程式
function wranglerFor(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';
  return JSON.stringify(
    {
      name: slug,
      main: 'src/worker.js',
      compatibility_date: '2025-11-01',
      assets: { directory: './public', binding: 'ASSETS', run_worker_first: ['/api/*'] },
      d1_databases: [{ binding: 'DB', database_name: `${slug}-db`, database_id: 'local' }],
    },
    null, 2,
  ) + '\n';
}

// ---------- Schema（冪等，初次使用自動建立） ----------

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      pass_hash TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS settings (
      user_id INTEGER PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'nvidia',
      base_url TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'static',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      version INTEGER,
      created_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS idx_messages_project ON messages (project_id, id)',
    `CREATE TABLE IF NOT EXISTS versions (
      project_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      html TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, version)
    )`,
    `CREATE TABLE IF NOT EXISTS version_files (
      project_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      path TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, version, path)
    )`,
  ]) {
    await db.prepare(sql).run();
  }
  try { // 舊資料庫補欄位
    await db.prepare("ALTER TABLE projects ADD COLUMN mode TEXT NOT NULL DEFAULT 'static'").run();
  } catch { /* 已存在 */ }
  try {
    await db.prepare("ALTER TABLE messages ADD COLUMN reasoning TEXT NOT NULL DEFAULT ''").run();
  } catch { /* 已存在 */ }
  schemaReady = true;
}

// ---------- 帳號 ----------

async function register(request, env, db) {
  return handle(async () => {
    const { email, password } = await readJson(request);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || ''))) throw new HttpError(400, '請輸入正確的 email');
    if (String(password || '').length < 6) throw new HttpError(400, '密碼至少 6 個字');
    const salt = randomHex(16);
    const hash = await hashPassword(password, salt);
    let result;
    try {
      result = await db.prepare('INSERT INTO users (email, pass_hash, pass_salt, created_at) VALUES (?, ?, ?, ?)')
        .bind(String(email).toLowerCase(), hash, salt, new Date().toISOString()).run();
    } catch (e) {
      console.error('register failed:', e?.message || e);
      throw new HttpError(400, '這個 email 已經註冊過了');
    }
    const userId = result.meta.last_row_id;
    await db.prepare('INSERT INTO settings (user_id, provider, updated_at) VALUES (?, ?, ?)')
      .bind(userId, 'nvidia', new Date().toISOString()).run();
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(userId, env) });
  });
}

async function login(request, env, db) {
  return handle(async () => {
    const { email, password } = await readJson(request);
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(String(email || '').toLowerCase()).first();
    if (!user) throw new HttpError(400, 'email 或密碼不對');
    const hash = await hashPassword(String(password || ''), user.pass_salt);
    if (hash !== user.pass_hash) throw new HttpError(400, 'email 或密碼不對');
    return json({ ok: true }, 200, { 'Set-Cookie': await sessionCookie(user.id, env) });
  });
}

// ---------- AI 設定 ----------

async function mePayload(db, env, userId) {
  const user = await db.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw new HttpError(401, '帳號不存在');
  const s = await getSettings(db, userId);
  return {
    user,
    settings: {
      provider: s.provider,
      baseUrl: s.base_url,
      model: s.model,
      hasKey: !!s.api_key,
      keyTail: s.api_key ? s.api_key.slice(-4) : '',
    },
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id, name: p.name, model: p.model,
      hasEnvKey: !!(p.envKey && env[p.envKey]),
    })),
  };
}

async function saveSettings(request, env, db, userId) {
  return handle(async () => {
    const b = await readJson(request);
    const s = await getSettings(db, userId);
    const provider = PROVIDERS[b.provider] ? b.provider : s.provider;
    const apiKey = b.clearKey ? '' : (typeof b.apiKey === 'string' && b.apiKey !== '' ? b.apiKey.trim() : s.api_key);
    await db.prepare(
      `INSERT INTO settings (user_id, provider, base_url, model, api_key, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider, base_url = excluded.base_url,
         model = excluded.model, api_key = excluded.api_key, updated_at = excluded.updated_at`,
    ).bind(userId, provider,
      String(b.baseUrl || '').trim().slice(0, 200),
      String(b.model || '').trim().slice(0, 100),
      apiKey.slice(0, 300), new Date().toISOString()).run();
    return json(await mePayload(db, env, userId));
  });
}

// ---------- 專案 ----------

async function requireProject(db, userId, id) {
  const proj = await db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').bind(id, userId).first();
  if (!proj) throw new HttpError(404, '找不到專案');
  return proj;
}

async function projectPayload(db, proj) {
  const messages = (await db.prepare(
    'SELECT id, role, content, reasoning, version, created_at FROM messages WHERE project_id = ? ORDER BY id',
  ).bind(proj.id).all()).results;
  const full = proj.mode === 'full';
  const versions = full
    ? (await db.prepare(
        `SELECT version, SUM(LENGTH(content)) AS bytes, created_at FROM version_files
         WHERE project_id = ? GROUP BY version ORDER BY version DESC LIMIT 50`,
      ).bind(proj.id).all()).results
    : (await db.prepare(
        'SELECT version, bytes, created_at FROM versions WHERE project_id = ? ORDER BY version DESC LIMIT 50',
      ).bind(proj.id).all()).results;
  const latest = versions[0]?.version || null;
  const files = full && latest
    ? (await db.prepare(
        'SELECT path, LENGTH(content) AS bytes FROM version_files WHERE project_id = ? AND version = ? ORDER BY path',
      ).bind(proj.id, latest).all()).results
    : [];
  return { project: proj, messages, versions, latest, files };
}

async function listProjects(db, userId) {
  return handle(async () => json({
    projects: (await db.prepare(
      'SELECT id, name, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100',
    ).bind(userId).all()).results,
  }));
}

async function createProject(request, db, userId) {
  return handle(async () => {
    const { name, mode } = await readJson(request);
    const n = String(name || '').trim().slice(0, 60) || '未命名專案';
    const m = mode === 'full' ? 'full' : 'static';
    const now = new Date().toISOString();
    const r = await db.prepare('INSERT INTO projects (user_id, name, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(userId, n, m, now, now).run();
    return json({ id: r.meta.last_row_id, name: n, mode: m });
  });
}

async function getProject(db, userId, id) {
  return handle(async () => json(await projectPayload(db, await requireProject(db, userId, id))));
}

async function deleteProject(db, userId, id) {
  return handle(async () => {
    const proj = await requireProject(db, userId, id);
    await db.batch([
      db.prepare('DELETE FROM messages WHERE project_id = ?').bind(proj.id),
      db.prepare('DELETE FROM versions WHERE project_id = ?').bind(proj.id),
      db.prepare('DELETE FROM version_files WHERE project_id = ?').bind(proj.id),
      db.prepare('DELETE FROM projects WHERE id = ?').bind(proj.id),
    ]);
    return json({ ok: true });
  });
}

async function versionHtml(db, userId, id, v, path) {
  return handle(async () => {
    const proj = await requireProject(db, userId, id);
    const ver = v || (await db.prepare(
      'SELECT MAX(version) AS v FROM ' + (proj.mode === 'full' ? 'version_files' : 'versions') + ' WHERE project_id = ?',
    ).bind(proj.id).first())?.v;
    if (!ver) throw new HttpError(404, '還沒有任何版本');
    if (proj.mode === 'full') {
      if (!path) throw new HttpError(400, '需要 path 參數');
      const row = await db.prepare(
        'SELECT path, content FROM version_files WHERE project_id = ? AND version = ? AND path = ?',
      ).bind(proj.id, ver, normalizePath(path)).first();
      if (!row) throw new HttpError(404, '找不到這個檔案');
      return json({ version: ver, path: row.path, html: row.content });
    }
    const row = await db.prepare('SELECT version, html FROM versions WHERE project_id = ? AND version = ?')
      .bind(proj.id, ver).first();
    if (!row) throw new HttpError(404, '還沒有任何版本');
    return json(row);
  });
}

// ---------- AI 對話（SSE 串流，結束時存訊息與新版本） ----------

async function chat(request, env, db, userId, projectId) {
  const proj = await requireProject(db, userId, projectId);
  const { content } = await readJson(request);
  const text = String(content || '').trim().slice(0, 8000);
  if (!text) throw new HttpError(400, '請輸入內容');
  const settings = await getSettings(db, userId);
  const cfg = aiConfig(env, settings);
  if (!cfg.key) {
    throw new HttpError(400, `還沒有 AI 金鑰：請在「AI 設定」填入，或在環境變數提供 ${cfg.envKey || '自訂供應商的金鑰'}。`);
  }

  const now = new Date().toISOString();
  // 客戶端斷線重試時會重送相同訊息：若最後一則就是相同的 user 訊息（且沒有回覆），就不重複存
  const last = await db.prepare('SELECT role, content FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT 1')
    .bind(proj.id).first();
  if (!(last && last.role === 'user' && last.content === text)) {
    await db.prepare('INSERT INTO messages (project_id, role, content, created_at) VALUES (?, ?, ?, ?)')
      .bind(proj.id, 'user', text, now).run();
  }

  const full = proj.mode === 'full';
  const latest = full
    ? await db.prepare('SELECT MAX(version) AS version FROM version_files WHERE project_id = ?').bind(proj.id).first()
    : await db.prepare('SELECT version, html FROM versions WHERE project_id = ? ORDER BY version DESC LIMIT 1')
        .bind(proj.id).first();
  const history = (await db.prepare(
    'SELECT role, content FROM messages WHERE project_id = ? ORDER BY id DESC LIMIT 12',
  ).bind(proj.id).all()).results.reverse()
    .filter((m) => m.content.trim()) // 跳過空訊息（先前失敗的請求會留空）
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  let sys = full ? FULLSTACK_PROMPT : SYSTEM_PROMPT;
  if (latest?.version) {
    if (full) {
      const rows = (await db.prepare(
        'SELECT path, content FROM version_files WHERE project_id = ? AND version = ? ORDER BY path',
      ).bind(proj.id, latest.version).all()).results;
      const current = rows.map((r) => `<FILE path="${r.path}">\n${r.content}\n</FILE>`).join('\n');
      sys += `\n\n這個專案目前的完整原始碼（使用者接下來會要求修改它）：\n${current.slice(0, 100_000)}`;
    } else {
      sys += `\n\n這個專案目前的 app 原始碼（使用者接下來會要求修改它）：\n<APP>\n${latest.html.slice(0, 80000)}\n</APP>`;
    }
  }

  return new Response(new ReadableStream({
    async start(controller) {
      const e2 = new TextEncoder();
      const send = (o) => controller.enqueue(e2.encode(`data: ${JSON.stringify(o)}\n\n`));
      let answer = '';
      let think = '';
      try {
        let attempt = 0;
        while (true) {
        attempt++;
        let complete = false;
        const upstream = await fetch(cfg.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: cfg.model,
            stream: true,
            max_tokens: 32000,
            temperature: 0.4,
            messages: [{ role: 'system', content: sys }, ...history],
          }),
        });
        const ct = upstream.headers.get('content-type') || '';
        if (!upstream.ok) {
          const t = await upstream.text();
          send({ t: 'err', e: `AI 供應商回應 ${upstream.status}：${t.slice(0, 300)}` });
          break; // 設定類錯誤，重試也沒用
        } else if (ct.includes('text/event-stream')) {
          // rucloud 沒有 CPU 限制：逐事件即時串流（思考與內容都邊產生邊送）
          const reader = upstream.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          outer: for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
              const s = line.trim();
              if (!s.startsWith('data:')) continue;
              const data = s.slice(5).trim();
              if (data === '[DONE]') { complete = true; break outer; }
              try {
                const d = JSON.parse(data).choices?.[0]?.delta;
                if (typeof d?.content === 'string' && d.content) {
                  answer += d.content;
                  send({ t: 'c', x: d.content });
                } else if (typeof d?.reasoning_content === 'string' && d.reasoning_content) {
                  think += d.reasoning_content;
                  send({ t: 'r', x: d.reasoning_content });
                }
              } catch { /* 忽略缺損的行 */ }
            }
          }
        } else {
          const j = await upstream.json();
          if (j.base_resp?.status_code) {
            send({ t: 'err', e: `AI 供應商錯誤：${j.base_resp.status_msg || j.base_resp.status_code}` });
            break; // 設定類錯誤，重試也沒用
          } else {
            const c = j.choices?.[0]?.message?.content || '';
            if (c) { answer = c; send({ t: 'c', x: c }); complete = true; }
            else send({ t: 'err', e: 'AI 供應商沒有回傳內容。' });
          }
        }
        // 串流正常結束、或已經有可抽取的內容就不重試；斷流（NVIDIA 偶發）則重來
        if (complete || answer.trim() || attempt >= 3) break;
        send({ t: 'retry', n: attempt });
      }

        // 依模式抽取並存成新版本
        let version = null;
        let saved = 0;
        if (full) {
          const files = extractFiles(answer);
          if (files.length && !files.some((f) => f.path === 'public/index.html')) {
            send({ t: 'err', e: '模型沒有輸出 public/index.html，沒有存成新版本。' });
          } else if (files.length) {
            version = (latest?.version || 0) + 1;
            const total = files.reduce((s, f) => s + f.content.length, 0);
            if (total <= 800_000) {
              const now2 = new Date().toISOString();
              await db.batch([
                db.prepare('DELETE FROM version_files WHERE project_id = ? AND version = ?').bind(proj.id, version),
                ...files.map((f) => db.prepare(
                  'INSERT INTO version_files (project_id, version, path, content, created_at) VALUES (?, ?, ?, ?, ?)',
                ).bind(proj.id, version, f.path, f.content, now2)),
              ]);
              saved = total;
            } else {
              version = null;
              send({ t: 'err', e: '產生的專案超過 800KB，沒有存成新版本。' });
            }
          } else if (!answer.trim()) {
            send({ t: 'err', e: 'AI 沒有回傳內容，請再試一次。' });
          }
        } else {
          const html = extractHtml(answer);
          if (html) {
            version = (latest?.version || 0) + 1;
            if (html.length <= 400_000) {
              await db.prepare('INSERT INTO versions (project_id, version, html, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
                .bind(proj.id, version, html, html.length, new Date().toISOString()).run();
              saved = html.length;
            } else {
              version = null;
              send({ t: 'err', e: '產生的網頁超過 400KB，沒有存成新版本。' });
            }
          } else if (!answer.trim()) {
            send({ t: 'err', e: 'AI 沒有回傳內容，請再試一次。' });
          }
        }
        await db.prepare('INSERT INTO messages (project_id, role, content, reasoning, version, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(proj.id, 'assistant', answer, think, version, new Date().toISOString()).run();
        await db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(new Date().toISOString(), proj.id).run();
        send({ t: 'done', version, bytes: saved, mode: proj.mode });
      } catch (e) {
        send({ t: 'err', e: String(e?.message || e) });
      } finally {
        controller.close();
      }
    },
  }), {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  });
}

// ---------- 全端專案的執行環境 ----------

// 每個全端專案一個 SQLite Durable Object（名字 p<專案id>），當作它專屬的 D1
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

// env.ASSETS：從 version_files 回傳前端檔案
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

const html404 = (msg) => new Response(`<h1>${msg}</h1>`, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });

const genCache = new Map(); // "id:version" → { files, worker, dbStub }

// 載入產生的 src/worker.js（export default { fetch }，不可使用 import）
function loadGenWorker(code) {
  if (/^\s*import\s/m.test(code)) throw new Error('產生的 worker.js 使用了 import，無法在 app-builder 內執行。請請 AI 改成單檔、只用 export default。');
  const js = code.replace(/export\s+default\s*/, 'const __default =');
  return new Function(js + '\n;return typeof __default !== "undefined" ? __default : null;')();
}

async function serveGenerated(request, env, db, id, rest, search, v) {
  const proj = await db.prepare('SELECT id, mode, name FROM projects WHERE id = ?').bind(id).first();
  if (!proj) return html404('找不到這個 app');
  const ver = v || (await db.prepare('SELECT MAX(version) AS v FROM version_files WHERE project_id = ?').bind(id).first())?.v;
  if (!ver) return html404('這個專案還沒有產出任何版本');

  const key = id + ':' + ver;
  let entry = genCache.get(key);
  if (!entry) {
    const rows = (await db.prepare('SELECT path, content FROM version_files WHERE project_id = ? AND version = ?')
      .bind(id, ver).all()).results;
    const files = new Map(rows.map((r) => [r.path, r.content]));
    entry = { files, worker: null, note: '' };
    const code = files.get('src/worker.js');
    if (code) {
      try { entry.worker = loadGenWorker(code); }
      catch (e) { entry.note = String(e?.message || e); }
    }
    const schema = files.get('schema.sql');
    if (schema) await env.PROJECT_DB.getByName('p' + id).init({ schema });
    entry.dbStub = env.PROJECT_DB.getByName('p' + id);
    genCache.set(key, entry);
    if (genCache.size > 50) genCache.delete(genCache.keys().next().value);
  }

  const envForGen = { DB: makeD1(entry.dbStub), ASSETS: makeAssets(entry.files) };

  // API 路徑 → 交給產生的 worker
  if (entry.worker && (rest.startsWith('/api/') || rest === '/api')) {
    const u = new URL('https://generated.local' + rest + (search ? '?' + search : ''));
    const req2 = new Request(u, request);
    try {
      return await entry.worker.fetch(req2, envForGen, { waitUntil() {}, passThroughOnException() {} });
    } catch (e) {
      return json({ error: `產生的 app 執行錯誤：${e?.message || e}` }, 500);
    }
  }

  // 其他路徑 → 靜態檔案（找不到就回 index.html，SPA 友善）
  const p = decodeURIComponent(rest).replace(/^\/+/, '') || 'index.html';
  const keys = p === 'index.html' ? ['public/index.html'] : ['public/' + p, p];
  let content = null;
  for (const k of keys) if (entry.files.has(k)) { content = entry.files.get(k); break; }
  if (content == null) content = entry.files.get('public/index.html') ?? `<h1>Not found</h1><pre>${entry.note || ''}</pre>`;
  return new Response(content, { headers: { 'content-type': mimeOf(p === 'index.html' ? 'a.html' : p), 'cache-control': 'no-store' } });
}

// ---------- 靜態網站（公開） ----------

async function serveStaticApp(db, id, v) {
  const row = v
    ? await db.prepare('SELECT html FROM versions WHERE project_id = ? AND version = ?').bind(id, v).first()
    : await db.prepare('SELECT html FROM versions WHERE project_id = ? ORDER BY version DESC LIMIT 1').bind(id).first();
  if (!row) return html404('找不到這個 app');
  return new Response(row.html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

async function serveApp(request, env, db, id, rest, search, v) {
  const proj = await db.prepare('SELECT id, mode FROM projects WHERE id = ?').bind(id).first();
  if (!proj) return html404('找不到這個 app');
  if (proj.mode === 'full') {
    // 掛在 /apps/<id>/ 底下，前端才能用相對路徑呼叫自己的 API
    if ((rest === '' || rest === '/') && !new URL(request.url).pathname.endsWith('/')) {
      return Response.redirect(new URL(`/apps/${id}/${search ? '?' + search : ''}`, request.url), 307);
    }
    return serveGenerated(request, env, db, id, rest, search, v);
  }
  return serveStaticApp(db, id, v);
}

// ---------- ZIP 打包（deflate 可用就用，否則 store） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const crc32 = (data) => {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

async function deflateRaw(data) {
  if (typeof CompressionStream === 'undefined') return null;
  const out = await new Response(
    new Response(data).body.pipeThrough(new CompressionStream('deflate-raw')),
  ).arrayBuffer();
  return out.byteLength < data.length ? new Uint8Array(out) : null;
}

// files: [{ name, data: Uint8Array }] → 完整的 zip
async function makeZip(files) {
  const e = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = (((now.getFullYear() - 1980) & 0x7f) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const local = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = e.encode(f.name);
    const raw = f.data;
    const comp = (await deflateRaw(raw)) || raw;
    const method = comp === raw ? 0 : 8;
    const crc = crc32(raw);

    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    local.push(lh, comp);

    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, method, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    central.push(ch);
    offset += lh.length + comp.length;
  }
  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const c of [...local, ...central, end]) { all.set(c, p); p += c.length; }
  return all;
}

const READMD = (name) => `# ${name}

由 AppForge（rucloud examples/app-builder）的 AI 產生的網頁應用，整個程式都在 index.html 裡。

## 使用
直接用瀏覽器打開 index.html 即可。

## 部署到 Cloudflare
- **Workers（靜態資產）**：建立一個 wrangler 專案，把這個資料夾設為 assets 目錄後執行 wrangler deploy
- **Pages**：把這個資料夾直接拖上 Cloudflare Pages

## 部署到 rucloud
放到一個有 wrangler.jsonc 的專案資料夾（assets 指到這裡），執行 rucloud dev 資料夾名稱。
`;

const READMD_FULL = (name) => `# ${name}（Cloudflare Workers 全端專案）

由 AppForge（rucloud examples/app-builder）的 AI 產生的完整專案：Worker API + D1 資料庫 + 前端。

## 在 rucloud 執行
    rucloud dev 本資料夾 --d1-init DB=schema.sql

## 部署到 Cloudflare
    npm install -g wrangler（若尚未安裝）
    wrangler d1 create <資料庫名稱>   # 把 database_id 填進 wrangler.jsonc
    wrangler d1 execute <資料庫名稱> --file=schema.sql --remote
    wrangler deploy
`;

async function downloadZip(env, db, userId, projectId, v) {
  return handle(async () => {
    const proj = await requireProject(db, userId, projectId);
    const enc = new TextEncoder();
    const files = [];
    let version;
    if (proj.mode === 'full') {
      const ver = v || (await db.prepare('SELECT MAX(version) AS v FROM version_files WHERE project_id = ?').bind(proj.id).first())?.v;
      const rows = ver
        ? (await db.prepare('SELECT path, content FROM version_files WHERE project_id = ? AND version = ? ORDER BY path')
            .bind(proj.id, ver).all()).results
        : [];
      if (!rows.length) throw new HttpError(404, '還沒有任何版本');
      version = ver;
      const paths = new Set(rows.map((r) => r.path));
      if (!paths.has('wrangler.jsonc')) {
        rows.push({ path: 'wrangler.jsonc', content: wranglerFor(proj.name) });
      }
      for (const r of rows) {
        // 目錄結構照 path 原樣放進 zip
        files.push({ name: r.path, data: enc.encode(r.content) });
      }
      files.push({ name: 'README.md', data: enc.encode(READMD_FULL(proj.name)) });
    } else {
      const row = v
        ? await db.prepare('SELECT version, html FROM versions WHERE project_id = ? AND version = ?').bind(proj.id, v).first()
        : await db.prepare('SELECT version, html FROM versions WHERE project_id = ? ORDER BY version DESC LIMIT 1').bind(proj.id).first();
      if (!row) throw new HttpError(404, '還沒有任何版本');
      version = row.version;
      files.push({ name: 'index.html', data: enc.encode(row.html) });
      files.push({ name: 'README.md', data: enc.encode(READMD(proj.name)) });
    }
    const zip = await makeZip(files);
    const ascii = `app-${proj.id}-v${version}.zip`;
    return new Response(zip, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(`${proj.name}-v${version}.zip`)}`,
        'cache-control': 'no-store',
      },
    });
  });
}

// ---------- 路由 ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const db = env.DB;
    if (!db) return json({ error: '缺少 D1 綁定 DB' }, 500);
    await ensureSchema(db);

    let m;
    if ((m = p.match(/^\/apps\/(\d+)(\/.*)?$/))) {
      return serveApp(request, env, db, Number(m[1]), m[2] || '/', url.search, url.searchParams.get('v'));
    }

    if (p === '/api/register') return register(request, env, db);
    if (p === '/api/login') return login(request, env, db);
    if (p === '/api/logout') return json({ ok: true }, 200, { 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` });

    const userId = await currentUserId(request, env);
    if (!userId) return json({ error: '請先登入' }, 401);

    if (p === '/api/me') return handle(async () => json(await mePayload(db, env, userId)));
    if (p === '/api/settings' && request.method === 'PUT') return saveSettings(request, env, db, userId);
    if (p === '/api/projects' && request.method === 'GET') return listProjects(db, userId);
    if (p === '/api/projects' && request.method === 'POST') return createProject(request, db, userId);
    if ((m = p.match(/^\/api\/projects\/(\d+)$/))) {
      if (request.method === 'GET') return getProject(db, userId, Number(m[1]));
      if (request.method === 'DELETE') return deleteProject(db, userId, Number(m[1]));
    }
    if ((m = p.match(/^\/api\/projects\/(\d+)\/chat$/)) && request.method === 'POST') {
      return handle(() => chat(request, env, db, userId, Number(m[1])));
    }
    if ((m = p.match(/^\/api\/projects\/(\d+)\/versions\/(\d+)$/))) {
      return versionHtml(db, userId, Number(m[1]), Number(m[2]), url.searchParams.get('path'));
    }
    if ((m = p.match(/^\/api\/projects\/(\d+)\/download$/)) && request.method === 'GET') {
      return downloadZip(env, db, userId, Number(m[1]), url.searchParams.get('v'));
    }

    return env.ASSETS.fetch(request);
  },
};
