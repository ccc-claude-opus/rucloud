// Workflows（重播、重試、sleep、waitForEvent、pause / terminate、錯誤）、service binding RPC、主動連出的 WebSocket
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT, start, freePort, json, sleep } from './helpers.mjs';

let rc;
const P = {};
before(async () => {
  [P.flows, P.calc] = [await freePort(), await freePort()];
  rc = await start({
    toml: `[[app]]\npath = "${ROOT}/tests/fixtures/flows"\nport = ${P.flows}\n[[app]]\npath = "${ROOT}/tests/fixtures/calc"\nport = ${P.calc}\n`,
    ready: [`http://127.0.0.1:${P.flows}/`, `http://127.0.0.1:${P.calc}/`],
  });
});
after(() => rc?.stop());

const f = (p) => `http://127.0.0.1:${P.flows}${p}`;
const status = async (id) => (await json(f(`/wf/status?id=${id}`))).body;
async function until(id, want, ms = 8000) {
  const end = Date.now() + ms;
  let s;
  while (Date.now() < end) {
    s = await status(id);
    if (s.status === want) return s;
    await sleep(100);
  }
  assert.fail(`等不到 ${want}，最後是 ${JSON.stringify(s)}`);
}

test('Workflow：重試、sleep、等事件、重播不重跑完成的步驟', async () => {
  const { id } = (await json(f('/wf/create?id=order-1'))).body;
  assert.equal(id, 'order-1');
  await until(id, 'waiting');
  await sleep(1500); // sleep 結束後應該停在 waitForEvent
  assert.equal((await status(id)).status, 'waiting');
  await fetch(f(`/wf/approve?id=${id}`));
  const done = await until(id, 'complete');
  assert.equal(done.output.amount, 100);
  assert.equal(done.output.isDate, true, 'step 結果保留 Date');
  assert.equal(done.output.flaky, 3, '前兩次失敗、第三次成功');
  assert.equal(done.output.shipped, 'shipped by amy');
  assert.equal(done.output.ran.charge, 1, '重播時已完成的步驟不會再跑');
  assert.ok(done.output.ran.runs >= 3, 'run() 被重播了好幾次');
  assert.equal((await fetch(f('/wf/create?id=order-1'))).status, 500, '同一個 id 不能建兩次');
});

test('Workflow：pause、resume、terminate、NonRetryableError', async () => {
  const { id } = (await json(f('/wf/create?id=order-2'))).body;
  await until(id, 'waiting');
  await fetch(f(`/wf/pause?id=${id}`));
  assert.equal((await status(id)).status, 'paused');
  await fetch(f(`/wf/approve?id=${id}`));
  await sleep(500);
  assert.equal((await status(id)).status, 'paused', '暫停中不會往下跑');
  await fetch(f(`/wf/resume?id=${id}`));
  await until(id, 'complete');

  const { id: id3 } = (await json(f('/wf/create?id=order-3'))).body;
  await until(id3, 'waiting');
  await fetch(f(`/wf/terminate?id=${id3}`));
  assert.equal((await status(id3)).status, 'terminated');

  const { id: bad } = (await json(f('/wf/fail'))).body;
  let s;
  for (let i = 0; i < 50; i++) {
    s = (await json(f(`/wf/fail-status?id=${bad}`))).body;
    if (s.status === 'errored') break;
    await sleep(100);
  }
  assert.equal(s.status, 'errored');
  assert.equal(s.error.message, '不能重試的錯誤');
});

test('service binding RPC：default 與具名 entrypoint、結構化資料、錯誤', async () => {
  const { body } = await json(f('/rpc'));
  assert.deepEqual(body, { sum: 5, date: true, map: 1, name: 'calc', admin: 'admin-only', fetched: 'calc', err: 'default 沒有方法 nope()' });
});

test('Worker 主動連出的 WebSocket', async () => {
  const r = await fetch(f(`/ws-out?target=${encodeURIComponent(`http://127.0.0.1:${P.calc}/echo`)}`));
  assert.equal(await r.text(), 'calc got ping');
});

test('Workflow：rucloud 重啟後接著跑', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rc-wf-'));
  const port = await freePort();
  const cfg = join(dir, 'rucloud.toml');
  writeFileSync(cfg, `state_dir = "${join(dir, 's')}"\n[[app]]\npath = "${ROOT}/tests/fixtures/flows"\nport = ${port}\n[[app]]\npath = "${ROOT}/tests/fixtures/calc"\n`);
  const g = (p) => `http://127.0.0.1:${port}${p}`;
  let r = await start({ args: ['serve', cfg], ready: g('/') });
  await json(g('/wf/create?id=persist'));
  for (let i = 0; i < 80 && (await json(g('/wf/status?id=persist'))).body.status !== 'waiting'; i++) await sleep(100);
  await r.stop();
  r = await start({ args: ['serve', cfg], ready: g('/') });
  try {
    await sleep(1500);
    await fetch(g('/wf/approve?id=persist'));
    let s;
    for (let i = 0; i < 80; i++) {
      s = (await json(g('/wf/status?id=persist'))).body;
      if (s.status === 'complete') break;
      await sleep(100);
    }
    assert.equal(s.status, 'complete');
    assert.equal(s.output.ran.charge, 0, '重啟後的程序不需要再跑 charge（結果來自儲存）');
  } finally {
    await r.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
