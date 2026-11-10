// [dynamic]：透過管理 API 在執行中新增、更新、刪除應用；每個應用自己的 Worker 程序、沙箱與資料
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, start, freePort, sleep } from './helpers.mjs';

const ADMIN_TOKEN = 'admin-token-0123456789';
const DYN_TOKEN = 'dynamic-token-0123456789';

// 一個應用資料夾 → tar.gz
function pack(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-dyn-src-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return execFileSync('tar', ['-czf', '-', '-C', dir, '.']);
}

// 透過 edge 依 Host 呼叫（fetch 不能改 Host）
function edge(port, host, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, method, headers: { host, 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const notesApp = (version) => ({
  'wrangler.jsonc': JSON.stringify({
    name: 'ignored', main: 'src/worker.js', compatibility_date: '2025-11-01',
    assets: { directory: './public', run_worker_first: ['/api/*'] },
    d1_databases: [{ binding: 'DB', database_name: 'db', database_id: 'local' }],
    vars: { VERSION: version },
  }),
  'migrations/0001_init.sql': 'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT);',
  'public/index.html': `<h1>notes ${version}</h1>`,
  'src/worker.js': `
    import { readFileSync } from 'node:fs';
    export default {
      async fetch(request, env) {
        const u = new URL(request.url);
        if (u.pathname === '/api/notes' && request.method === 'POST') {
          const { text } = await request.json();
          await env.DB.prepare('INSERT INTO notes (text) VALUES (?)').bind(text).run();
        }
        if (u.pathname === '/api/notes') {
          return Response.json({ version: env.VERSION, notes: (await env.DB.prepare('SELECT text FROM notes ORDER BY id').all()).results.map((r) => r.text) });
        }
        if (u.pathname === '/api/probe') {
          let readOutside;
          try { readFileSync(${JSON.stringify(join(ROOT, 'Cargo.toml'))}); readOutside = true; } catch { readOutside = false; }
          return Response.json({
            pid: process.pid,
            envKeys: Object.keys(globalThis.__rucloud?.env || {}),
            readOutside,
          });
        }
        if (u.pathname === '/api/loop') for (;;) {}
        return new Response('not found', { status: 404 });
      },
    };`,
});

async function admin(port, path, { method = 'GET', body, token = ADMIN_TOKEN } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed };
}

test('執行中新增、更新、隔離、重新啟動後還在、刪除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-dyn-'));
  const [edgePort, adminPort, helloPort] = [await freePort(), await freePort(), await freePort()];
  const cfg = join(dir, 'rucloud.toml');
  writeFileSync(cfg, `state_dir = "${join(dir, 'state')}"
[edge]
port = ${edgePort}
[admin]
port = ${adminPort}
bind = "127.0.0.1"
token = "${ADMIN_TOKEN}"
[dynamic]
token = "${DYN_TOKEN}"
max_apps = 3
max_block_ms = 2000
[[app]]
path = "${ROOT}/examples/hello"
port = ${helloPort}
`);
  let rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${helloPort}/` });
  try {
    // 新增：用 [dynamic] 的 token
    const created = await admin(adminPort, '/apps/gen-a?message=v1', { method: 'PUT', body: pack(notesApp('v1')), token: DYN_TOKEN });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.created, true);
    assert.equal((await edge(edgePort, 'gen-a.localhost', '/')).body, '<h1>notes v1</h1>');
    await edge(edgePort, 'gen-a.localhost', '/api/notes', { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
    assert.deepEqual((await edge(edgePort, 'gen-a.localhost', '/api/notes')).body, { version: 'v1', notes: ['hello'] });

    // 更新：新版本，資料還在
    const updated = await admin(adminPort, '/apps/gen-a', { method: 'PUT', body: pack(notesApp('v2')), token: DYN_TOKEN });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.created, false);
    assert.deepEqual((await edge(edgePort, 'gen-a.localhost', '/api/notes')).body, { version: 'v2', notes: ['hello'] });

    // 第二個應用：自己的程序、自己的資料庫；看不到其他應用的 env，也讀不到資料夾外面的檔案
    assert.equal((await admin(adminPort, '/apps/gen-b', { method: 'PUT', body: pack(notesApp('b')), token: DYN_TOKEN })).status, 201);
    assert.deepEqual((await edge(edgePort, 'gen-b.localhost', '/api/notes')).body, { version: 'b', notes: [] });
    const [pa, pb] = [(await edge(edgePort, 'gen-a.localhost', '/api/probe')).body, (await edge(edgePort, 'gen-b.localhost', '/api/probe')).body];
    assert.notEqual(pa.pid, pb.pid, '不同的 Worker 程序');
    assert.deepEqual(pa.envKeys.sort(), ['DB', 'VERSION']);
    assert.equal(pa.readOutside, false, '沙箱：讀不到應用資料夾外的檔案');

    // 一個卡住只重開它自己
    const loop = edge(edgePort, 'gen-b.localhost', '/api/loop').catch(() => ({ status: 0 }));
    await sleep(300);
    const t0 = Date.now();
    assert.equal((await edge(edgePort, 'gen-a.localhost', '/api/notes')).status, 200);
    assert.ok(Date.now() - t0 < 500, 'gen-a 不受影響');
    assert.notEqual((await loop).status, 200);

    // 拒絕的情況
    const bad = async (path, body, token, status, re) => {
      const r = await admin(adminPort, path, { method: 'PUT', body, token });
      assert.equal(r.status, status, `${path}: ${JSON.stringify(r.body)}`);
      if (re) assert.match(JSON.stringify(r.body), re);
    };
    await bad('/apps/hello', pack(notesApp('x')), ADMIN_TOKEN, 400, /必須以 gen- 開頭/);
    await bad('/apps/hello', pack(notesApp('x')), DYN_TOKEN, 403);
    await bad('/apps/gen-x', pack(notesApp('x')), 'wrong-token', 401);
    await bad('/apps/gen-Bad_Name', pack(notesApp('x')), DYN_TOKEN, 400, /小寫英文/);
    const withService = notesApp('x');
    withService['wrangler.jsonc'] = JSON.stringify({ main: 'src/worker.js', services: [{ binding: 'H', service: 'hello' }] });
    await bad('/apps/gen-x', pack(withService), DYN_TOKEN, 400, /services/);
    const escape = notesApp('x');
    escape['wrangler.jsonc'] = JSON.stringify({ main: 'src/worker.js', assets: { directory: '../../hello' } });
    await bad('/apps/gen-x', pack(escape), DYN_TOKEN, 400, /assets\.directory/);
    const broken = notesApp('x');
    broken['src/worker.js'] = 'export default {';
    await bad('/apps/gen-x', pack(broken), DYN_TOKEN, 400, /起不來/);
    assert.equal(existsSync(join(dir, 'state', 'gen-x')), false, '失敗的新增不留下資料夾');
    assert.equal((await admin(adminPort, '/apps/gen-c', { method: 'PUT', body: pack(notesApp('c')), token: DYN_TOKEN })).status, 201);
    await bad('/apps/gen-d', pack(notesApp('d')), DYN_TOKEN, 400, /max_apps/);
    // [dynamic] 的 token 不能做別的事
    assert.equal((await admin(adminPort, '/stats', { token: DYN_TOKEN })).status, 403);
    assert.equal((await admin(adminPort, '/apps/hello/logs', { token: DYN_TOKEN })).status, 403);
    assert.equal((await admin(adminPort, '/apps/gen-a/versions', { token: DYN_TOKEN })).status, 200);
    assert.equal((await admin(adminPort, '/apps/hello', { method: 'DELETE' })).status, 400, '設定檔的應用不能刪');
    const list = (await admin(adminPort, '/apps')).body;
    assert.deepEqual(list.filter((a) => a.dynamic).map((a) => a.name), ['gen-a', 'gen-b', 'gen-c']);
  } finally {
    await rc.stop();
  }

  // 重新啟動：執行中新增的應用與資料都還在
  rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${helloPort}/` });
  try {
    assert.deepEqual((await edge(edgePort, 'gen-a.localhost', '/api/notes')).body, { version: 'v2', notes: ['hello'] });
    // 刪除（含資料）
    assert.equal((await admin(adminPort, '/apps/gen-a?purge=true', { method: 'DELETE', token: DYN_TOKEN })).status, 200);
    assert.equal((await edge(edgePort, 'gen-a.localhost', '/api/notes')).status, 404);
    assert.equal(existsSync(join(dir, 'state', 'gen-a')), false);
    assert.equal((await edge(edgePort, 'gen-b.localhost', '/api/notes')).status, 200);
  } finally {
    await rc.stop();
  }
});

