// Hyperdrive、Analytics Engine、R2 事件通知、Queues 的 HTTP pull、D1 匯出 / 匯入
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, start, freePort, json, cli, sleep } from './helpers.mjs';

let rc;
const P = {};
before(async () => {
  [P.app, P.admin] = [await freePort(), await freePort()];
  rc = await start({
    toml: `[admin]\nport = ${P.admin}\n[[app]]\npath = "${ROOT}/tests/fixtures/data"\nport = ${P.app}\n`,
    ready: [`http://127.0.0.1:${P.app}/`, `http://127.0.0.1:${P.admin}/health`],
  });
});
after(() => rc?.stop());
const a = (p) => `http://127.0.0.1:${P.app}${p}`;
const adm = (p, body) => json(`http://127.0.0.1:${P.admin}${p}`, typeof body === 'string'
  ? { method: 'POST', body }
  : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

test('Hyperdrive：連線字串與拆好的欄位', async () => {
  assert.deepEqual((await json(a('/hd'))).body, {
    connectionString: 'postgres://user:p%40ss@db.example.com:6543/shop', host: 'db.example.com', port: 6543, user: 'user', password: 'p@ss', database: 'shop',
  });
});

test('Analytics Engine：writeDataPoint 後用 SQL 查', async () => {
  await fetch(a('/ae'));
  let r;
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    r = await adm('/analytics/sql', 'SELECT blob1 AS path, COUNT(*) AS n, AVG(double1) AS ms FROM page_views GROUP BY blob1 ORDER BY blob1');
    if (r.body?.rows === 2) break;
  }
  assert.deepEqual(r.body.data, [{ path: '/a', n: 2, ms: 20 }, { path: '/b', n: 1, ms: 5 }]);
  assert.equal((await adm('/analytics/sql', 'DELETE FROM page_views')).status, 400, '只能查詢');
});

test('R2 事件通知送進佇列（含 prefix 過濾）', async () => {
  await fetch(a('/r2put?key=up/a.txt'));
  await fetch(a('/r2put?key=other/b.txt'));
  await fetch(a('/r2del?key=up/a.txt'));
  let ev = [];
  for (let i = 0; i < 40 && ev.length < 2; i++) {
    await sleep(100);
    ev = (await json(a('/events'))).body;
  }
  assert.deepEqual(ev, [
    { action: 'PutObject', key: 'up/a.txt', bucket: 'data-files' },
    { action: 'DeleteObject', key: 'up/a.txt', bucket: 'data-files' },
  ]);
});

test('Queues 的 HTTP pull consumer', async () => {
  await fetch(a('/out'));
  await (await adm('/queues/outbox/messages', { body: { from: 'http' } })).body;
  const pulled = (await adm('/queues/outbox/messages/pull', { batch_size: 10, visibility_timeout_ms: 60000 })).body.messages;
  assert.deepEqual(pulled.map((m) => m.body), [{ hello: 'pull' }, { from: 'http' }]);
  assert.equal((await adm('/queues/outbox/messages/pull', {})).body.messages.length, 0, '租約期間別人拿不到');
  const ack = await adm('/queues/outbox/messages/ack', { acks: [{ lease_id: pulled[0].lease_id }], retries: [{ lease_id: pulled[1].lease_id, delay_seconds: 0 }] });
  assert.deepEqual(ack.body, { ackCount: 1, retryCount: 1 });
  const again = (await adm('/queues/outbox/messages/pull', {})).body.messages;
  assert.deepEqual(again.map((m) => [m.body, m.attempts]), [[{ from: 'http' }, 2]]);
});

test('D1 匯出再匯入', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rc-d1x-'));
  const [s1, s2, out] = [join(tmp, 'a'), join(tmp, 'b'), join(tmp, 'dump.sql')];
  const app = 'examples/showcase';
  cli('d1', 'execute', app, 'DB', '--command', "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)", '--state', s1);
  cli('d1', 'execute', app, 'DB', '--command', "CREATE INDEX idx_t ON t(name)", '--state', s1);
  cli('d1', 'execute', app, 'DB', '--command', "INSERT INTO t (name, data) VALUES ('it''s', x'0102'), (NULL, NULL)", '--state', s1);
  cli('d1', 'export', app, 'DB', '-o', out, '--state', s1);
  const sql = readFileSync(out, 'utf8');
  assert.match(sql, /CREATE TABLE t/);
  assert.match(sql, /INSERT INTO "t" VALUES\(1,'it''s',X'0102'\);/);
  assert.match(sql, /CREATE INDEX idx_t/);
  cli('d1', 'execute', app, 'DB', '--file', out, '--state', s2);
  assert.match(cli('d1', 'execute', app, 'DB', '--command', 'SELECT COUNT(*) AS n FROM t', '--state', s2), /"n"[^\d]*2|2/);
  assert.equal(cli('d1', 'export', app, 'DB', '--no-schema', '--state', s2).trim().split('\n').length, 3, 'PRAGMA + 兩筆資料');
});
