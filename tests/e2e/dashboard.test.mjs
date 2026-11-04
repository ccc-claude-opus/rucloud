// 管理介面：網頁本身公開，資料端點（/stats、/queues）要 token
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROOT, start, freePort, json } from './helpers.mjs';

test('管理介面與 /stats、/queues', async () => {
  const [port, admin] = [await freePort(), await freePort()];
  const rc = await start({
    toml: `[admin]\nport = ${admin}\ntoken = "tok"\n[[app]]\npath = "${ROOT}/examples/showcase"\nport = ${port}\ninstances = 2\ncache_mb = 4\n[[app]]\npath = "${ROOT}/examples/hello"\n`,
    ready: [`http://127.0.0.1:${port}/`, `http://127.0.0.1:${admin}/health`],
  });
  const A = (p) => `http://127.0.0.1:${admin}${p}`;
  const auth = { headers: { authorization: 'Bearer tok' } };
  try {
    const page = await fetch(A('/'));
    assert.equal(page.status, 200, '網頁不需要 token（裡面沒有資料）');
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>rucloud 管理<\/title>/);

    assert.equal((await fetch(A('/stats'))).status, 401);
    assert.equal((await fetch(A('/queues'))).status, 401);

    await fetch(`http://127.0.0.1:${port}/api/d1`);
    await fetch(`http://127.0.0.1:${port}/api/queue`);
    await fetch(`http://127.0.0.1:${port}/`);
    const { body } = await json(A('/stats'), auth);
    assert.equal(body.token_required, true);
    assert.match(body.version, /^\d+\.\d+\.\d+$/);
    const sc = body.apps.find((a) => a.name === 'showcase');
    assert.deepEqual(sc.workers, { ready: 2, total: 2, restarts: 0 });
    assert.ok(sc.requests.worker['2xx'] >= 2);
    assert.ok(sc.requests.asset['2xx'] >= 1, '等待啟動的探測也會打 /');
    assert.equal(sc.cache.enabled, true);
    assert.deepEqual(sc.bindings_config.d1, ['DB']);
    assert.ok(sc.bindings.d1 >= 1, '綁定呼叫次數');
    assert.equal(body.apps.find((a) => a.name === 'hello').cache.enabled, false);

    const q = (await json(A('/queues'), auth)).body;
    assert.ok(Array.isArray(q));
  } finally {
    await rc.stop();
  }
});