test('grant：被授權的應用拿到管理網址與 token；沒設管理 token 時自動產生', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-dyn-grant-'));
  const app = (name) => {
    const d = join(dir, name);
    mkdirSync(join(d, 'src'), { recursive: true });
    writeFileSync(join(d, 'wrangler.jsonc'), JSON.stringify({ name, main: 'src/worker.js' }));
    writeFileSync(join(d, 'src/worker.js'), 'export default { fetch: (r, env) => Response.json({ url: env.RUCLOUD_ADMIN_URL ?? null, token: env.RUCLOUD_DYNAMIC_TOKEN ?? null }) };');
    return d;
  };
  const [edgePort, adminPort, p1, p2] = [await freePort(), await freePort(), await freePort(), await freePort()];
  const cfg = join(dir, 'rucloud.toml');
  writeFileSync(cfg, `state_dir = "${join(dir, 'state')}"
[edge]
port = ${edgePort}
[admin]
port = ${adminPort}
bind = "127.0.0.1"
[dynamic]
grant = ["builder"]
[[app]]
path = "${app('builder')}"
port = ${p1}
[[app]]
path = "${app('other')}"
port = ${p2}
`);
  const rc = await start({ args: ['serve', cfg], ready: [`http://127.0.0.1:${p1}/`, `http://127.0.0.1:${p2}/`] });
  try {
    const granted = await (await fetch(`http://127.0.0.1:${p1}/`)).json();
    assert.equal(granted.url, `http://127.0.0.1:${adminPort}`);
    assert.match(granted.token, /^[0-9a-f]{32}$/);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${p2}/`)).json(), { url: null, token: null }, '沒被授權的應用拿不到');
    // 自動產生的管理 token：沒帶 token 不行
    assert.equal((await admin(adminPort, '/stats', { token: null })).status, 401);
    assert.ok(existsSync(join(dir, 'state', 'admin-token')));
    // 用拿到的 token 新增應用
    const r = await admin(adminPort, '/apps/gen-x', { method: 'PUT', body: pack(notesApp('x')), token: granted.token });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual((await edge(edgePort, 'gen-x.localhost', '/api/notes')).body, { version: 'x', notes: [] });
  } finally {
    await rc.stop();
  }
});
