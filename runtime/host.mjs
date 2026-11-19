// rucloud 的 Worker 執行環境（跑在 Node.js 裡，由 rucloud 啟動與監管）
//
//   * 載入應用的 main 模組（export default { fetch, queue, scheduled }）
//   * 建立 env：D1 / KV / R2 / Queues / Durable Objects / Vectorize / Images / AI / 限流 / ASSETS / service，
//     全部是呼叫 rucloud（Rust）綁定 API 的薄包裝
//   * 在 127.0.0.1 的隨機埠聽 HTTP，啟動好後在 stdout 印 `RUCLOUD_READY <port>`
//
// 設定由環境變數 RUCLOUD_SPEC（JSON）傳進來。

import http from 'node:http';
import net from 'node:net';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HTMLRewriter } from './html-rewriter.mjs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

const spec = JSON.parse(process.env.RUCLOUD_SPEC);
// token 只留在這個模組裡，Worker 程式碼從 process.env 拿不到
delete process.env.RUCLOUD_SPEC;
delete process.env.RUCLOUD_INSTANCE;
const SOCKET = process.env.RUCLOUD_SOCKET;
delete process.env.RUCLOUD_SOCKET;
// 綁定 API 在 rucloud 的 Unix socket 上。fetch 連不了 Unix socket，所以在程序裡開一個本機的轉送：
// 連到它的連線原樣接到 bindings.sock（之後 Worker 在自己的 network namespace 裡時，這個埠只有自己連得到）
const bindingsForwarder = net.createServer((c) => {
  const up = net.connect(spec.bindingsSocket);
  c.on('error', () => up.destroy());
  up.on('error', () => c.destroy());
  c.pipe(up).pipe(c);
});
// 籠子裡用固定的 3129（NO_PROXY 只放這個埠，其他本機位址都經過出口代理）
await new Promise((resolve) => bindingsForwarder.listen(spec.caged ? 3129 : 0, '127.0.0.1', resolve));
const B = `http://127.0.0.1:${bindingsForwarder.address().port}${spec.bindingsPath}`;
// 作業系統層級的籠子（[isolation]）裡沒有網路，只有這個程序池的資料夾：連外的 fetch 經過
// HTTP(S)_PROXY=http://127.0.0.1:3128（rucloud 設好的）接到 rucloud 的出口代理（egress.sock）
if (spec.egress) {
  const egress = net.createServer((c) => {
    const up = net.connect(`${dirname(SOCKET)}/egress.sock`);
    c.on('error', () => up.destroy());
    up.on('error', () => c.destroy());
    c.pipe(up).pipe(c);
  });
  await new Promise((resolve) => egress.listen(3128, '127.0.0.1', resolve));
}
const AUTH = { 'x-rucloud-token': spec.token };
const nativeFetch = globalThis.fetch;
const enc = encodeURIComponent;

// 安裝的應用（[install]）：沒有「網路」權限時 Worker 的程式碼不能連到外部；有的話只能連網際網路上的位址
//（本機、區網、連結本地位址都擋下，免得繞過權限直接呼叫這台機器上的其他應用）。
// cloudflare:sockets 與 Node 的網路模組不開放；rucloud 自己的綁定不受影響
const INSTALLED = spec.installed === true;
const NO_NETWORK = INSTALLED && spec.network === false;
const NO_NETWORK_MSG = '這個應用沒有連線到外部網路的權限';
const NET_MODULES = /^(node:)?(net|tls|http|https|http2|dgram|dns|dns\/promises|undici)$/;
const RUNTIME_DIR = new URL('./', import.meta.url).href;

// 網際網路上的位址（不是本機、私有網路、CGNAT、連結本地、多播、保留的）
function isPublicAddress(addr) {
  if (isIP(addr) === 4) {
    const [a, b] = addr.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  const v6 = addr.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPublicAddress(mapped[1]);
  return !(v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6));
}

async function checkPublic(url) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new TypeError(`${host}：安裝的應用只能連到網際網路上的位址`);
  // 籠子裡查不到 DNS：網域名稱交給出口代理在籠子外面查、檢查
  if (spec.caged && !isIP(host)) return;
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (!isPublicAddress(address)) throw new TypeError(`${host}（${address}）：安裝的應用只能連到網際網路上的位址`);
  }
}

// 模組規則（和 wrangler 的 rules 相同）：import 非 JS 檔時的處理方式
const DEFAULT_RULES = [
  { type: 'Text', globs: ['**/*.txt', '**/*.html', '**/*.sql'] },
  { type: 'Data', globs: ['**/*.bin'] },
  { type: 'CompiledWasm', globs: ['**/*.wasm', '**/*.wasm?module'] },
];
const RULES = [...(spec.rules || []), ...DEFAULT_RULES].map((r) => ({
  type: r.type,
  res: r.globs.map((g) => g.replace(/\?module$/, '')).map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '.').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*')}$`)),
}));

function moduleRule(url) {
  const path = fileURLToPath(url);
  const rel = relative(process.cwd(), path).split(sep).join('/');
  return RULES.find((r) => r.res.some((re) => re.test(rel)))?.type;
}

const RELATIVE = /^(\.{1,2}\/|\/|file:)/;
const EXTENSIONS = ['.ts', '.js', '.mjs', '.mts', '.tsx', '.jsx', '/index.ts', '/index.js', '/index.mjs'];

registerHooks({
  resolve(specifier, context, next) {
    if (INSTALLED && !(context.parentURL || '').startsWith(RUNTIME_DIR)) {
      const why = NO_NETWORK ? NO_NETWORK_MSG : '安裝的應用請用 fetch 或 WebSocket 連線';
      if (specifier === 'cloudflare:sockets') {
        const source = `export function connect() { throw new TypeError(${JSON.stringify(why)}); }`;
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      }
      if (NET_MODULES.test(specifier)) throw new Error(`${specifier}：${why}`);
    }
    if (specifier === 'cloudflare:workers' || specifier === 'cloudflare:workflows') {
      return { url: new URL('./cloudflare-workers.mjs', import.meta.url).href, shortCircuit: true };
    }
    if (specifier === 'cloudflare:sockets') {
      return { url: new URL('./cloudflare-sockets.mjs', import.meta.url).href, shortCircuit: true };
    }
    if (specifier === 'cloudflare:email') {
      return { url: new URL('./cloudflare-email.mjs', import.meta.url).href, shortCircuit: true };
    }
    try {
      return next(specifier, context);
    } catch (e) {
      // 打包工具允許省略副檔名（import './util'），Node 不允許：依序試常見的副檔名
      if (RELATIVE.test(specifier) && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'ERR_UNSUPPORTED_DIR_IMPORT')) {
        for (const ext of EXTENSIONS) {
          try { return next(specifier.replace(/\/$/, '') + ext, context); } catch { /* 試下一個 */ }
        }
      }
      throw e;
    }
  },
  load(url, context, next) {
    if (url.startsWith('file:')) {
      const type = moduleRule(url);
      const path = fileURLToPath(url);
      const b64 = () => JSON.stringify(readFileSync(path).toString('base64'));
      if (type === 'Text') return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(readFileSync(path, 'utf8'))};` };
      if (type === 'Data') {
        return { format: 'module', shortCircuit: true, source: `const b = Buffer.from(${b64()}, 'base64'); export default b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);` };
      }
      if (type === 'CompiledWasm') return { format: 'module', shortCircuit: true, source: `export default new WebAssembly.Module(Buffer.from(${b64()}, 'base64'));` };
      // 打包工具允許不加 with { type: 'json' } 就 import JSON
      if (path.endsWith('.json') && !context.importAttributes?.type) {
        return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(path, 'utf8')};` };
      }
    }
    return next(url, context);
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

