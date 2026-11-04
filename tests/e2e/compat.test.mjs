// wrangler 相容：wrangler.toml、env、TypeScript、模組規則、migrations、kv / r2 / d1 指令
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, start, freePort, json, cli } from './helpers.mjs';

test('wrangler.toml + TypeScript + 模組規則 + migrations + --env', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rc-compat-'));
  const app = join(tmp, 'tsapp');
  cpSync(join(ROOT, 'tests/fixtures/tsapp'), app, { recursive: true });
  const state = join(tmp, 'state');
  try {
    assert.match(cli('d1', 'migrations', 'list', app, 'DB', '--state', state), /· 0001_create_users\.sql\n· 0002_add_posts\.sql/);
    const port = await freePort();
    let rc = await start({ args: ['dev', app, '--port', String(port), '--state', state, '--d1-migrate'], ready: `http://127.0.0.1:${port}/` });
    try {
      const { body } = await json(`http://127.0.0.1:${port}/`);
      assert.deepEqual(body, {
        stage: 'dev', enum: 42, text: 'hello from txt', md: '# 標題', bin: [1, 2, 3], wasm: 5, sameModule: true, json: 3, tables: ['posts', 'users'],
      });
    } finally {
      await rc.stop();
    }
    assert.match(cli('d1', 'migrations', 'list', app, 'DB', '--state', state), /✓ 0001_create_users\.sql\n✓ 0002_add_posts\.sql/);
    const port2 = await freePort();
    rc = await start({ args: ['dev', app, '--port', String(port2), '--state', state, '--env', 'production'], ready: `http://127.0.0.1:${port2}/` });
    try {
      const { body } = await json(`http://127.0.0.1:${port2}/`);
      assert.equal(body.stage, 'production');
      assert.deepEqual(body.tables, [], 'production 用自己的資料庫');
    } finally {
      await rc.stop();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('rucloud kv / r2 / d1 指令', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'rc-cli-')), 's');
  const app = 'examples/showcase';
  cli('kv', 'put', app, 'k1', '值', '--binding', 'KV', '--state', state);
  cli('kv', 'put', app, 'k2', 'x', '--binding', 'KV', '--ttl', '60', '--state', state);
  assert.equal(cli('kv', 'get', app, 'k1', '--binding', 'KV', '--state', state), '值');
  assert.equal(cli('kv', 'list', app, '--binding', 'KV', '--state', state), 'k1\nk2\n');
  cli('kv', 'delete', app, 'k2', '--binding', 'KV', '--state', state);
  assert.equal(cli('kv', 'list', app, '--binding', 'KV', '--state', state), 'k1\n');
  const f = join(state, '..', 'f.txt');
  writeFileSync(f, 'r2 file');
  cli('r2', 'object', 'put', app, 'showcase-files/a/f.txt', '--file', f, '--state', state);
  assert.equal(cli('r2', 'object', 'get', app, 'showcase-files/a/f.txt', '--state', state), 'r2 file');
  assert.match(cli('r2', 'object', 'list', app, 'showcase-files', '--state', state), /7 {2}a\/f\.txt/);
  cli('d1', 'execute', app, 'DB', '--command', 'CREATE TABLE t (x)', '--state', state);
  assert.match(cli('d1', 'execute', app, 'DB', '--command', "SELECT name FROM sqlite_master WHERE name = 't'", '--state', state), /"t"/);
  assert.throws(() => cli('kv', 'get', app, 'nope', '--binding', 'KV', '--state', state));
});
