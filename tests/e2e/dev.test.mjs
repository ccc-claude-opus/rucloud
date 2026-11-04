// rucloud dev：排程手動觸發、程式碼改了自動重載
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, start, freePort, json, sleep } from './helpers.mjs';

test('/__scheduled 觸發 scheduled()', async () => {
  const port = await freePort();
  const rc = await start({ args: ['dev', 'examples/showcase', '--port', String(port), '--state', join(mkdtempSync(join(tmpdir(), 'rc-')), 's')], ready: `http://127.0.0.1:${port}/` });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__scheduled?cron=*/5+*+*+*+*`);
    assert.equal(r.status, 200);
    const { body } = await json(`http://127.0.0.1:${port}/api/cron`);
    assert.match(body.lastCron, /^\*\/5 \* \* \* \* @ /);
  } finally {
    await rc.stop();
  }
});

test('改了 Worker 程式碼會自動重載', async () => {
  const app = mkdtempSync(join(tmpdir(), 'rc-app-'));
  cpSync(join(ROOT, 'examples/hello'), app, { recursive: true });
  const port = await freePort();
  const rc = await start({ args: ['dev', app, '--port', String(port), '--state', join(app, '.state')], ready: `http://127.0.0.1:${port}/` });
  try {
    assert.equal((await json(`http://127.0.0.1:${port}/`)).body.from, 'hello');
    const f = join(app, 'src/worker.js');
    writeFileSync(f, readFileSync(f, 'utf8').replace("from: 'hello'", "from: 'reloaded'"));
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const r = await json(`http://127.0.0.1:${port}/`).catch(() => null);
      if (r?.body?.from === 'reloaded') return;
    }
    assert.fail('沒有重載');
  } finally {
    await rc.stop();
    rmSync(app, { recursive: true, force: true });
  }
});
