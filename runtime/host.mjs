// rucloud 的 Worker 執行環境（跑在 Node.js 裡，由 rucloud 啟動與監管）
//
//   * 載入應用的 main 模組（export default { fetch, queue, scheduled }）
//   * 建立 env：D1 / KV / R2 / Queues / Durable Objects / Vectorize / AI / 限流 / ASSETS / service，
//     全部是呼叫 rucloud（Rust）綁定 API 的薄包裝
//   * 在 127.0.0.1 的隨機埠聽 HTTP，啟動好後在 stdout 印 `RUCLOUD_READY <port>`
//
// 設定由環境變數 RUCLOUD_SPEC（JSON）傳進來。

import http from 'node:http';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const spec = JSON.parse(process.env.RUCLOUD_SPEC);
const B = spec.bindingsUrl;
const AUTH = { 'x-rucloud-token': spec.token };
const nativeFetch = globalThis.fetch;
const enc = encodeURIComponent;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') {
      return { url: new URL('./cloudflare-workers.mjs', import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

// ---------- 共用 ----------

async function rpc(url, body) {
  const res = await nativeFetch(url, {
    method: 'POST',
    headers: { ...AUTH, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson(res);
}

async function readJson(res) {
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* 不是 JSON */ }
  if (!res.ok) throw new Error(data.error || text || `rucloud 綁定錯誤 ${res.status}`);
  return data;
}

const toB64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');

function toBody(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || v instanceof ArrayBuffer || ArrayBuffer.isView(v) || v instanceof Blob || v instanceof ReadableStream) return v;
  return String(v);
}

// 結構化資料的序列化（Durable Object storage、RPC、Queue 的 v8 格式）：JSON 加上 Date/Map/Set/位元組
function ser(value) {
  return JSON.stringify(value, function (k, val) {
    const raw = this[k];
    if (raw === undefined) return { $t: 'undef' };
    if (raw instanceof Date) return { $t: 'Date', v: raw.getTime() };
    if (raw instanceof Map) return { $t: 'Map', v: [...raw] };
    if (raw instanceof Set) return { $t: 'Set', v: [...raw] };
    if (raw instanceof ArrayBuffer) return { $t: 'AB', v: toB64(new Uint8Array(raw)) };
    if (ArrayBuffer.isView(raw)) return { $t: 'U8', v: toB64(raw) };
    if (typeof raw === 'bigint') return { $t: 'BigInt', v: raw.toString() };
    return val;
  });
}

function deser(text) {
  if (text === undefined || text === null || text === '') return undefined;
  return JSON.parse(text, (k, v) => {
    if (!v || typeof v !== 'object' || typeof v.$t !== 'string') return v;
    switch (v.$t) {
      case 'undef': return undefined;
      case 'Date': return new Date(v.v);
      case 'Map': return new Map(v.v);
      case 'Set': return new Set(v.v);
      case 'AB': { const b = Buffer.from(v.v, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
      case 'U8': return new Uint8Array(Buffer.from(v.v, 'base64'));
      case 'BigInt': return BigInt(v.v);
      default: return v;
    }
  });
}

// ---------- D1 ----------

function encodeParam(v) {
  if (v === null) return null;
  if (v === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof ArrayBuffer) return { $blob: toB64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) return { $blob: toB64(v) };
  throw new Error(`D1_TYPE_ERROR: Type '${typeof v}' not supported for value '${v}'`);
}

const rowObject = (columns, row) => {
  const o = {};
  for (let i = 0; i < columns.length; i++) o[columns[i]] = row[i];
  return o;
};

class D1Database {
  constructor(binding) { this.base = `${B}/d1/${enc(binding)}`; }
  prepare(sql) { return new D1PreparedStatement(this, sql, []); }
  async _call(op, body) {
    try { return await rpc(`${this.base}/${op}`, body); } catch (e) { throw new Error(`D1_ERROR: ${e.message}`); }
  }
  async batch(statements) {
    const results = await this._call('batch', { statements: statements.map((s) => ({ sql: s.sql, params: s.params })) });
    return results.map((r) => ({ success: true, results: r.rows.map((row) => rowObject(r.columns, row)), meta: r.meta }));
  }
  async exec(sql) { return this._call('exec', { sql }); }
  withSession() {
    return { prepare: (sql) => this.prepare(sql), batch: (s) => this.batch(s), getBookmark: () => null };
  }
  async dump() { throw new Error('D1 dump 不支援，請直接複製 .rucloud 裡的 sqlite 檔'); }
}

class D1PreparedStatement {
  constructor(db, sql, params) { this.db = db; this.sql = sql; this.params = params; }
  bind(...values) { return new D1PreparedStatement(this.db, this.sql, values.map(encodeParam)); }
  _query() { return this.db._call('query', { sql: this.sql, params: this.params }); }
  async first(column) {
    const r = await this._query();
    const row = r.rows[0];
    if (!row) return null;
    if (column === undefined) return rowObject(r.columns, row);
    const i = r.columns.indexOf(column);
    if (i < 0) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[i];
  }
  async all() {
    const r = await this._query();
    return { success: true, results: r.rows.map((row) => rowObject(r.columns, row)), meta: r.meta };
  }
  run() { return this.all(); }
  async raw(options = {}) {
    const r = await this._query();
    return options.columnNames ? [r.columns, ...r.rows] : r.rows;
  }
}

// ---------- KV ----------

async function decodeValue(res, type) {
  switch (type) {
    case 'json': return JSON.parse(await res.text());
    case 'arrayBuffer': return res.arrayBuffer();
    case 'stream': return res.body;
    default: return res.text();
  }
}

class KVNamespace {
  constructor(binding) { this.base = `${B}/kv/${enc(binding)}`; }
  async _fetch(key) {
    const res = await nativeFetch(`${this.base}?key=${enc(key)}`, { headers: AUTH });
    if (res.status === 404) { await res.body?.cancel(); return null; }
    if (!res.ok) await readJson(res);
    return res;
  }
  async get(key, options) {
    if (Array.isArray(key)) {
      const out = new Map();
      await Promise.all(key.map(async (k) => out.set(k, await this.get(k, options))));
      return out;
    }
    const type = typeof options === 'string' ? options : options?.type || 'text';
    const res = await this._fetch(key);
    return res ? decodeValue(res, type) : null;
  }
  async getWithMetadata(key, options) {
    const type = typeof options === 'string' ? options : options?.type || 'text';
    const res = await this._fetch(key);
    if (!res) return { value: null, metadata: null, cacheStatus: null };
    const m = res.headers.get('x-kv-metadata');
    return { value: await decodeValue(res, type), metadata: m ? JSON.parse(decodeURIComponent(m)) : null, cacheStatus: null };
  }
  async put(key, value, options = {}) {
    const q = new URLSearchParams({ key: String(key) });
    if (options.expiration) q.set('expiration', String(Math.floor(options.expiration)));
    if (options.expirationTtl) q.set('expiration_ttl', String(Math.floor(options.expirationTtl)));
    if (options.metadata !== undefined) q.set('metadata', JSON.stringify(options.metadata));
    const res = await nativeFetch(`${this.base}?${q}`, { method: 'PUT', headers: AUTH, body: toBody(value), duplex: 'half' });
    if (!res.ok) await readJson(res);
  }
  async delete(key) {
    const res = await nativeFetch(`${this.base}?key=${enc(key)}`, { method: 'DELETE', headers: AUTH });
    if (!res.ok) await readJson(res);
  }
  async list(options = {}) {
    const q = new URLSearchParams();
    for (const k of ['prefix', 'limit', 'cursor']) if (options[k] != null) q.set(k, String(options[k]));
    return readJson(await nativeFetch(`${this.base}/list?${q}`, { headers: AUTH }));
  }
}

// ---------- R2 ----------

class R2Object {
  constructor(m) {
    Object.assign(this, m);
    this.uploaded = new Date(m.uploaded);
    this.checksums = { md5: Buffer.from(m.etag, 'hex') };
  }
  writeHttpMetadata(headers) {
    const h = this.httpMetadata || {};
    const map = { contentType: 'content-type', contentLanguage: 'content-language', contentDisposition: 'content-disposition', contentEncoding: 'content-encoding', cacheControl: 'cache-control' };
    for (const [k, name] of Object.entries(map)) if (h[k]) headers.set(name, h[k]);
    if (h.cacheExpiry) headers.set('expires', new Date(h.cacheExpiry).toUTCString());
  }
}

class R2ObjectBody extends R2Object {
  constructor(m, res, range) {
    super(m);
    this._res = res;
    this.body = res.body;
    if (range) this.range = range;
  }
  get bodyUsed() { return this._res.bodyUsed; }
  arrayBuffer() { return this._res.arrayBuffer(); }
  bytes() { return this._res.arrayBuffer().then((b) => new Uint8Array(b)); }
  text() { return this._res.text(); }
  json() { return this._res.json(); }
  blob() { return this._res.blob(); }
}

function httpMetadataOf(h) {
  if (!h) return {};
  if (!(h instanceof Headers)) return h;
  const out = {
    contentType: h.get('content-type'), contentLanguage: h.get('content-language'),
    contentDisposition: h.get('content-disposition'), contentEncoding: h.get('content-encoding'),
    cacheControl: h.get('cache-control'),
  };
  for (const k of Object.keys(out)) if (out[k] == null) delete out[k];
  return out;
}

class R2Bucket {
  constructor(binding) { this.base = `${B}/r2/${enc(binding)}`; }
  async head(key) {
    const res = await nativeFetch(`${this.base}/head?key=${enc(key)}`, { headers: AUTH });
    if (res.status === 404) return null;
    return new R2Object(await readJson(res));
  }
  async get(key, options = {}) {
    if (options.onlyIf) {
      const head = await this.head(key);
      if (!head) return null;
      const c = options.onlyIf;
      const strip = (s) => String(s).replace(/"/g, '');
      if ((c.etagMatches && strip(c.etagMatches) !== head.etag) || (c.etagDoesNotMatch && strip(c.etagDoesNotMatch) === head.etag)) return head;
    }
    const q = new URLSearchParams({ key });
    const r = options.range;
    if (r) for (const k of ['offset', 'length', 'suffix']) if (r[k] != null) q.set(k, String(r[k]));
    const res = await nativeFetch(`${this.base}/object?${q}`, { headers: AUTH });
    if (res.status === 404) { await res.body?.cancel(); return null; }
    if (!res.ok) await readJson(res);
    const meta = JSON.parse(decodeURIComponent(res.headers.get('x-r2-object')));
    const rr = res.headers.get('x-r2-range');
    const range = rr ? (([offset, length]) => ({ offset, length }))(rr.split(',').map(Number)) : undefined;
    return new R2ObjectBody(meta, res, range);
  }
  async put(key, value, options = {}) {
    const opts = encodeURIComponent(JSON.stringify({ httpMetadata: httpMetadataOf(options.httpMetadata), customMetadata: options.customMetadata || {} }));
    const res = await nativeFetch(`${this.base}/object?key=${enc(key)}`, {
      method: 'PUT', headers: { ...AUTH, 'x-r2-put': opts }, body: toBody(value), duplex: 'half',
    });
    return new R2Object(await readJson(res));
  }
  async delete(keys) {
    await rpc(`${this.base}/delete`, { keys: Array.isArray(keys) ? keys : [keys] }).catch((e) => { if (!/JSON/.test(e.message)) throw e; });
  }
  async list(options = {}) {
    const q = new URLSearchParams();
    for (const k of ['prefix', 'limit', 'cursor', 'delimiter']) if (options[k] != null) q.set(k, String(options[k]));
    const r = await readJson(await nativeFetch(`${this.base}/list?${q}`, { headers: AUTH }));
    return { ...r, objects: r.objects.map((o) => new R2Object(o)) };
  }
  createMultipartUpload() { throw new Error('rucloud 的 R2 尚未支援 multipart upload'); }
}

// ---------- Queues（producer） ----------

function encodeQueueBody(body, contentType) {
  switch (contentType) {
    case 'json': return JSON.stringify(body);
    case 'text': return String(body);
    case 'bytes': return toB64(body instanceof ArrayBuffer ? new Uint8Array(body) : body);
    default: return ser(body);
  }
}

function decodeQueueBody(text, contentType) {
  switch (contentType) {
    case 'json': return JSON.parse(text);
    case 'text': return text;
    case 'bytes': { const b = Buffer.from(text, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
    default: return deser(text);
  }
}

class Queue {
  constructor(queue) { this.url = `${B}/queue/${enc(queue)}/send`; }
  send(body, options = {}) { return this.sendBatch([{ body, ...options }]); }
  async sendBatch(messages, options = {}) {
    await rpc(this.url, {
      messages: [...messages].map((m) => {
        const contentType = m.contentType || 'v8';
        return { body: encodeQueueBody(m.body, contentType), contentType, delaySeconds: m.delaySeconds ?? options.delaySeconds ?? 0 };
      }),
    });
  }
}

// ---------- Durable Objects ----------

class DurableObjectId {
  constructor(hex, name) { this.hex = hex; if (name !== undefined) this.name = name; }
  toString() { return this.hex; }
  equals(other) { return !!other && String(other) === this.hex; }
}

class DurableObjectNamespace {
  constructor(binding) { this.binding = binding; }
  idFromName(name) {
    return new DurableObjectId(createHash('sha256').update(`${spec.app}:${this.binding}:${name}`).digest('hex'), name);
  }
  newUniqueId() { return new DurableObjectId(randomBytes(32).toString('hex')); }
  idFromString(hex) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new TypeError('Invalid Durable Object ID');
    return new DurableObjectId(hex.toLowerCase());
  }
  get(id) { return makeStub(this.binding, id); }
  getByName(name) { return this.get(this.idFromName(name)); }
  jurisdiction() { return this; }
}

function makeStub(binding, id) {
  const base = `${B}/do/${enc(binding)}/${id}`;
  const target = {
    id,
    name: id.name,
    async fetch(input, init) {
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set('x-rucloud-token', spec.token);
      headers.set('x-rucloud-do-url', req.url);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      return nativeFetch(`${base}/fetch`, { method: req.method, headers, body: hasBody ? req.body : undefined, duplex: 'half', redirect: 'manual' });
    },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return async (...args) => {
        const res = await nativeFetch(`${base}/rpc`, {
          method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: ser({ method: prop, args }),
        });
        const text = await res.text();
        let data;
        try { data = deser(text); } catch { throw new Error(text); }
        if (!res.ok || data?.$error) throw new Error(data?.$error || text);
        return data.result;
      };
    },
  });
}

class DurableObjectStorage {
  constructor(ns, id) {
    this.base = `${B}/do-storage/${enc(ns)}/${id}`;
    this.cache = new Map();  // 這個物件只活在這個程序，所以可以安全地快取
  }
  _op(body) { return rpc(this.base, body); }
  async get(key) {
    const keys = Array.isArray(key) ? key : [key];
    const miss = keys.filter((k) => !this.cache.has(k));
    if (miss.length) {
      const { values } = await this._op({ op: 'get', keys: miss });
      for (const k of miss) this.cache.set(k, k in values ? deser(values[k]) : undefined);
    }
    if (!Array.isArray(key)) { const v = this.cache.get(key); return v === undefined ? undefined : structuredClone(v); }
    const out = new Map();
    for (const k of keys) { const v = this.cache.get(k); if (v !== undefined) out.set(k, structuredClone(v)); }
    return out;
  }
  async put(key, value) {
    const entries = typeof key === 'string' ? { [key]: value } : key;
    const encoded = {};
    for (const [k, v] of Object.entries(entries)) {
      encoded[k] = ser(v);
      this.cache.set(k, structuredClone(v));
    }
    await this._op({ op: 'put', entries: encoded });
  }
  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) this.cache.set(k, undefined);
    const { deleted } = await this._op({ op: 'delete', keys });
    return Array.isArray(key) ? deleted : deleted > 0;
  }
  async deleteAll() { this.cache.clear(); await this._op({ op: 'deleteAll' }); }
  async list(options = {}) {
    const { entries } = await this._op({ op: 'list', ...options });
    return new Map(entries.map(([k, v]) => [k, deser(v)]));
  }
  async getAlarm() { return (await this._op({ op: 'getAlarm' })).at ?? null; }
  async setAlarm(time) { await this._op({ op: 'setAlarm', at: time instanceof Date ? time.getTime() : Number(time) }); }
  async deleteAlarm() { await this._op({ op: 'deleteAlarm' }); }
  async transaction(fn) { return fn(this); }
  transactionSync(fn) { return fn(); }
  async sync() {}
  get sql() { throw new Error('rucloud 尚未支援 SQLite 型 Durable Object 的 ctx.storage.sql'); }
}

class DurableObjectState {
  constructor(ns, id) {
    this.id = new DurableObjectId(id);
    this.storage = new DurableObjectStorage(ns, id);
    this._blockers = [];
  }
  blockConcurrencyWhile(fn) {
    const p = Promise.resolve().then(fn);
    this._blockers.push(p);
    return p;
  }
  waitUntil(p) { Promise.resolve(p).catch((e) => console.error('waitUntil:', e)); }
  acceptWebSocket() { throw new Error('rucloud 尚未支援 Durable Object 的 WebSocket'); }
  getWebSockets() { return []; }
}

const doInstances = new Map();

function getInstance(ns, id) {
  const key = `${ns}:${id}`;
  let inst = doInstances.get(key);
  if (!inst) {
    const def = spec.durableObjects.find((d) => d.binding === ns);
    const Cls = def && workerModule[def.className];
    if (typeof Cls !== 'function') throw new Error(`Durable Object 類別 ${def?.className ?? ns} 沒有從 main 模組 export`);
    const state = new DurableObjectState(ns, id);
    inst = { state, obj: new Cls(state, env) };
    // 建構子裡 blockConcurrencyWhile 的工作做完之前，事件都要排隊
    inst.chain = Promise.all(state._blockers).catch((e) => console.error(e));
    doInstances.set(key, inst);
  }
  return inst;
}

// 同一個物件的事件一次處理一個（近似 Cloudflare 的 input gate，避免讀-改-寫被插隊）
function serial(inst, fn) {
  const p = inst.chain.then(fn);
  inst.chain = p.catch(() => {});
  return p;
}

// ---------- 其他綁定 ----------

class VectorizeIndex {
  constructor(binding) { this.base = `${B}/vectorize/${enc(binding)}`; }
  _op(op, body) { return rpc(`${this.base}/${op}`, body); }
  _vecs(vs) { return vs.map((v) => ({ ...v, values: Array.from(v.values) })); }
  insert(vectors) { return this._op('insert', { vectors: this._vecs(vectors) }); }
  upsert(vectors) { return this._op('upsert', { vectors: this._vecs(vectors) }); }
  query(vector, options = {}) { return this._op('query', { vector: Array.from(vector), options }); }
  getByIds(ids) { return this._op('getByIds', { ids }); }
  deleteByIds(ids) { return this._op('deleteByIds', { ids }); }
  describe() { return this._op('describe', {}); }
}

function makeAi() {
  return {
    run: (model, inputs) => rpc(`${B}/ai/run`, { model, inputs }),
    gateway() { throw new Error('請改用 rucloud 的 AI Gateway 端點（rucloud ai-gateway）'); },
  };
}

function makeRateLimiter(binding) {
  return { limit: ({ key } = {}) => rpc(`${B}/ratelimit/${enc(binding)}`, { key: String(key ?? '') }) };
}

function makeService(binding) {
  return {
    async fetch(input, init) {
      const req = new Request(input, init);
      const headers = new Headers(req.headers);
      headers.set('x-rucloud-token', spec.token);
      headers.set('x-rucloud-svc-url', req.url);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      return nativeFetch(`${B}/service/${enc(binding)}`, { method: req.method, headers, body: hasBody ? req.body : undefined, duplex: 'half', redirect: 'manual' });
    },
    connect() { throw new Error('rucloud 不支援 service binding 的 connect()'); },
  };
}

function makeAssets() {
  return {
    fetch(input, init) {
      const req = new Request(input, init);
      const { pathname } = new URL(req.url);
      const headers = { ...AUTH };
      for (const h of ['if-none-match', 'accept', 'sec-fetch-mode']) { const v = req.headers.get(h); if (v) headers[h] = v; }
      return nativeFetch(`${B}/assets?path=${enc(pathname)}`, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers });
    },
  };
}

function buildEnv() {
  const env = { ...spec.vars };
  for (const b of spec.d1) env[b] = new D1Database(b);
  for (const b of spec.kv) env[b] = new KVNamespace(b);
  for (const b of spec.r2) env[b] = new R2Bucket(b);
  for (const q of spec.queues) env[q.binding] = new Queue(q.queue);
  for (const d of spec.durableObjects) env[d.binding] = new DurableObjectNamespace(d.binding);
  for (const b of spec.vectorize) env[b] = new VectorizeIndex(b);
  for (const b of spec.ratelimits) env[b] = makeRateLimiter(b);
  for (const b of spec.services) env[b] = makeService(b);
  if (spec.ai) env[spec.ai] = makeAi();
  if (spec.assets) env[spec.assets] = makeAssets();
  return env;
}

// ---------- 全域：Cache API、scheduler、Service Worker 語法 ----------

class MemoryCache {
  #m = new Map();
  #key(req) { return typeof req === 'string' ? req : req.url; }
  async match(req) {
    const e = this.#m.get(this.#key(req));
    if (!e) return undefined;
    if (e.exp < Date.now()) { this.#m.delete(this.#key(req)); return undefined; }
    return new Response(e.body, { status: e.status, headers: e.headers });
  }
  async put(req, res) {
    const cc = res.headers.get('cache-control') || '';
    const m = /s-maxage=(\d+)/.exec(cc) || /max-age=(\d+)/.exec(cc);
    if (!m || /no-store|private/.test(cc) || res.status === 206) return;
    this.#m.set(this.#key(req), { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers], exp: Date.now() + Number(m[1]) * 1000 });
  }
  async delete(req) { return this.#m.delete(this.#key(req)); }
}
const namedCaches = new Map();
globalThis.caches = {
  default: new MemoryCache(),
  async open(name) { if (!namedCaches.has(name)) namedCaches.set(name, new MemoryCache()); return namedCaches.get(name); },
};
globalThis.scheduler ??= { wait: (ms) => new Promise((r) => setTimeout(r, ms)) };

const listeners = { fetch: [], scheduled: [], queue: [] };
globalThis.addEventListener = (type, fn) => listeners[type]?.push(fn);

// ---------- 載入 Worker ----------

const env = buildEnv();
globalThis.__rucloud = { env, waitUntil: (p) => Promise.resolve(p).catch((e) => console.error('waitUntil:', e)) };

let workerModule;
try {
  workerModule = await import(pathToFileURL(spec.main).href);
} catch (e) {
  console.error(`載入 ${spec.main} 失敗：`, e);
  process.exit(1);
}

function makeCtx() {
  const pending = [];
  return {
    waitUntil(p) { pending.push(Promise.resolve(p).catch((e) => console.error('waitUntil:', e))); },
    passThroughOnException() {},
    props: {},
    _drain() { return Promise.all(pending); },
  };
}

const entry = workerModule.default;

// 依 handler 名稱呼叫：支援 export default { fetch }、WorkerEntrypoint 類別、addEventListener
function handler(name) {
  if (typeof entry === 'function' && entry.prototype && typeof entry.prototype[name] === 'function') {
    return (arg, ctx) => new entry(ctx, env)[name](arg);
  }
  if (entry && typeof entry[name] === 'function') return (arg, ctx) => entry[name](arg, env, ctx);
  if (listeners[name]?.length) {
    Object.assign(globalThis, env);
    return (arg, ctx) => new Promise((resolve, reject) => {
      let responded = false;
      const event = {
        type: name, request: arg, ...(name === 'scheduled' ? arg : {}),
        respondWith(p) { responded = true; Promise.resolve(p).then(resolve, reject); },
        waitUntil: ctx.waitUntil, passThroughOnException() {},
      };
      try { for (const fn of listeners[name]) fn(event); } catch (e) { reject(e); }
      if (!responded) resolve(undefined);
    });
  }
  return null;
}

// ---------- HTTP ----------

const CF = { colo: 'LOCAL', country: 'XX', city: 'Local', httpProtocol: 'HTTP/1.1', asn: 0, clientTcpRtt: 0, tlsVersion: '' };

function toRequest(req, urlOverride) {
  const url = urlOverride || req.headers['x-rucloud-url'] || `http://localhost${req.url}`;
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i < raw.length; i += 2) {
    if (/^(x-rucloud-|host$|connection$|keep-alive$|transfer-encoding$)/i.test(raw[i])) continue;
    headers.append(raw[i], raw[i + 1]);
  }
  try { headers.set('host', new URL(url).host); } catch { /* 網址不對就算了 */ }
  const init = { method: req.method, headers, redirect: 'manual' };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  const request = new Request(url, init);
  Object.defineProperty(request, 'cf', { value: { ...CF }, enumerable: false });
  return request;
}

async function writeResponse(res, response, method) {
  const headers = {};
  response.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, response.statusText || undefined, headers);
  if (!response.body || method === 'HEAD') { res.end(); return; }
  const reader = response.body.getReader();
  let closed = false;
  res.on('close', () => { closed = true; reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      if (!res.write(value)) await new Promise((r) => { res.once('drain', r); res.once('close', r); });
    }
  } catch (e) {
    if (!closed) console.error('回應串流中斷：', e?.message || e);
  }
  res.end();
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const fetchHandler = handler('fetch');

async function handleFetch(req, res) {
  const request = toRequest(req);
  const ctx = makeCtx();
  let response;
  try {
    if (!fetchHandler) throw new Error('Worker 沒有 fetch() handler');
    response = await fetchHandler(request, ctx);
    if (!response || typeof response.status !== 'number') throw new Error('fetch() 沒有回傳 Response');
  } catch (e) {
    console.error(e?.stack || e);
    response = new Response(`Worker threw exception:\n${e?.stack || e}\n`, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  ctx._drain();
  await writeResponse(res, response, req.method);
}

async function handleInternal(kind, req, res) {
  if (req.headers['x-rucloud-token'] !== spec.token) return sendJson(res, 403, { error: 'forbidden' });
  try {
    if (kind === 'queue') {
      const payload = JSON.parse(await readBody(req));
      const outcomes = new Map();
      let all = null;
      const messages = payload.messages.map((m) => ({
        id: m.id, timestamp: new Date(m.timestamp), attempts: m.attempts,
        body: decodeQueueBody(m.body, m.contentType),
        ack() { outcomes.set(m.id, { action: 'ack' }); },
        retry(o = {}) { outcomes.set(m.id, { action: 'retry', delaySeconds: o.delaySeconds }); },
      }));
      const batch = {
        queue: payload.queue, messages,
        ackAll() { all = { action: 'ack' }; },
        retryAll(o = {}) { all = { action: 'retry', delaySeconds: o.delaySeconds }; },
      };
      const h = handler('queue');
      if (!h) throw new Error('Worker 沒有 queue() handler');
      const ctx = makeCtx();
      let ok = true;
      try { await h(batch, ctx); } catch (e) { ok = false; console.error('queue() 失敗：', e?.stack || e); }
      await ctx._drain();
      const results = payload.messages.map((m) => ({ id: m.id, ...(outcomes.get(m.id) || all || { action: ok ? 'ack' : 'retry' }) }));
      return sendJson(res, 200, { results });
    }
    if (kind === 'scheduled') {
      const p = JSON.parse(await readBody(req));
      const h = handler('scheduled');
      if (!h) throw new Error('Worker 沒有 scheduled() handler');
      const ctx = makeCtx();
      await h({ type: 'scheduled', cron: p.cron, scheduledTime: p.scheduledTime, noRetry() {} }, ctx);
      await ctx._drain();
      return sendJson(res, 200, { ok: true });
    }
    const ns = req.headers['x-rucloud-do-ns'];
    const id = req.headers['x-rucloud-do-id'];
    if (kind === 'alarm') {
      await readBody(req);
      const inst = getInstance(ns, id);
      if (typeof inst.obj.alarm !== 'function') throw new Error('Durable Object 沒有 alarm()');
      await serial(inst, () => inst.obj.alarm({ retryCount: 0, isRetry: false }));
      return sendJson(res, 200, { ok: true });
    }
    if (kind === 'do') {
      const inst = getInstance(ns, id);
      if (req.headers['x-rucloud-do-op'] === 'rpc') {
        const { method, args } = deser(await readBody(req));
        try {
          const fn = inst.obj[method];
          if (typeof fn !== 'function') throw new Error(`Durable Object 沒有方法 ${method}()`);
          const result = await serial(inst, () => fn.apply(inst.obj, args));
          return sendJson(res, 200, ser({ result }));
        } catch (e) {
          return sendJson(res, 500, ser({ $error: String(e?.message || e) }));
        }
      }
      const request = toRequest(req, req.headers['x-rucloud-do-url']);
      let response;
      try {
        if (typeof inst.obj.fetch !== 'function') throw new Error('Durable Object 沒有 fetch()');
        response = await serial(inst, () => inst.obj.fetch(request));
      } catch (e) {
        console.error(e?.stack || e);
        response = new Response(`Durable Object threw exception:\n${e?.stack || e}\n`, { status: 500 });
      }
      return writeResponse(res, response, req.method);
    }
    sendJson(res, 404, { error: `unknown kind ${kind}` });
  } catch (e) {
    console.error(e?.stack || e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e?.message || e) });
  }
}

const server = http.createServer({ keepAliveTimeout: 65_000, requestTimeout: 0 }, (req, res) => {
  const kind = req.headers['x-rucloud-kind'];
  (kind ? handleInternal(kind, req, res) : handleFetch(req, res)).catch((e) => {
    console.error(e?.stack || e);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch { /* 連線已斷 */ }
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`RUCLOUD_READY ${server.address().port}\n`);
});

// rucloud 結束時 stdin 會關閉，跟著結束
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