// ---------- WebSocket ----------
//
// Cloudflare 的寫法：const [client, server] = Object.values(new WebSocketPair());
//   server.accept(); server.addEventListener('message', ...);
//   return new Response(null, { status: 101, webSocket: client });
// client 端在這裡接上真正的連線（rucloud 自己實作 WebSocket 訊框），server 端給 Worker 用。

// Node 的 Response 不接受 status 101，包一層讓它可以帶 webSocket
const NativeResponse = globalThis.Response;
class Response extends NativeResponse {
  constructor(body, init) {
    if (init && init.status === 101) {
      super(null, { ...init, status: 200 });
      Object.defineProperty(this, '_switching', { value: true });
      Object.defineProperty(this, '_webSocket', { value: init.webSocket ?? null });
    } else {
      super(body, init);
    }
  }
  get status() { return this._switching ? 101 : super.status; }
  get ok() { return this._switching ? false : super.ok; }
  get webSocket() { return this._webSocket ?? null; }
  static [Symbol.hasInstance](x) { return x instanceof NativeResponse; }
}
globalThis.Response = Response;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_MESSAGE = 32 * 1024 * 1024;

class CfWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor() {
    super();
    this.readyState = 1;
    this.url = null;
    this.protocol = '';
    this.extensions = '';
    this._peer = null;
    this._transport = null;   // 只有接上真實連線的那一端有
    this._accepted = false;
    this._queue = [];
    this._hib = null;          // Durable Object 的 hibernation：{ inst, tags }
    this._attachment = undefined;
  }
  accept() {
    if (this._accepted) return;
    this._accepted = true;
    for (const [type, props] of this._queue.splice(0)) this._dispatch(type, props);
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('WebSocket 已經關閉');
    const peer = this._peer;
    if (peer._transport) peer._transport.send(data);
    else if (peer._isClient) peer._outbox.push(data);  // 101 還沒送出：先存著，接上連線再送
    else peer._dispatch('message', { data });
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const peer = this._peer;
    if (peer._transport) peer._transport.close(code, reason);
    else if (peer._isClient) peer._outbox.push({ close: [code, reason] });
    else { peer._dispatch('close', { code, reason, wasClean: true }); this._closed(code, reason, true); }
  }
  serializeAttachment(v) { this._attachment = structuredClone(v); }
  deserializeAttachment() { return structuredClone(this._attachment); }
  _closed(code, reason, wasClean) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this._dispatch('close', { code, reason, wasClean });
  }
  _dispatch(type, props) {
    if (!this._accepted) { this._queue.push([type, props]); return; }
    if (this._hib) { hibernationEvent(this, type, props); return; }
    const ev = new Event(type);
    Object.assign(ev, props);
    this.dispatchEvent(ev);
    try { this[`on${type}`]?.(ev); } catch (e) { console.error(e); }
  }
}

// 正在處理哪個 Durable Object 的事件（在 DO 裡建立的 WebSocket 會讓物件不被逐出）
const doContext = new AsyncLocalStorage();

globalThis.WebSocketPair = function WebSocketPair() {
  const client = new CfWebSocket();
  const server = new CfWebSocket();
  const owner = doContext.getStore();
  if (owner) {
    owner.openSockets.add(server);
    server.addEventListener('close', () => owner.openSockets.delete(server));
  }
  client._peer = server;
  server._peer = client;
  client._accepted = true;
  client._isClient = true;
  client._outbox = [];
  return { 0: client, 1: server };
};

globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) { this.request = request; this.response = response; }
};

// Durable Object 的 hibernation handler：webSocketMessage / webSocketClose / webSocketError
function hibernationEvent(ws, type, props) {
  const { inst } = ws._hib;
  const obj = inst.obj;
  if (type === 'message') {
    const auto = inst.state._autoResponse;
    if (auto && props.data === auto.request) { ws.send(auto.response); return; }
    serial(inst, () => obj.webSocketMessage?.(ws, props.data)).catch((e) => console.error('webSocketMessage：', e));
  } else if (type === 'close') {
    inst.state._sockets.delete(ws);
    serial(inst, () => obj.webSocketClose?.(ws, props.code, props.reason, props.wasClean)).catch((e) => console.error('webSocketClose：', e));
  } else if (type === 'error') {
    serial(inst, () => obj.webSocketError?.(ws, props.error)).catch((e) => console.error('webSocketError：', e));
  }
}

// 在一條已經完成 handshake 的連線上收發 WebSocket 訊框（伺服器端：送出不加遮罩）
function wsTransport(socket, head, client) {
  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let frags = [];
  let fragOp = 0;
  let closeSent = false;
  let done = false;
  const server = client._peer;
  socket.setNoDelay(true);

  const frame = (op, payload) => {
    const len = payload.length;
    let hdr;
    if (len < 126) hdr = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
    if (!socket.destroyed) socket.write(Buffer.concat([hdr, payload]));
  };
  const finish = (code, reason, wasClean) => {
    if (done) return;
    done = true;
    server._closed(code, reason, wasClean);
    client.readyState = 3;
  };
  const transport = {
    send(data) {
      if (closeSent) return;
      if (typeof data === 'string') frame(0x1, Buffer.from(data, 'utf8'));
      else if (data instanceof ArrayBuffer) frame(0x2, Buffer.from(data));
      else if (ArrayBuffer.isView(data)) frame(0x2, Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      else frame(0x1, Buffer.from(String(data), 'utf8'));
    },
    close(code = 1000, reason = '') {
      if (closeSent) return;
      closeSent = true;
      const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
      const p = Buffer.alloc(2 + r.length);
      p.writeUInt16BE(code, 0);
      r.copy(p, 2);
      frame(0x8, p);
      setTimeout(() => socket.destroy(), 5000).unref();
    },
  };
  client._transport = transport;
  for (const m of client._outbox.splice(0)) {
    if (m && m.close) transport.close(...m.close);
    else transport.send(m);
  }

  const deliver = (op, payload) => {
    const data = op === 0x1 ? payload.toString('utf8') : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
    server._dispatch('message', { data });
  };
  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_WS_MESSAGE) { transport.close(1009, 'message too big'); socket.destroy(); return; }
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(off + len);
      if (op === 0x0) {
        frags.push(payload);
        if (fin) { deliver(fragOp, Buffer.concat(frags)); frags = []; }
      } else if (op === 0x1 || op === 0x2) {
        if (fin) deliver(op, payload);
        else { fragOp = op; frags = [payload]; }
      } else if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!closeSent) transport.close(code === 1005 ? 1000 : code, reason);
        finish(code, reason, true);
        socket.end();
        return;
      } else if (op === 0x9) {
        frame(0xA, payload);
      }
    }
  });
  socket.on('error', (e) => { if (!done) server._dispatch('error', { error: e, message: e.message }); });
  socket.on('close', () => finish(1006, '', false));
  // 對方沒送 close 訊框就斷了（程序結束、網路斷掉）：只會收到 FIN。HTTP 伺服器的連線允許半關閉，
  // 不會自己觸發 close，所以要在這裡結束，否則 Durable Object 永遠不知道這個人離開了
  socket.on('end', () => { finish(1006, '', false); socket.destroy(); });
}

