// 用 rucloud serve 同時跑 examples 裡的應用，測各種綁定、edge、WebSocket、S3
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import { ROOT, start, freePort, json, session, sleep } from './helpers.mjs';

let rc;
const P = {};

before(async () => {
  for (const k of ['showcase', 'myshop', 'friendbook', 'chat', 'edge', 's3']) P[k] = await freePort();
  rc = await start({
    toml: `
[edge]
port = ${P.edge}
[s3]
port = ${P.s3}
access_key_id = "test"
secret_access_key = "secret"
[[app]]
path = "${ROOT}/examples/showcase"
port = ${P.showcase}
instances = 3
[[app]]
path = "${ROOT}/examples/hello"
[[app]]
path = "${ROOT}/examples/myshop"
port = ${P.myshop}
env_file = "${ROOT}/examples/myshop/.dev.vars.example"
d1_init = { DB = "schema.sql" }
[[app]]
path = "${ROOT}/examples/friendbook"
port = ${P.friendbook}
env_file = "${ROOT}/examples/friendbook/.dev.vars.example"
d1_init = { DB = "schema.sql" }
[[app]]
path = "${ROOT}/examples/chat"
port = ${P.chat}
instances = 2
`,
    ready: ['showcase', 'myshop', 'friendbook', 'chat'].map((k) => `http://127.0.0.1:${P[k]}/__ready`),
  });
});
after(() => rc?.stop());

const url = (app, path) => `http://127.0.0.1:${P[app]}${path}`;

test('靜態檔案：由 Rust 直接回應，支援 ETag / 304', async () => {
  const r = await fetch(url('showcase', '/'));
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  const etag = r.headers.get('etag');
  assert.ok(etag);
  const r2 = await fetch(url('showcase', '/index.html'), { headers: { 'if-none-match': etag } });
  assert.equal(r2.status, 304);
});

test('內部路徑與偽造的內部標頭會被擋下', async () => {
  assert.equal((await fetch(url('showcase', '/__rucloud/queue'))).status, 404);
  const r = await fetch(url('showcase', '/api/vars'), { headers: { 'x-rucloud-kind': 'queue', 'x-rucloud-token': 'x' } });
  assert.deepEqual(await r.json(), { greeting: '哈囉' });
});

test('D1：寫入與查詢', async () => {
  const a = await json(url('showcase', '/api/d1'));
  const b = await json(url('showcase', '/api/d1'));
  assert.equal(b.body.hits, a.body.hits + 1);
});

test('KV：讀寫與 list', async () => {
  const { body } = await json(url('showcase', '/api/kv'));
  assert.ok(body.visits >= 1);
  assert.equal(body.list.keys[0].name, 'visits');
  assert.deepEqual(body.list.keys[0].metadata, { by: 'showcase' });
});

test('R2：上傳、下載、列表、multipart', async () => {
  const put = await json(url('showcase', '/api/r2?key=t/a.txt'), { method: 'PUT', body: 'hello r2', headers: { 'content-type': 'text/plain' } });
  assert.equal(put.body.size, 8);
  const get = await fetch(url('showcase', '/api/r2?key=t/a.txt'));
  assert.equal(await get.text(), 'hello r2');
  assert.equal(get.headers.get('content-type'), 'text/plain');
  const mp = await json(url('showcase', '/api/r2-multipart'));
  assert.equal(mp.body.size, 5 * 1024 * 1024 + 4);
  assert.match(mp.body.etag, /-2$/);
});

test('Queues：送出後消費者會處理', async () => {
  const before = (await json(url('showcase', '/api/queue'))).body.done;
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const done = Number((await json(url('showcase', '/api/queue'))).body.done);
    if (done > before) return;
  }
  assert.fail('佇列訊息沒有被處理');
});

test('Durable Object：3 個程序、40 個並行請求，計數正確', async () => {
  const name = `race-${Date.now()}`;
  await Promise.all(Array.from({ length: 40 }, () => fetch(url('showcase', `/api/do?name=${name}`))));
  const { body } = await json(url('showcase', `/api/do?name=${name}`));
  assert.equal(body.n, 41);
  assert.equal(body.viaFetch.n, 41);
});

