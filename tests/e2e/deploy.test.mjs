// 部署：上傳新版本、不停機切換、壞版本不會上線、rollback；Durable Object 逐出；備份與還原
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, start, freePort, json, cli, sleep } from './helpers.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BIN } from './helpers.mjs';

const run = promisify(execFile);
const rucloud = (...args) => run(BIN, args, { cwd: ROOT }).then((r) => r.stdout);

function variant(base, tag, body) {
  const dir = mkdtempSync(join(tmpdir(), `rc-${tag}-`));
  cpSync(base, dir, { recursive: true });
  const f = join(dir, 'src/worker.js');
  writeFileSync(f, body ?? readFileSync(f, 'utf8').replace("from: 'hello'", `from: '${tag}'`));
  return dir;
}

test('deploy、不停機切換、壞版本、rollback、密鑰留在原處', async () => {
  const src = variant(join(ROOT, 'examples/hello'), 'hello');
  writeFileSync(join(src, 'src/worker.js'), "export default { fetch: (r, env) => Response.json({ from: 'hello', secret: env.SECRET ?? null }) };\n");
  writeFileSync(join(src, '.dev.vars'), 'SECRET=abc\n');
  const [port, admin] = [await freePort(), await freePort()];
  const rc = await start({
    toml: `shutdown_timeout = 2\n[admin]\nport = ${admin}\n[[app]]\npath = "${src}"\nport = ${port}\ninstances = 2\n`,
    ready: [`http://127.0.0.1:${port}/`, `http://127.0.0.1:${admin}/health`],
  });
  const A = ['--admin', `http://127.0.0.1:${admin}`];
  const get = async () => (await json(`http://127.0.0.1:${port}/`)).body;
  try {
    assert.deepEqual(await get(), { from: 'hello', secret: 'abc' });
    assert.match(await rucloud('versions', 'hello', ...A), /^\* （設定檔的 path）/);

    // 部署 v2 的同時持續打請求：一個都不能失敗
    const v2 = variant(src, 'v2', "export default { fetch: (r, env) => Response.json({ from: 'v2', secret: env.SECRET ?? null }) };\n");
    let stop = false;
    const codes = [];
    const load = (async () => {
      while (!stop) codes.push(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status, () => 0));
    })();
    assert.match(await rucloud('deploy', v2, '--app', 'hello', '-m', '第二版', ...A), /已部署 hello 版本/);
    await sleep(300);
    stop = true;
    await load;
    assert.ok(codes.length > 10);
    assert.deepEqual([...new Set(codes)], [200], '切換期間不能有失敗的請求');
    assert.deepEqual(await get(), { from: 'v2', secret: 'abc' }, '.dev.vars 不打包，密鑰仍從原本的資料夾讀');

    // 壞掉的版本：部署失敗，線上維持 v2
    const broken = variant(src, 'broken', 'export default { fetch( };\n');
    await assert.rejects(rucloud('deploy', broken, '--app', 'hello', ...A), /起不來/);
    assert.equal((await get()).from, 'v2');

    const list = await rucloud('versions', 'hello', ...A);
    assert.match(list, /^\* \S+ .* 第二版$/m);

    // rollback：回到設定檔的 path
    await rucloud('rollback', 'hello', ...A);
    assert.equal((await get()).from, 'hello');
    // 再切回 v2
    const id = list.match(/^\* (\S+)/m)[1];
    await rucloud('rollback', 'hello', '--to', id, ...A);
    assert.equal((await get()).from, 'v2');
    // reload 維持目前版本
    await rucloud('reload', 'hello', ...A);
    assert.equal((await get()).from, 'v2');
  } finally {
    await rc.stop();
  }
});

test('重啟後仍跑部署的版本', async () => {
  const src = variant(join(ROOT, 'examples/hello'), 'hello');
  const [port, admin] = [await freePort(), await freePort()];
  const toml = `[admin]\nport = ${admin}\n[[app]]\npath = "${src}"\nport = ${port}\n`;
  const state = mkdtempSync(join(tmpdir(), 'rc-state-'));
  const cfg = join(state, 'rucloud.toml');
  writeFileSync(cfg, `state_dir = "${join(state, 's')}"\n${toml}`);
  let rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${admin}/health` });
  await rucloud('deploy', variant(src, 'deployed'), '--app', 'hello', '--admin', `http://127.0.0.1:${admin}`);
  await rc.stop();
  rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${port}/` });
  try {
    assert.equal((await json(`http://127.0.0.1:${port}/`)).body.from, 'deployed');
  } finally {
    await rc.stop();
    rmSync(state, { recursive: true, force: true });
  }
});

test('閒置的 Durable Object 會被逐出，資料還在', async () => {
  const port = await freePort();
  const rc = await start({
    toml: `[[app]]\npath = "${ROOT}/tests/fixtures/evict"\nport = ${port}\ndo_idle_ms = 300\n`,
    ready: `http://127.0.0.1:${port}/`,
  });
  try {
    const a = (await json(`http://127.0.0.1:${port}/`)).body;
    const b = (await json(`http://127.0.0.1:${port}/`)).body;
    assert.equal(b.created, a.created, '連續使用不會重建');
    await sleep(1500);
    const c = (await json(`http://127.0.0.1:${port}/`)).body;
    assert.equal(c.created, b.created + 1, '閒置後重建');
    assert.equal(c.hits, b.hits + 1, 'SQLite 的資料還在');
  } finally {
    await rc.stop();
  }
});

test('backup / restore', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rc-bk-'));
  const [state, restored, out] = [join(tmp, 's'), join(tmp, 'r'), join(tmp, 'b.tar.gz')];
  const app = 'examples/showcase';
  cli('kv', 'put', app, 'k', 'v1', '--binding', 'KV', '--state', state);
  cli('d1', 'execute', app, 'DB', '--command', 'CREATE TABLE t (x); ', '--state', state);
  cli('d1', 'execute', app, 'DB', '--command', "INSERT INTO t VALUES ('saved')", '--state', state);
  assert.match(cli('backup', '--state', state, '-o', out), /已備份 \d+ 個資料庫/);
  cli('restore', out, '--state', restored);
  assert.equal(cli('kv', 'get', app, 'k', '--binding', 'KV', '--state', restored), 'v1');
  assert.match(cli('d1', 'execute', app, 'DB', '--command', 'SELECT x FROM t', '--state', restored), /saved/);
  assert.throws(() => cli('restore', out, '--state', restored), /--force/);
  rmSync(tmp, { recursive: true, force: true });
});