// 本機 Worker 回了 101 + webSocket：完成 handshake，接上訊框處理
function acceptLocalWebSocket(req, socket, head, response) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n'); return; }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  let out = `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n`;
  response.headers.forEach((v, k) => {
    if (!/^(upgrade|connection|sec-websocket-accept|content-length|content-type)$/i.test(k)) out += `${k}: ${v}\r\n`;
  });
  socket.write(`${out}\r\n`);
  wsTransport(socket, head, response.webSocket);
}

// 回應來自另一個程序（Durable Object、service binding）：兩條連線的位元組直接對接
function spliceTunnel(socket, head, tunnel) {
  let out = 'HTTP/1.1 101 Switching Protocols\r\n';
  tunnel.headers.forEach((v, k) => { out += `${k}: ${v}\r\n`; });
  socket.write(`${out}\r\n`);
  if (tunnel.rest.length) socket.write(tunnel.rest);
  if (head?.length) tunnel.socket.write(head);
  socket.setNoDelay(true);
  tunnel.socket.setNoDelay(true);
  socket.pipe(tunnel.socket).pipe(socket);
  const kill = () => { socket.destroy(); tunnel.socket.destroy(); };
  // end：其中一邊只送了 FIN（沒有 close 訊框就斷線），另一邊也要跟著關，斷線才傳得到 Durable Object
  socket.on('error', kill).on('close', kill).on('end', kill);
  tunnel.socket.on('error', kill).on('close', kill).on('end', kill);
}

const isUpgrade = (req) => (req.headers.get('upgrade') || '').toLowerCase() === 'websocket';

// 對 rucloud 的綁定 API 送一個 upgrade 請求（給 DO stub.fetch、service binding 用）
function upgradeVia(path, req, extra) {
  const { hostname, port } = new URL(B);
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(port), hostname);
    sock.once('error', reject);
    sock.once('connect', () => {
      let head = `GET ${path} HTTP/1.1\r\nhost: ${hostname}:${port}\r\nx-rucloud-token: ${spec.token}\r\n`;
      req.headers.forEach((v, k) => { if (!/^(host|x-rucloud-)/i.test(k)) head += `${k}: ${v}\r\n`; });
      for (const [k, v] of Object.entries(extra)) head += `${k}: ${v}\r\n`;
      sock.write(`${head}\r\n`);
    });
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      sock.off('data', onData);
      sock.off('error', reject);
      const lines = buf.subarray(0, i).toString('latin1').split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const headers = new Headers();
      for (const l of lines.slice(1)) {
        const j = l.indexOf(':');
        if (j > 0) headers.append(l.slice(0, j).trim(), l.slice(j + 1).trim());
      }
      const rest = buf.subarray(i + 4);
      if (status === 101) {
        sock.pause();
        const r = new Response(null, { status: 101, headers });
        Object.defineProperty(r, '_tunnel', { value: { socket: sock, headers, rest } });
        resolve(r);
        return;
      }
      const want = Number(headers.get('content-length') ?? -1);
      const chunks = [rest];
      let got = rest.length;
      const fin = () => { sock.destroy(); resolve(new Response(Buffer.concat(chunks), { status, headers })); };
      if (want >= 0 && got >= want) return fin();
      sock.on('data', (c) => { chunks.push(c); got += c.length; if (want >= 0 && got >= want) fin(); });
      sock.on('end', fin);
    };
    sock.on('data', onData);
  });
}

// 本機寫出一般（非 101）回應後關閉連線
async function writeRawResponse(socket, response) {
  const body = Buffer.from(await response.arrayBuffer());
  let out = `HTTP/1.1 ${response.status} ${response.statusText || 'Error'}\r\n`;
  response.headers.forEach((v, k) => { if (!/^(content-length|transfer-encoding|connection)$/i.test(k)) out += `${k}: ${v}\r\n`; });
  out += `content-length: ${body.length}\r\nconnection: close\r\n\r\n`;
  socket.end(Buffer.concat([Buffer.from(out, 'latin1'), body]));
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
  async createMultipartUpload(key, options = {}) {
    const { uploadId } = await rpc(`${this.base}/mpu/create`, {
      key, httpMetadata: httpMetadataOf(options.httpMetadata), customMetadata: options.customMetadata || {},
    });
    return new R2MultipartUpload(this.base, key, uploadId);
  }
  resumeMultipartUpload(key, uploadId) { return new R2MultipartUpload(this.base, key, uploadId); }
}

class R2MultipartUpload {
  constructor(base, key, uploadId) { this._base = base; this.key = key; this.uploadId = uploadId; }
  async uploadPart(partNumber, value) {
    const q = new URLSearchParams({ uploadId: this.uploadId, partNumber: String(partNumber) });
    const res = await nativeFetch(`${this._base}/mpu/part?${q}`, { method: 'PUT', headers: AUTH, body: toBody(value), duplex: 'half' });
    return readJson(res);
  }
  async complete(parts) {
    return new R2Object(await rpc(`${this._base}/mpu/complete`, { uploadId: this.uploadId, parts: parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })) }));
  }
  async abort() {
    const res = await nativeFetch(`${this._base}/mpu/abort`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: this.uploadId }) });
    if (!res.ok) await readJson(res);
  }
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
      if (isUpgrade(req)) return upgradeVia(`/b/${enc(spec.app)}/do/${enc(binding)}/${id}/fetch`, req, { 'x-rucloud-do-url': req.url });
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
  get sql() { throw new Error('SQL is not enabled for this Durable Object class：請在 wrangler 的 migrations 用 new_sqlite_classes 宣告'); }
}

// ---------- SQLite 型 Durable Object（migrations 的 new_sqlite_classes） ----------
//
// 物件只活在一個程序裡，所以直接用 Node 內建的 node:sqlite 開它自己的資料庫檔，
// ctx.storage.sql.exec() 和 Cloudflare 一樣是同步的。KV 型的 storage API 存在同一個檔案的 _cf_KV 表。

const sqliteClasses = new Set(spec.sqliteClasses || []);
const { DatabaseSync } = sqliteClasses.size ? await import('node:sqlite') : {};