test('Vectorize：最近的向量排第一', async () => {
  const { body } = await json(url('showcase', '/api/vectors'));
  assert.equal(body.matches[0].id, 'cat');
  assert.equal(body.matches[1].id, 'dog');
});

test('限流：第 4 次回 429', async () => {
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await fetch(url('showcase', '/api/limit'))).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});

test('service binding 與 edge 的 Host 分派', async () => {
  const { body } = await json(url('showcase', '/api/hello'));
  assert.deepEqual(body, { from: 'hello', path: '/greet', host: 'hello.internal' });
  // fetch 不能改 Host 標頭，用 node:http
  const viaEdge = await new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: P.edge, path: '/x', headers: { host: `hello.localhost:${P.edge}` } }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => res(d));
    }).on('error', rej);
  });
  assert.equal(JSON.parse(viaEdge).from, 'hello');
});

test('HTMLRewriter 改寫靜態頁面', async () => {
  const html = await (await fetch(url('showcase', '/api/page'))).text();
  assert.match(html, /<h1>rucloud showcase（第 \d+ 次造訪）<\/h1>/);
  assert.match(html, /<a href="\/api\/vars">看 vars<\/a>/);
});

test('myshop：註冊、開店、點單、報表；價格由伺服器計算', async () => {
  const s = session();
  assert.equal((await s(url('myshop', '/api/me'))).status, 401);
  assert.equal((await s(url('myshop', '/api/signup'), { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'secret1' }) })).status, 200);
  const shop = await s(url('myshop', '/api/shop'), { method: 'POST', body: JSON.stringify({ name: '茶', template: 'bubbletea' }) });
  const tea = shop.body.products.find((p) => p.name === '珍珠奶茶');
  const order = await s(url('myshop', '/api/orders'), { method: 'POST', body: JSON.stringify({ day: '2026-01-01', items: [{ id: tea.id, qty: 2, price: 1 }] }) });
  assert.equal(order.body.total, 100);
  const report = await s(url('myshop', '/api/report?day=2026-01-01'));
  assert.equal(report.body.total, 100);
  const dup = await s(url('myshop', '/api/signup'), { method: 'POST', body: JSON.stringify({ email: 'a@b.co', password: 'secret1' }) });
  assert.equal(dup.status, 400);
});

test('friendbook：貼文、按讚（KV 快取）、留言、追蹤', async () => {
  const a = session();
  const b = session();
  await a(url('friendbook', '/api/signup'), { method: 'POST', body: JSON.stringify({ email: 'a@a.co', password: 'secret1', name: 'amy' }) });
  await b(url('friendbook', '/api/signup'), { method: 'POST', body: JSON.stringify({ email: 'b@b.co', password: 'secret1', name: 'bob' }) });
  const post = await a(url('friendbook', '/api/posts'), { method: 'POST', body: JSON.stringify({ text: '你好 #rust' }) });
  assert.deepEqual(post.body.tags, ['rust']);
  const like = await b(url('friendbook', `/api/posts/${post.body.id}/like`), { method: 'POST' });
  assert.deepEqual(like.body, { liked: true, likes: 1 });
  await a(url('friendbook', `/api/posts/${post.body.id}/comments`), { method: 'POST', body: JSON.stringify({ text: '讚' }) });
  const detail = await b(url('friendbook', `/api/posts/${post.body.id}`));
  assert.equal(detail.body.post.likes, 1);
  assert.equal(detail.body.comments.length, 1);
  const hot = await b(url('friendbook', '/api/hot'));
  assert.equal(hot.body.posts[0].id, post.body.id);
  assert.deepEqual((await b(url('friendbook', '/api/follow/1'), { method: 'POST' })).body, { following: true });
});

