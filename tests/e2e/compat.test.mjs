// wrangler 相容：wrangler.toml、env、TypeScript、模組規則、migrations、kv / r2 / d1 指令
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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

test('npm 套件：node_modules 裡的套件照 wrangler 的 exports 條件（workerd）載入', async () => {
  const app = mkdtempSync(join(tmpdir(), 'rc-npm-'));
  const files = {
    'wrangler.jsonc': JSON.stringify({ name: 'npmapp', main: 'src/index.js' }),
    'src/index.js': "import which from 'cond-pkg'; import { n } from '@scope/plain'; export default { fetch: () => Response.json({ which, n }) };",
    'node_modules/cond-pkg/package.json': JSON.stringify({ name: 'cond-pkg', type: 'module', exports: { workerd: './w.js', node: './n.js', default: './d.js' } }),
    'node_modules/cond-pkg/w.js': "export default 'workerd';",
    'node_modules/cond-pkg/n.js': "export default 'node';",
    'node_modules/cond-pkg/d.js': "export default 'default';",
    'node_modules/@scope/plain/package.json': JSON.stringify({ name: '@scope/plain', main: 'index.js' }),
    'node_modules/@scope/plain/index.js': 'exports.n = 7;',
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(app, p, '..'), { recursive: true });
    writeFileSync(join(app, p), c);
  }
  const port = await freePort();
  const rc = await start({ args: ['dev', app, '--port', String(port), '--state', join(app, '.state')], ready: `http://127.0.0.1:${port}/` });
  try {
    assert.deepEqual((await json(`http://127.0.0.1:${port}/`)).body, { which: 'workerd', n: 7 });
  } finally {
    await rc.stop();
    rmSync(app, { recursive: true, force: true });
  }
});

test('Images 綁定：info、transform、draw、output', async () => {
  const app = mkdtempSync(join(tmpdir(), 'rc-img-'));
  const files = {
    'wrangler.jsonc': JSON.stringify({ name: 'imgapp', main: 'src/index.js', images: { binding: 'IMAGES' } }),
    'src/index.js': `export default {
      async fetch(req, env) {
        const u = new URL(req.url);
        const src = () => new Response(req.body).body;
        if (u.pathname === '/info') return Response.json(await env.IMAGES.info(src()));
        if (u.pathname === '/thumb') {
          const r = await env.IMAGES.input(src()).transform({ width: 2 }).transform({ rotate: 90 }).output({ format: 'image/webp' });
          return r.response();
        }
        if (u.pathname === '/draw') {
          const body = new Uint8Array(await req.arrayBuffer());
          const r = await env.IMAGES.input(body).draw(env.IMAGES.input(body).transform({ width: 2, fit: 'squeeze', height: 2 }), { top: 0, left: 0 }).output({ format: 'image/png' });
          return Response.json(await env.IMAGES.info(r.image()));
        }
        if (u.pathname === '/avif') {
          try { await env.IMAGES.input(src()).output({ format: 'image/avif' }); return new Response('no error'); } catch (e) { return new Response(e.message, { status: 400 }); }
        }
        return new Response('?', { status: 404 });
      },
    };`,
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(app, p, '..'), { recursive: true });
    writeFileSync(join(app, p), c);
  }
  // 4×2 的 PNG：左半紅、右半藍
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAIAAADwyuo0AAAAE0lEQVR4nGP4z8AARGDiPwMyBwBnsgf5Q2OaZwAAAABJRU5ErkJggg==', 'base64');
  const port = await freePort();
  const rc = await start({ args: ['dev', app, '--port', String(port), '--state', join(app, '.state')], ready: `http://127.0.0.1:${port}/` });
  const post = (path) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: png });
  try {
    assert.deepEqual(await (await post('/info')).json(), { format: 'image/png', fileSize: png.length, width: 4, height: 2 });
    const thumb = await post('/thumb');
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    const bytes = Buffer.from(await thumb.arrayBuffer());
    assert.equal(bytes.subarray(8, 12).toString(), 'WEBP');
    const drawn = await (await post('/draw')).json();
    assert.deepEqual([drawn.format, drawn.width, drawn.height], ['image/png', 4, 2]);
    const avif = await post('/avif');
    assert.equal(avif.status, 400);
    assert.match(await avif.text(), /AVIF/);
  } finally {
    await rc.stop();
    rmSync(app, { recursive: true, force: true });
  }
});