// 把多句 SQL 切開（忽略字串、識別字、註解裡的分號；CREATE TRIGGER 到 END; 才算一句）
function splitSql(sql) {
  const out = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < n) {
        if (sql[i] === close) {
          if (close !== ']' && sql[i + 1] === close) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? n : j + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
    } else if (c === ';') {
      const stmt = sql.slice(start, i);
      if (/^\s*create\s+(temp\w*\s+)?trigger\b/i.test(stmt) && !/\bend\s*$/i.test(stmt)) { i++; continue; }
      if (stmt.trim()) out.push(stmt);
      start = ++i;
    } else {
      i++;
    }
  }
  const tail = sql.slice(start);
  if (tail.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()) out.push(tail);
  return out;
}

function sqlValue(v) {
  if (v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError(`SQL 不支援這種值：${v === undefined ? 'undefined' : typeof v}`);
}

const outValue = (v) => (v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);

class SqlStorageCursor {
  constructor(columnNames, rows, rowsRead, rowsWritten) {
    this.columnNames = columnNames;
    this._rows = rows;
    this._i = 0;
    this.rowsRead = rowsRead;
    this.rowsWritten = rowsWritten;
  }
  _obj(row) {
    const o = {};
    this.columnNames.forEach((c, i) => { o[c] = row[i]; });
    return o;
  }
  next() {
    if (this._i >= this._rows.length) return { done: true, value: undefined };
    return { done: false, value: this._obj(this._rows[this._i++]) };
  }
  [Symbol.iterator]() { return this; }
  toArray() { const out = []; for (const r of this) out.push(r); return out; }
  one() {
    const rest = this._rows.length - this._i;
    if (rest !== 1) throw new Error(rest === 0 ? 'Expected exactly one result from SQL query, but got no results.' : 'Expected exactly one result from SQL query, but got multiple results.');
    return this.next().value;
  }
  *raw() { while (this._i < this._rows.length) yield this._rows[this._i++]; }
}

class SqlStorage {
  constructor(storage) { this._s = storage; }
  get _db() { return this._s._open(); }
  exec(query, ...bindings) {
    const db = this._db;
    const stmts = splitSql(String(query));
    if (!stmts.length) return new SqlStorageCursor([], [], 0, 0);
    for (const s of stmts.slice(0, -1)) db.exec(s);
    const stmt = db.prepare(stmts[stmts.length - 1]);
    stmt.setReturnArrays(true);
    const cols = stmt.columns().map((c) => c.name);
    const params = bindings.map(sqlValue);
    if (cols.length) {
      const rows = stmt.all(...params).map((r) => r.map(outValue));
      const writes = /^\s*(insert|update|delete|replace)\b/i.test(stmts[stmts.length - 1]) ? rows.length : 0;
      return new SqlStorageCursor(cols, rows, rows.length, writes);
    }
    const r = stmt.run(...params);
    return new SqlStorageCursor([], [], 0, Number(r.changes));
  }
  get databaseSize() {
    const db = this._db;
    const pages = db.prepare('PRAGMA page_count').get().page_count;
    const size = db.prepare('PRAGMA page_size').get().page_size;
    return pages * size;
  }
  prepare() { throw new Error('ctx.storage.sql.prepare() 已被 Cloudflare 移除，請用 exec()'); }
}

class SqliteDurableObjectStorage {
  constructor(ns, id) {
    this._file = `${spec.doSqliteDir}/${ns}/${id}.sqlite`;
    this._alarm = new DurableObjectStorage(ns, id);  // 鬧鐘仍由 rucloud 排程
    this._db = null;
    this.sql = new SqlStorage(this);
    const self = this;
    // 同步的 KV API（ctx.storage.kv）
    this.kv = {
      get: (key) => self._get(key),
      put: (key, value) => self._put({ [key]: value }),
      delete: (key) => self._delete([key]) > 0,
      list: (opts) => self._list(opts),
    };
  }
  _open() {
    if (!this._db) {
      mkdirSync(dirname(this._file), { recursive: true });
      this._db = new DatabaseSync(this._file);
      this._db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;');
    }
    return this._db;
  }
  _get(key) {
    const r = this._open().prepare('SELECT value FROM _cf_KV WHERE key = ?').get(String(key));
    return r ? deser(r.value) : undefined;
  }
  _put(entries) {
    const st = this._open().prepare('INSERT OR REPLACE INTO _cf_KV (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(entries)) st.run(k, ser(v));
  }
  _delete(keys) {
    const st = this._open().prepare('DELETE FROM _cf_KV WHERE key = ?');
    let n = 0;
    for (const k of keys) n += Number(st.run(String(k)).changes);
    return n;
  }
  _list(o = {}) {
    const where = [];
    const args = [];
    if (o.prefix) { where.push('substr(key, 1, ?) = ?'); args.push(o.prefix.length, o.prefix); }
    if (o.start !== undefined) { where.push('key >= ?'); args.push(o.start); }
    if (o.startAfter !== undefined) { where.push('key > ?'); args.push(o.startAfter); }
    if (o.end !== undefined) { where.push('key < ?'); args.push(o.end); }
    const sql = `SELECT key, value FROM _cf_KV ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY key ${o.reverse ? 'DESC' : 'ASC'}${o.limit ? ` LIMIT ${Number(o.limit)}` : ''}`;
    return new Map(this._open().prepare(sql).all(...args).map((r) => [r.key, deser(r.value)]));
  }
  async get(key) {
    if (!Array.isArray(key)) return this._get(key);
    const out = new Map();
    for (const k of key) { const v = this._get(k); if (v !== undefined) out.set(k, v); }
    return out;
  }
  async put(key, value) { this._put(typeof key === 'string' ? { [key]: value } : key); }
  async delete(key) { const n = this._delete(Array.isArray(key) ? key : [key]); return Array.isArray(key) ? n : n > 0; }
  async list(options) { return this._list(options); }
  async deleteAll() {
    if (this._db) { this._db.close(); this._db = null; }
    for (const f of [this._file, `${this._file}-wal`, `${this._file}-shm`]) rmSync(f, { force: true });
    await this._alarm.deleteAlarm();
  }
  getAlarm() { return this._alarm.getAlarm(); }
  setAlarm(t) { return this._alarm.setAlarm(t); }
  deleteAlarm() { return this._alarm.deleteAlarm(); }
  transactionSync(fn) {
    const db = this._open();
    db.exec('SAVEPOINT rucloud_txn');
    try {
      const r = fn();
      db.exec('RELEASE rucloud_txn');
      return r;
    } catch (e) {
      db.exec('ROLLBACK TO rucloud_txn; RELEASE rucloud_txn');
      throw e;
    }
  }
  async transaction(fn) {
    const db = this._open();
    db.exec('SAVEPOINT rucloud_txn');
    let rolledBack = false;
    const txn = Object.create(this, { rollback: { value: () => { rolledBack = true; } } });
    try {
      const r = await fn(txn);
      db.exec(rolledBack ? 'ROLLBACK TO rucloud_txn; RELEASE rucloud_txn' : 'RELEASE rucloud_txn');
      return r;
    } catch (e) {
      db.exec('ROLLBACK TO rucloud_txn; RELEASE rucloud_txn');
      throw e;
    }
  }
  async sync() {}
}

class DurableObjectState {
  constructor(ns, id, sqlite) {
    this.id = new DurableObjectId(id);
    this.storage = sqlite ? new SqliteDurableObjectStorage(ns, id) : new DurableObjectStorage(ns, id);
    this._blockers = [];
    this._sockets = new Set();
    this._autoResponse = null;
  }
  blockConcurrencyWhile(fn) {
    const p = Promise.resolve().then(fn);
    this._blockers.push(p);
    return p;
  }
  waitUntil(p) { Promise.resolve(p).catch((e) => console.error('waitUntil:', e)); }
  // WebSocket hibernation API：訊息改由物件的 webSocketMessage / webSocketClose 處理
  acceptWebSocket(ws, tags = []) {
    if (!(ws instanceof CfWebSocket)) throw new TypeError('acceptWebSocket 需要 WebSocketPair 的 server 端');
    ws._hib = { inst: this._inst, tags: [...tags].map(String) };
    this._sockets.add(ws);
    ws.accept();
  }
  getWebSockets(tag) {
    return [...this._sockets].filter((ws) => ws.readyState === 1 && (tag === undefined || ws._hib.tags.includes(tag)));
  }
  getTags(ws) { return ws._hib ? [...ws._hib.tags] : []; }
  setWebSocketAutoResponse(pair) { this._autoResponse = pair || null; }
  getWebSocketAutoResponse() { return this._autoResponse || null; }
}

const doInstances = new Map();

function getInstance(ns, id) {
  const key = `${ns}:${id}`;
  let inst = doInstances.get(key);
  if (!inst) {
    const def = spec.durableObjects.find((d) => d.binding === ns);
    const Cls = def && workerModule[def.className];
    if (typeof Cls !== 'function') throw new Error(`Durable Object 類別 ${def?.className ?? ns} 沒有從 main 模組 export`);
    const state = new DurableObjectState(ns, id, sqliteClasses.has(def.className));
    inst = { state, obj: null, busy: 0, lastUsed: Date.now(), openSockets: new Set() };
    state._inst = inst;
    inst.obj = new Cls(state, env);
    // 建構子裡 blockConcurrencyWhile 的工作做完之前，事件都要排隊
    inst.chain = Promise.all(state._blockers).catch((e) => console.error(e));
    doInstances.set(key, inst);
  }
  return inst;
}

// 同一個物件的事件一次處理一個（近似 Cloudflare 的 input gate，避免讀-改-寫被插隊）
function serial(inst, fn) {
  inst.busy++;
  const p = inst.chain.then(() => doContext.run(inst, fn));
  inst.chain = p.catch(() => {}).finally(() => { inst.busy--; inst.lastUsed = Date.now(); });
  return p;
}

// 閒置的物件從記憶體移除（下次有事件再重建），SQLite 連線也關掉。
// 有開著的 WebSocket（含 hibernation 的）、還有事件在處理的物件不會被移除。
const DO_IDLE_MS = spec.doIdleMs ?? 60_000;
if (DO_IDLE_MS > 0) {
  setInterval(() => {
    const now = Date.now();
    for (const [key, inst] of doInstances) {
      const sockets = inst.state._sockets.size + [...inst.openSockets].filter((ws) => ws.readyState < 3).length;
      if (inst.busy === 0 && sockets === 0 && now - inst.lastUsed > DO_IDLE_MS) {
        doInstances.delete(key);
        const st = inst.state.storage;
        if (st._db) { try { st._db.close(); } catch { /* 已經關了 */ } st._db = null; }
      }
    }
  }, Math.min(DO_IDLE_MS, 10_000)).unref();
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

// Images：在 rucloud 裡處理（縮放、裁切、旋轉、疊圖，輸出 JPEG / PNG / WebP / GIF）
async function imageBytes(input, options = {}) {
  let bytes;
  if (input instanceof ImageTransformer) return new Uint8Array(await (await input.output({ format: 'image/png' }))._bytes);
  if (input instanceof ReadableStream || input instanceof Response || input instanceof Blob) bytes = new Uint8Array(await new Response(input).arrayBuffer());
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else throw new TypeError('Images：圖片要是 ReadableStream、ArrayBuffer 或 Blob');
  if (options.encoding === 'base64') bytes = new Uint8Array(Buffer.from(new TextDecoder().decode(bytes), 'base64'));
  return bytes;
}

class ImageTransformationResult {
  constructor(bytes, type) { this._bytes = bytes; this._type = type; }
  contentType() { return this._type; }
  image() { return new Response(this._bytes).body; }
  response() { return new Response(this._bytes, { headers: { 'content-type': this._type } }); }
}

class ImageTransformer {
  constructor(input, options) { this._input = input; this._options = options; this._steps = []; }
  transform(t = {}) { this._steps.push({ ...t }); return this; }
  draw(image, options = {}) {
    if (options.repeat) throw new Error('rucloud 的 Images 不支援 draw 的 repeat');
    this._steps.push({ overlay: { ...options, image } });
    return this;
  }
  async output(options = {}) {
    const image = toB64(await imageBytes(this._input, this._options));
    const steps = [];
    for (const s of this._steps) steps.push(s.overlay ? { overlay: { ...s.overlay, image: toB64(await imageBytes(s.overlay.image)) } } : s);
    const res = await nativeFetch(`${B}/images/transform`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ image, steps, output: options }),
    });
    if (!res.ok) await readJson(res);
    return new ImageTransformationResult(new Uint8Array(await res.arrayBuffer()), res.headers.get('content-type'));
  }
}

