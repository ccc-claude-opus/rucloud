// 開發體驗：rucloud init 的每個範本都跑得起來、rucloud types 產生 Env 型別
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, freePort, cli, json } from './helpers.mjs';

const fresh = (name) => join(mkdtempSync(join(tmpdir(), 'rc-init-')), name);

test('init --list', () => {
  const out = cli('init', '--list');
  for (const t of ['hello', 'typescript', 'd1', 'durable-object']) assert.match(out, new RegExp(`^${t} `, 'm'));
});

async function run(dir, args, fn) {
  const port = await freePort();
  const rc = await start({ args: ['dev', dir, '--port', String(port), '--state', join(dir, '.rucloud'), ...args], ready: `http://127.0.0.1:${port}/` });
  try { await fn(`http://127.0.0.1:${port}`); } finally { await rc.stop(); }
}

test('hello 範本', async () => {
  const dir = fresh('hello-app');
  assert.match(cli('init', dir), /已用 hello 範本建立 hello-app/);
  assert.ok(existsSync(join(dir, '.gitignore')));
  await run(dir, [], async (u) => {
    assert.match(await (await fetch(`${u}/`)).text(), /<title>hello-app<\/title>/);
    assert.deepEqual((await json(`${u}/api/hello?name=阿明`)).body, { message: '哈囉，阿明' });
  });
});

test('typescript 範本 + rucloud types', async () => {
  const dir = fresh('ts-app');
  cli('init', dir, '-t', 'typescript');
  cli('types', dir);
  const dts = readFileSync(join(dir, 'worker-configuration.d.ts'), 'utf8');
  assert.match(dts, /interface Env \{\n {2}KV: KVNamespace;\n\}/);
  await run(dir, [], async (u) => {
    assert.deepEqual((await json(`${u}/x`)).body, { path: '/x', visits: 1 });
    assert.deepEqual((await json(`${u}/x`)).body, { path: '/x', visits: 2 });
  });
});

test('d1 範本（migrations）', async () => {
  const dir = fresh('todo');
  cli('init', dir, '-t', 'd1');
  await run(dir, ['--d1-migrate'], async (u) => {
    const created = await json(`${u}/api/todos`, { method: 'POST', body: JSON.stringify({ text: '買牛奶' }), headers: { 'content-type': 'application/json' } });
    assert.equal(created.status, 201);
    assert.equal(created.body.text, '買牛奶');
    await fetch(`${u}/api/todos/${created.body.id}`, { method: 'PUT', body: JSON.stringify({ done: true }) });
    const list = (await json(`${u}/api/todos`)).body;
    assert.deepEqual(list.map((t) => [t.text, t.done]), [['買牛奶', 1]]);
    assert.match(await (await fetch(`${u}/`)).text(), /待辦清單/);
  });
});

test('durable-object 範本', async () => {
  const dir = fresh('counter');
  cli('init', dir, '-t', 'durable-object');
  await run(dir, [], async (u) => {
    await Promise.all(Array.from({ length: 20 }, () => fetch(`${u}/a`, { method: 'POST' })));
    assert.deepEqual((await json(`${u}/a`)).body, { name: 'a', value: 20 });
    assert.deepEqual((await json(`${u}/b`)).body, { name: 'b', value: 0 });
  });
});

test('types：showcase 的所有綁定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-types-'));
  const out = join(dir, 'env.d.ts');
  cli('types', 'examples/showcase', '-o', out);
  const t = readFileSync(out, 'utf8');
  for (const line of ['DB: D1Database;', 'KV: KVNamespace;', 'FILES: R2Bucket;', 'JOBS: Queue;', 'VECTORS: VectorizeIndex;',
    'LIMITER: RateLimit;', 'HELLO: Fetcher;', 'ASSETS: Fetcher;', 'GREETING: "哈囉";']) {
    assert.ok(t.includes(`  ${line}`), `少了 ${line}\n${t}`);
  }
  assert.match(t, /COUNTER: DurableObjectNamespace<import\(".*examples\/showcase\/src\/worker"\)\.Counter>;/);
});

test('init 不覆蓋已有內容', () => {
  const dir = fresh('exists');
  cli('init', dir);
  assert.throws(() => cli('init', dir), /--force/);
});
