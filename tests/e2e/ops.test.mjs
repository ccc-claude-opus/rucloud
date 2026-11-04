// 維運：管理埠（health、metrics、log、tail）、log 檔、SIGTERM 優雅關閉
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN, ROOT, start, freePort, json, sleep } from './helpers.mjs';

test('health、metrics、logs、tail、log 檔', async () => {
  const [port, admin] = [await freePort(), await freePort()];
  const state = join(mkdtempSync(join(tmpdir(), 'rc-ops-')), 's');
  const rc = await start({
    args: ['dev', 'tests/fixtures/slow', '--port', String(port), '--admin-port', String(admin), '--state', state],
    ready: `http://127.0.0.1:${admin}/health`,
  });
  try {
    await fetch(`http://127.0.0.1:${port}/a`);
    const health = await json(`http://127.0.0.1:${admin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.apps.slow.workers, { ready: 1, total: 1 });

    // tail：開著的時候發請求，要收到 console 與 request 兩種紀錄
    const tail = spawn(BIN, ['tail', 'slow', '--admin', `http://127.0.0.1:${admin}`, '-n', '0', '--json'], { cwd: ROOT });
    let out = '';
    tail.stdout.on('data', (d) => { out += d; });
    await sleep(500);
    await fetch(`http://127.0.0.1:${port}/oops`);
    for (let i = 0; i < 40 && !(out.includes('"request"') && out.includes('something went wrong')); i++) await sleep(100);
    tail.kill();
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.kind === 'console' && l.message === 'handling /oops'), out);
    assert.ok(lines.some((l) => l.kind === 'error' && l.message === 'something went wrong'), out);
    assert.ok(lines.some((l) => l.kind === 'request' && /^GET \/oops 200 /.test(l.message)), out);

    const logs = await json(`http://127.0.0.1:${admin}/apps/slow/logs?n=50`);
    assert.ok(logs.body.some((l) => l.message === 'handling /a'));
    assert.equal((await fetch(`http://127.0.0.1:${admin}/apps/nope/logs`)).status, 404);

    const metrics = await (await fetch(`http://127.0.0.1:${admin}/metrics`)).text();
    assert.match(metrics, /rucloud_requests_total\{app="slow",route="worker",status="2xx"\} [2-9]/);
    assert.match(metrics, /rucloud_request_duration_seconds_count\{app="slow"\} \d+/);
    assert.match(metrics, /rucloud_worker_restarts_total\{app="slow"\} 0/);

    const files = readdirSync(join(state, 'slow', 'logs'));
    assert.equal(files.length, 1);
    assert.match(readFileSync(join(state, 'slow', 'logs', files[0]), 'utf8'), /handling \/oops/);
  } finally {
    await rc.stop();
  }
});

test('管理 token', async () => {
  const [port, admin] = [await freePort(), await freePort()];
  const rc = await start({
    toml: `[admin]\nport = ${admin}\ntoken = "s3cret"\n[[app]]\npath = "${ROOT}/tests/fixtures/slow"\nport = ${port}\n`,
    ready: `http://127.0.0.1:${admin}/health`,
  });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${admin}/metrics`)).status, 200, 'metrics 不需要 token');
    assert.equal((await fetch(`http://127.0.0.1:${admin}/apps`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${admin}/apps`, { headers: { authorization: 'Bearer s3cret' } })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${admin}/apps?token=s3cret`)).status, 200);
  } finally {
    await rc.stop();
  }
});

test('SIGTERM：進行中的請求做完才結束，關閉期間 health 回 503', async () => {
  const [port, admin] = [await freePort(), await freePort()];
  const rc = await start({
    toml: `shutdown_timeout = 10\n[admin]\nport = ${admin}\n[[app]]\npath = "${ROOT}/tests/fixtures/slow"\nport = ${port}\n`,
    ready: [`http://127.0.0.1:${port}/`, `http://127.0.0.1:${admin}/health`],
  });
  const slow = fetch(`http://127.0.0.1:${port}/slow`).then(async (r) => [r.status, await r.text()]);
  await sleep(300);
  rc.child.kill('SIGTERM');
  await sleep(200);
  assert.equal((await fetch(`http://127.0.0.1:${admin}/health`)).status, 503);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/a`), '關閉中不接受新連線');
  assert.deepEqual(await slow, [200, 'done /slow']);
  const code = await Promise.race([rc.exited, sleep(5000).then(() => 'timeout')]);
  assert.notEqual(code, 'timeout', 'rucloud 要自己結束');
  await rc.stop();
});