function makeImages() {
  return {
    async info(input, options) {
      const res = await nativeFetch(`${B}/images/info`, { method: 'POST', headers: AUTH, body: await imageBytes(input, options) });
      return readJson(res);
    },
    input(input, options) { return new ImageTransformer(input, options); },
  };
}

// send_email：EmailMessage（MIME 格式），或 { from, to, subject, text, html, cc, bcc, replyTo, headers }
const mailAddr = (a) => (typeof a === 'string' ? a : a?.email || '');
const mailName = (a) => (typeof a === 'string' ? `<${a}>` : a?.name ? `${mailWord(a.name)} <${a.email}>` : `<${a?.email}>`);
const mailWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
const mailList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const mailB64 = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');

function buildMail(m) {
  if (!m.from) throw new TypeError('send_email：要給 from');
  const to = mailList(m.to), cc = mailList(m.cc), bcc = mailList(m.bcc);
  if (!to.length) throw new TypeError('send_email：要給 to');
  const id = `<${crypto.randomUUID()}@rucloud>`;
  const head = [
    `From: ${mailName(m.from)}`,
    `To: ${to.map(mailName).join(', ')}`,
    ...(cc.length ? [`Cc: ${cc.map(mailName).join(', ')}`] : []),
    ...(m.replyTo ? [`Reply-To: ${mailList(m.replyTo).map(mailName).join(', ')}`] : []),
    `Subject: ${mailWord(String(m.subject ?? ''))}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    ...Object.entries(m.headers || {}).filter(([k]) => /^[A-Za-z0-9-]+$/.test(k) && !/^(from|to|cc|bcc|subject|date|message-id|mime-version|content-type|content-transfer-encoding)$/i.test(k)).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, ' ')}`),
  ];
  const part = (type, s) => [`Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', mailB64(s)].join('\r\n');
  let body;
  if (m.text !== undefined && m.html !== undefined) {
    const b = `rucloud-${crypto.randomUUID()}`;
    body = [`Content-Type: multipart/alternative; boundary="${b}"`, '', `--${b}`, part('text/plain', m.text), `--${b}`, part('text/html', m.html), `--${b}--`, ''].join('\r\n');
  } else {
    body = m.html !== undefined ? part('text/html', m.html) : part('text/plain', String(m.text ?? ''));
  }
  return { from: mailAddr(m.from), to: [...to, ...cc, ...bcc].map(mailAddr), raw: Buffer.from(`${head.join('\r\n')}\r\n${body}`), messageId: id };
}

function makeSendEmail(name) {
  return {
    async send(msg) {
      let mail;
      if (msg && typeof msg.from === 'string' && typeof msg.to === 'string' && msg.raw !== undefined && msg.subject === undefined) {
        const raw = typeof msg.raw === 'string' ? Buffer.from(msg.raw) : new Uint8Array(await new Response(msg.raw).arrayBuffer());
        mail = { from: msg.from, to: [msg.to], raw };
      } else {
        mail = buildMail(msg || {});
      }
      await rpc(`${B}/email/${enc(name)}`, { from: mail.from, to: mail.to, raw: toB64(mail.raw) });
      return mail.messageId ? { messageId: mail.messageId } : undefined;
    },
  };
}

function makeAi() {
  return {
    async run(model, inputs, options = {}) {
      if (!inputs?.stream) return rpc(`${B}/ai/run`, { model, inputs });
      // 串流：回傳 SSE 的 ReadableStream（data: {"response":"…"}），和 Workers AI 一樣
      const res = await nativeFetch(`${B}/ai/run`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: JSON.stringify({ model, inputs }) });
      if (!res.ok) await readJson(res);
      return res.body;
    },
    gateway() { throw new Error('請改用 rucloud 的 AI Gateway 端點（rucloud ai-gateway）'); },
  };
}

function makeRateLimiter(binding) {
  return { limit: ({ key } = {}) => rpc(`${B}/ratelimit/${enc(binding)}`, { key: String(key ?? '') }) };
}

function makeService(binding) {
  const target = {
    async fetch(input, init) {
      const req = new Request(input, init);
      if (isUpgrade(req)) return upgradeVia(`/b/${enc(spec.app)}/service/${enc(binding)}`, req, { 'x-rucloud-svc-url': req.url });
      const headers = new Headers(req.headers);
      headers.set('x-rucloud-token', spec.token);
      headers.set('x-rucloud-svc-url', req.url);
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      return nativeFetch(`${B}/service/${enc(binding)}`, { method: req.method, headers, body: hasBody ? req.body : undefined, duplex: 'half', redirect: 'manual' });
    },
    connect() { throw new Error('rucloud 不支援 service binding 的 connect()'); },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return async (...args) => {
        const res = await nativeFetch(`${B}/service/${enc(binding)}/rpc`, {
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

// ---------- Hyperdrive、Analytics Engine ----------

// Hyperdrive：rucloud 不做連線池，直接給資料庫的連線字串（和 wrangler dev 的 localConnectionString 一樣）
function makeHyperdrive({ binding, connectionString }) {
  if (!connectionString) {
    const missing = () => { throw new Error(`Hyperdrive ${binding} 沒有設定連線字串：wrangler 設定的 localConnectionString，或 CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_${binding}`); };
    return { get connectionString() { return missing(); } };
  }
  const u = new URL(connectionString);
  return {
    connectionString,
    host: u.hostname,
    port: Number(u.port) || (u.protocol.startsWith('mysql') ? 3306 : 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

// Analytics Engine：writeDataPoint 不等待（和 Cloudflare 一樣），累積一下再一起送
class AnalyticsEngineDataset {
  #buf = [];
  #timer = null;
  constructor(dataset) { this.dataset = dataset; }
  writeDataPoint(point = {}) {
    const blobs = (point.blobs || []).slice(0, 20).map((b) => (b == null ? null : ArrayBuffer.isView(b) || b instanceof ArrayBuffer ? Buffer.from(b.buffer ?? b).toString() : String(b)));
    const doubles = (point.doubles || []).slice(0, 20).map(Number);
    const indexes = (point.indexes || []).slice(0, 1).map((i) => (i == null ? null : String(i)));
    this.#buf.push({ blobs, doubles, index: indexes[0] ?? null, timestamp: Date.now() });
    this.#timer ??= setTimeout(() => this.#flush(), 50);
  }
  #flush() {
    const points = this.#buf.splice(0);
    this.#timer = null;
    if (points.length) rpc(`${B}/analytics/${enc(this.dataset)}`, { points }).catch((e) => console.error('Analytics Engine 寫入失敗：', e.message));
  }
}

// ---------- Workflows ----------

class WorkflowInstance {
  constructor(name, id) { this._name = name; this.id = id; }
  _op(op, extra = {}) { return rpc(`${B}/workflow/${enc(this._name)}`, { op, id: this.id, ...extra }); }
  status() { return this._op('status'); }
  async pause() { await this._op('pause'); }
  async resume() { await this._op('resume'); }
  async terminate() { await this._op('terminate'); }
  async restart() { await this._op('restart'); }
  async sendEvent({ type, payload }) { await this._op('sendEvent', { type, payload: payload ?? null }); }
}

class WorkflowBinding {
  constructor(name) { this._name = name; }
  async create(options = {}) {
    const { id } = await rpc(`${B}/workflow/${enc(this._name)}`, { op: 'create', id: options.id, params: options.params ?? {} });
    return new WorkflowInstance(this._name, id);
  }
  async createBatch(list) { return Promise.all(list.map((o) => this.create(o))); }
  async get(id) {
    const { exists } = await rpc(`${B}/workflow/${enc(this._name)}`, { op: 'exists', id });
    if (!exists) throw new Error(`找不到 Workflow 實例 ${id}`);
    return new WorkflowInstance(this._name, id);
  }
}

// "10 seconds"、"1 minute"、"2 hours"、"500 ms" 或毫秒數
function parseDuration(d) {
  if (typeof d === 'number') return d;
  const m = /^\s*([\d.]+)\s*(ms|millisecond|second|minute|hour|day|week)s?\s*$/i.exec(String(d));
  if (!m) throw new TypeError(`看不懂的時間長度：${d}`);
  const unit = { ms: 1, millisecond: 1, second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000 }[m[2].toLowerCase()];
  return Number(m[1]) * unit;
}

class Suspend {
  constructor(result) { this.result = result; }
}

// 重播執行 run(event, step)：已完成的步驟直接回傳存好的結果
async function runWorkflow(snap) {
  const Cls = workerModule[snap.className];
  if (typeof Cls !== 'function') return { status: 'errored', error: `Workflow 類別 ${snap.className} 沒有從 main 模組 export` };
  const ctx = makeCtx();
  const instance = new Cls(ctx, env);
  const steps = snap.steps;
  const counts = new Map();
  const unique = (kind, name) => {
    const k = `${kind}:${name}`;
    const n = (counts.get(k) || 0) + 1;
    counts.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  };
  const persist = (name, result) => rpc(`${B}/workflow/${enc(snap.workflow)}`, { op: 'step', id: snap.id, name, result });
  const consumed = new Map();
  const step = {
    async do(name, config, fn) {
      if (typeof config === 'function') { fn = config; config = {}; }
      const key = unique('do', name);
      if (key in steps) return deser(steps[key].value);
      const limit = config.retries?.limit ?? 5;
      const delay = parseDuration(config.retries?.delay ?? 1000);
      const backoff = config.retries?.backoff ?? 'exponential';
      const timeout = parseDuration(config.timeout ?? '10 minutes');
      for (let attempt = 0; ; attempt++) {
        try {
          let timer;
          const value = await Promise.race([
            Promise.resolve().then(fn),
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`step ${name} 逾時`)), timeout); }),
          ]).finally(() => clearTimeout(timer));
          await persist(key, { value: ser(value) });
          return value;
        } catch (e) {
          if (e?.name === 'NonRetryableError' || attempt >= limit) throw e;
          const factor = backoff === 'exponential' ? 2 ** attempt : backoff === 'linear' ? attempt + 1 : 1;
          await new Promise((r) => setTimeout(r, delay * factor));
        }
      }
    },
    async sleep(name, duration) {
      return step.sleepUntil(name, Date.now() + parseDuration(duration), unique('sleep', name));
    },
    async sleepUntil(name, when, key = unique('sleepUntil', name)) {
      let rec = steps[key];
      if (!rec) {
        rec = { until: when instanceof Date ? when.getTime() : Number(when) };
        await persist(key, rec);
      }
      if (Date.now() >= rec.until) return;
      throw new Suspend({ status: 'sleeping', wakeAt: rec.until });
    },
    async waitForEvent(name, { type, timeout = '24 hours' } = {}) {
      const key = unique('wait', name);
      const idx = consumed.get(type) || 0;
      consumed.set(type, idx + 1);
      const ev = snap.events.filter((e) => e.type === type)[idx];
      if (ev) return { type, payload: ev.payload, timestamp: new Date() };
      let rec = steps[key];
      if (!rec) {
        rec = { until: Date.now() + parseDuration(timeout) };
        await persist(key, rec);
      }
      if (Date.now() >= rec.until) throw new Error(`waitForEvent 逾時：${type}`);
      throw new Suspend({ status: 'waiting', wakeAt: rec.until, eventType: type });
    },
  };
  try {
    const output = await instance.run({ payload: snap.params, timestamp: new Date(snap.timestamp), instanceId: snap.id }, step);
    await ctx._drain();
    return { status: 'complete', output: output === undefined ? null : output };
  } catch (e) {
    if (e instanceof Suspend) return e.result;
    console.error(`Workflow ${snap.workflow}/${snap.id} 失敗：`, e?.stack || e);
    return { status: 'errored', error: String(e?.message || e) };
  }
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
  if (spec.images) env[spec.images] = makeImages();
  for (const n of spec.sendEmail || []) env[n] = makeSendEmail(n);
  for (const b of spec.ratelimits) env[b] = makeRateLimiter(b);
  for (const b of spec.services) env[b] = makeService(b);
  for (const w of spec.workflows || []) env[w.binding] = new WorkflowBinding(w.name);
  for (const h of spec.hyperdrive || []) env[h.binding] = makeHyperdrive(h);
  for (const a of spec.analytics || []) env[a.binding] = new AnalyticsEngineDataset(a.dataset);
  if (spec.ai) env[spec.ai] = makeAi();
  if (spec.assets) env[spec.assets] = makeAssets();
  return env;
}

// ---------- 全域：Cache API、scheduler、Service Worker 語法 ----------

// Cache API：存在 rucloud（Rust）裡，所有 Worker 程序共用
class RemoteCache {
  constructor(name) { this.base = `${B}/cache/${enc(name)}`; }
  #url(req) { return typeof req === 'string' ? new URL(req).href : req.url; }
  async match(req, options = {}) {
    if (typeof req !== 'string' && req.method !== 'GET' && !options.ignoreMethod) return undefined;
    const res = await nativeFetch(`${this.base}?url=${enc(this.#url(req))}`, { headers: AUTH });
    if (res.status === 404) { await res.body?.cancel(); return undefined; }
    if (!res.ok) await readJson(res);
    const meta = JSON.parse(decodeURIComponent(res.headers.get('x-cache-meta')));
    const headers = new Headers(meta.headers);
    headers.set('age', res.headers.get('x-cache-age') || '0');
    headers.set('cf-cache-status', 'HIT');
    const nobody = [101, 204, 205, 304].includes(meta.status);
    return new Response(nobody ? null : res.body, { status: meta.status, headers });
  }
  async put(req, response) {
    if (typeof req !== 'string' && req.method !== 'GET') throw new TypeError('Cannot cache response to non-GET request.');
    if (response.status === 206) throw new TypeError('Cannot cache response to a range request (206 Partial Content).');
    if ((response.headers.get('vary') || '').includes('*')) throw new TypeError("Cannot cache response with 'Vary: *' header.");
    const body = await response.arrayBuffer();
    const meta = enc(JSON.stringify({ status: response.status, headers: [...response.headers] }));
    const res = await nativeFetch(`${this.base}?url=${enc(this.#url(req))}`, { method: 'PUT', headers: { ...AUTH, 'x-cache-meta': meta }, body });
    await readJson(res);
  }
  async delete(req) {
    const res = await nativeFetch(`${this.base}?url=${enc(this.#url(req))}`, { method: 'DELETE', headers: AUTH });
    return (await readJson(res)).deleted;
  }
}
const namedCaches = new Map();
globalThis.caches = {
  default: new RemoteCache('default'),
  async open(name) { if (!namedCaches.has(name)) namedCaches.set(name, new RemoteCache(`named:${name}`)); return namedCaches.get(name); },
};
globalThis.HTMLRewriter = HTMLRewriter;
globalThis.scheduler ??= { wait: (ms) => new Promise((r) => setTimeout(r, ms)) };

// Worker 主動連出的 WebSocket：fetch(url, { headers: { Upgrade: 'websocket' } }) 回傳 response.webSocket
globalThis.fetch = async function fetch(input, init) {
  const req = new Request(input, init);
  if (!isUpgrade(req)) return nativeFetch(input, init);
  const url = new URL(req.url);
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  const protocols = (req.headers.get('sec-websocket-protocol') || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url.href, protocols);
    ws.binaryType = 'arraybuffer';
    const local = new CfWebSocket();
    local._peer = { _transport: { send: (d) => ws.send(d), close: (c, r) => ws.close(c, r) } };
    let opened = false;
    ws.onopen = () => { opened = true; local.protocol = ws.protocol; resolve(new Response(null, { status: 101, webSocket: local })); };
    ws.onmessage = (e) => local._dispatch('message', { data: e.data });
    ws.onclose = (e) => {
      if (!opened) return reject(new Error(`WebSocket 連不上 ${url.href}`));
      local._closed(e.code, e.reason, e.wasClean);
    };
    ws.onerror = () => { if (opened) local._dispatch('error', { error: new Error('WebSocket 錯誤'), message: 'WebSocket 錯誤' }); };
  });
};

