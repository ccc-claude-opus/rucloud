// SQLite 型 Durable Object：ctx.storage.sql、同步 KV、交易、deleteAll
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, freePort, json } from './helpers.mjs';

test('ctx.storage.sql 與相關 API', async () => {
  const port = await freePort();
  const rc = await start({
    args: ['dev', 'tests/fixtures/sqldo', '--port', String(port), '--instances', '2', '--state', join(mkdtempSync(join(tmpdir(), 'rc-')), 's')],
    ready: `http://127.0.0.1:${port}/__ready`,
  });
  try {
    const { body } = await json(`http://127.0.0.1:${port}/`);
    const r = body.run;
    assert.equal(r.insertWritten, 1);
    assert.deepEqual(r.ret, { id: 2, text: 'c' });
    assert.deepEqual(r.cols, ['id', 'text', 'data']);
    assert.deepEqual(r.rows[0], { id: 1, text: 'a;b', data: [1, 2] });
    assert.deepEqual(r.raw, [[1, 1], [2, 2]]);
    assert.equal(r.log, 2, 'CREATE TRIGGER 要能正確切句');
    assert.match(r.oneErr, /^Expected exactly one result/);
    assert.equal(r.afterRollback, 0);
    assert.equal(r.kv, true);
    assert.deepEqual(body.kv, ['a', 'b', 'k']);
    assert.match(body.old, /^SQL is not enabled/);
    assert.equal(body.wipe, 0);
  } finally {
    await rc.stop();
  }
});
