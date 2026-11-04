// Workers AI（一般、串流、embedding）與 AI Gateway 的 Universal endpoint（fallback），後端是測試裡的假 OpenAI 伺服器
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ROOT, start, freePort } from './helpers.mjs';

let rc;
let fake;
const P = {};
const seen = [];

before(async () => {
  fake = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    if (req.url.startsWith('/fail')) { res.writeHead(500); return res.end('boom'); }
    if (req.url.endsWith('/embeddings')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }] }));
    }
    const b = JSON.parse(body);
    if (b.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const t of ['你', '好', '！']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 30));
      }
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: `hello from fake (${b.model})` } }], usage: { total_tokens: 3 } }));
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  P.fake = fake.address().port;
  [P.app, P.gw] = [await freePort(), await freePort()];
  rc = await start({
    toml: `[ai_gateway]\nport = ${P.gw}\n[ai_gateway.providers]\nbad = "http://127.0.0.1:${P.fake}/fail"\ngood = "http://127.0.0.1:${P.fake}"\n`
      + `[[app]]\npath = "${ROOT}/tests/fixtures/aiapp"\nport = ${P.app}\n`,
    ready: `http://127.0.0.1:${P.app}/`,
    env: { RUCLOUD_AI_BASE_URL: `http://127.0.0.1:${P.fake}/v1`, RUCLOUD_AI_API_KEY: 'sk-test' },
  });
});
after(async () => { await rc?.stop(); fake?.close(); });

const a = (p) => `http://127.0.0.1:${P.app}${p}`;

test('env.AI.run：文字生成與 embedding', async () => {
  const chat = await (await fetch(a('/chat'))).json();
  assert.deepEqual(chat, { response: 'hello from fake (@cf/meta/llama-3.1-8b-instruct)', usage: { total_tokens: 3 } });
  assert.equal(seen.at(-1).auth, 'Bearer sk-test');
  assert.deepEqual(await (await fetch(a('/embed'))).json(), { shape: [2, 3], data: [[1, 2, 3], [4, 5, 6]] });
});

test('env.AI.run 串流：轉成 Workers AI 的 SSE 格式', async () => {
  const r = await fetch(a('/stream'));
  assert.match(r.headers.get('content-type'), /event-stream/);
  const events = (await r.text()).split('\n\n').filter(Boolean);
  assert.deepEqual(events, ['data: {"response":"你"}', 'data: {"response":"好"}', 'data: {"response":"！"}', 'data: [DONE]']);
});

test('AI Gateway Universal endpoint：第一個失敗就換下一個', async () => {
  const steps = [
    { provider: 'bad', endpoint: 'v1/chat/completions', headers: { authorization: 'Bearer a' }, query: { model: 'm1', messages: [] } },
    { provider: 'good', endpoint: 'v1/chat/completions', headers: { authorization: 'Bearer b' }, query: { model: 'm2', messages: [] } },
  ];
  const r = await fetch(`http://127.0.0.1:${P.gw}/my-gw`, { method: 'POST', body: JSON.stringify(steps) });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cf-aig-step'), '1');
  assert.equal((await r.json()).choices[0].message.content, 'hello from fake (m2)');
  assert.equal(seen.at(-1).auth, 'Bearer b', '第二步用自己的標頭');
  const logs = await (await fetch(`http://127.0.0.1:${P.gw}/__logs?limit=2`)).json();
  assert.deepEqual(logs.logs.map((l) => [l.provider, l.status]), [['good', 200], ['bad', 500]]);
  const allBad = await fetch(`http://127.0.0.1:${P.gw}/my-gw`, { method: 'POST', body: JSON.stringify([steps[0]]) });
  assert.equal(allBad.status, 500, '全部失敗時回最後一個錯誤');
});