if (NO_NETWORK) {
  globalThis.fetch = async function fetch() { throw new TypeError(NO_NETWORK_MSG); };
  globalThis.WebSocket = class WebSocket { constructor() { throw new TypeError(NO_NETWORK_MSG); } };
} else if (INSTALLED) {
  const allowed = globalThis.fetch;
  globalThis.fetch = async function fetch(input, init) {
    // 不用 new Request(input, init)：串流的 body 會被鎖住
    await checkPublic(input instanceof Request ? input.url : String(input instanceof URL ? input.href : input));
    return allowed(input, init);
  };
  // 建構子是同步的：位址檢查不過時改成連線失敗（error、close 事件）
  const NativeWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class WebSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      Object.assign(this, { url: String(url), readyState: 0, protocol: '', binaryType: 'blob', onopen: null, onmessage: null, onerror: null, onclose: null });
      this._ready = checkPublic(String(url).replace(/^ws/, 'http')).then(() => {
        const ws = (this._ws = new NativeWebSocket(url, protocols));
        ws.binaryType = this.binaryType;
        for (const t of ['open', 'message', 'error', 'close']) {
          ws.addEventListener(t, (e) => {
            this.readyState = ws.readyState;
            this.protocol = ws.protocol;
            const ev = new e.constructor(t, e);
            this[`on${t}`]?.(ev);
            this.dispatchEvent(ev);
          });
        }
      }, (e) => {
        this.readyState = 3;
        const err = new Event('error');
        err.error = e;
        this.onerror?.(err);
        this.dispatchEvent(err);
        const close = new CloseEvent('close', { code: 1006, reason: e.message, wasClean: false });
        this.onclose?.(close);
        this.dispatchEvent(close);
      });
    }
    send(data) { if (!this._ws) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError'); this._ws.send(data); }
    close(code, reason) { this._ready.then(() => this._ws?.close(code, reason)); }
  };
}

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