function wsOpen(u) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(u);
    const msgs = [];
    ws.onmessage = (e) => msgs.push(e.data);
    ws.onopen = () => res({ ws, msgs });
    ws.onerror = () => rej(new Error(`WebSocket 連不上 ${u}`));
  });
}

test('WebSocket：Worker 回聲（文字、大訊息）', async () => {
  const { ws, msgs } = await wsOpen(`ws://127.0.0.1:${P.chat}/echo`);
  ws.send('哈囉');
  ws.send('x'.repeat(200_000));
  await sleep(300);
  assert.equal(msgs[0], 'echo: 哈囉');
  assert.equal(msgs[1].length, 200_006);
  ws.close();
});

test('WebSocket：Durable Object 聊天室（跨程序廣播、紀錄存在 SQLite）', async () => {
  const room = `r${Date.now()}`;
  const a = await wsOpen(`ws://127.0.0.1:${P.chat}/ws?room=${room}&name=amy`);
  const b = await wsOpen(`ws://127.0.0.1:${P.chat}/ws?room=${room}&name=bob`);
  await sleep(150);
  a.ws.send('嗨');
  await sleep(300);
  const got = b.msgs.map((m) => JSON.parse(m));
  assert.deepEqual(got[0], { type: 'history', messages: [] });
  assert.ok(got.some((m) => m.type === 'message' && m.name === 'amy' && m.text === '嗨'));
  a.ws.close();
  b.ws.close();
  const c = await wsOpen(`ws://127.0.0.1:${P.chat}/ws?room=${room}&name=cat`);
  await sleep(200);
  assert.equal(JSON.parse(c.msgs[0]).messages[0].text, '嗨');
  c.ws.close();
  assert.equal((await fetch(`http://127.0.0.1:${P.chat}/ws`)).status, 426);
});

// ---------- S3 ----------

function sign(method, path, { query = {}, body = '', headers = {}, secret = 'secret' } = {}) {
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const date = now.slice(0, 8);
  const host = `127.0.0.1:${P.s3}`;
  const payload = createHash('sha256').update(body).digest('hex');
  const h = { host, 'x-amz-date': now, 'x-amz-content-sha256': payload, ...headers };
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const q = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonPath = path.split('/').map(enc).join('/');
  const canon = [method, canonPath, q, names.map((n) => `${n}:${h[Object.keys(h).find((k) => k.toLowerCase() === n)]}\n`).join(''), names.join(';'), payload].join('\n');
  const scope = `${date}/auto/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${createHash('sha256').update(canon).digest('hex')}`;
  let key = createHmac('sha256', `AWS4${secret}`).update(date).digest();
  for (const p of ['auto', 's3', 'aws4_request']) key = createHmac('sha256', key).update(p).digest();
  const sig = createHmac('sha256', key).update(toSign).digest('hex');
  return fetch(`http://${host}${canonPath}${q ? `?${q}` : ''}`, {
    method,
    body: body || undefined,
    headers: { ...h, authorization: `AWS4-HMAC-SHA256 Credential=test/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}` },
  });
}

test('S3 API：SigV4、put/get/list、Worker 看得到', async () => {
  const put = await sign('PUT', '/showcase-files/s3/中文.txt', { body: 'from s3', headers: { 'content-type': 'text/plain', 'x-amz-meta-owner': 'ccc' } });
  assert.equal(put.status, 200);
  const get = await sign('GET', '/showcase-files/s3/中文.txt');
  assert.equal(await get.text(), 'from s3');
  assert.equal(get.headers.get('x-amz-meta-owner'), 'ccc');
  const list = await (await sign('GET', '/showcase-files', { query: { 'list-type': '2', prefix: 's3/' } })).text();
  assert.match(list, /<Key>s3\/中文.txt<\/Key>/);
  assert.equal(await (await fetch(url('showcase', `/api/r2?key=${encodeURIComponent('s3/中文.txt')}`))).text(), 'from s3');
  assert.equal((await sign('GET', '/showcase-files', { secret: 'wrong' })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${P.s3}/showcase-files/s3/x`)).status, 403);
});
