// 沙箱：檔案系統、子程序、環境變數、無窮迴圈的看門狗
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, freePort, json, sleep } from './helpers.mjs';

test('Worker 不能碰應用資料夾以外的東西', async () => {
  const port = await freePort();
  const rc = await start({
    args: ['dev', 'tests/fixtures/sandbox', '--port', String(port), '--max-block-ms', '2000', '--state', join(mkdtempSync(join(tmpdir(), 'rc-')), 's')],
    ready: `http://127.0.0.1:${port}/pid`,
    env: { SECRET_OF_HOST: 'leak' },
  });
  try {
    const { body } = await json(`http://127.0.0.1:${port}/`);
    assert.equal(body.readOutside.code, 'ERR_ACCESS_DENIED');
    assert.equal(body.readOwn.ok, true);
    assert.equal(body.write.code, 'ERR_ACCESS_DENIED');
    assert.equal(body.child.code, 'ERR_ACCESS_DENIED');
    assert.ok(!body.env.includes('SECRET_OF_HOST'), '主機的環境變數不能漏進 Worker');
    assert.ok(!body.env.includes('RUCLOUD_SPEC'));
    assert.deepEqual(body.kv, { ok: true, value: '1' });

    // 無窮迴圈：看門狗重開程序（pid 會變）
    const pid = await (await fetch(`http://127.0.0.1:${port}/pid`)).text();
    await fetch(`http://127.0.0.1:${port}/loop`, { signal: AbortSignal.timeout(8000) }).catch(() => {});
    let newPid = pid;
    for (let i = 0; i < 40 && newPid === pid; i++) {
      await sleep(250);
      newPid = await (await fetch(`http://127.0.0.1:${port}/pid`).catch(() => null))?.text() ?? pid;
    }
    assert.notEqual(newPid, pid, '卡住的程序要被重開');
  } finally {
    await rc.stop();
  }
});