// props：service binding 設定的 props（rucloud 放在 x-rucloud-props 標頭，外來的請求不會有）
function makeCtx(props = {}) {
  const pending = [];
  return {
    waitUntil(p) { pending.push(Promise.resolve(p).catch((e) => console.error('waitUntil:', e))); },
    passThroughOnException() {},
    props,
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
  // 放在 Cloudflare（例如 Tunnel）後面時，國家取自 CF-IPCountry
  const country = headers.get('cf-ipcountry');
  Object.defineProperty(request, 'cf', { value: { ...CF, ...(country ? { country } : {}) }, enumerable: false });
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

function propsOf(req) {
  try { return JSON.parse(req.headers['x-rucloud-props'] || '{}') ?? {}; } catch { return {}; }
}

async function handleFetch(req, res) {
  const request = toRequest(req);
  const ctx = makeCtx(propsOf(req));
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
  if (kind === 'ping') return sendJson(res, 200, { ok: true });
  if (kind === 'workflow') {
    try {
      return sendJson(res, 200, await runWorkflow(JSON.parse(await readBody(req))));
    } catch (e) {
      return sendJson(res, 500, { error: String(e?.message || e) });
    }
  }
  if (kind === 'rpc') {
    // service binding 的 RPC：呼叫 default export（或具名 entrypoint）的方法
    try {
      const { method, args } = deser(await readBody(req));
      const epName = req.headers['x-rucloud-entrypoint'];
      const ep = epName ? workerModule[epName] : entry;
      if (!ep) throw new Error(`沒有 export ${epName}`);
      if (method === 'constructor' || String(method).startsWith('_')) throw new Error(`不能呼叫 ${method}`);
      const ctx = makeCtx(propsOf(req));
      const target = typeof ep === 'function' ? new ep(ctx, env) : ep;
      const fn = target[method];
      if (typeof fn !== 'function') throw new Error(`${epName || 'default'} 沒有方法 ${method}()`);
      const result = await fn.apply(target, args);
      ctx._drain();
      return sendJson(res, 200, ser({ result }));
    } catch (e) {
      return sendJson(res, 500, ser({ $error: String(e?.message || e) }));
    }
  }
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

// WebSocket：先照一般請求呼叫 Worker（或 Durable Object），依回應決定怎麼接
async function handleUpgrade(req, socket, head) {
  socket.on('error', () => {});
  const kind = req.headers['x-rucloud-kind'];
  let response;
  if (kind) {
    if (req.headers['x-rucloud-token'] !== spec.token || kind !== 'do') return socket.destroy();
    const inst = getInstance(req.headers['x-rucloud-do-ns'], req.headers['x-rucloud-do-id']);
    const request = toRequest(req, req.headers['x-rucloud-do-url']);
    try {
      response = await serial(inst, () => inst.obj.fetch(request));
    } catch (e) {
      console.error(e?.stack || e);
      response = new Response(`Durable Object threw exception:\n${e?.stack || e}\n`, { status: 500 });
    }
  } else {
    const ctx = makeCtx();
    try {
      if (!fetchHandler) throw new Error('Worker 沒有 fetch() handler');
      response = await fetchHandler(toRequest(req), ctx);
    } catch (e) {
      console.error(e?.stack || e);
      response = new Response(`Worker threw exception:\n${e?.stack || e}\n`, { status: 500 });
    }
    ctx._drain();
  }
  if (response?.status === 101 && response._tunnel) return spliceTunnel(socket, head, response._tunnel);
  if (response?.status === 101 && response.webSocket) return acceptLocalWebSocket(req, socket, head, response);
  if (response?.status === 101) response = new Response('101 回應缺少 webSocket\n', { status: 500 });
  await writeRawResponse(socket, response || new Response('沒有回應\n', { status: 500 }));
}

server.on('upgrade', (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((e) => { console.error(e?.stack || e); socket.destroy(); });
});

// rucloud 經過 Unix socket 送請求進來
server.listen(SOCKET, () => {
  process.stdout.write('RUCLOUD_READY\n');
});

// rucloud 結束時 stdin 會關閉，跟著結束
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
process.stdin.resume();
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
