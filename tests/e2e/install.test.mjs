// [install]：安裝的應用。安裝程式用 [install] 的 token 以應用自己的名稱新增、更新、移除，
// 權限（綁定到系統應用的 service binding 與 props、對外連線）由 PUT /apps/<名稱>/grants 給
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, freePort } from './helpers.mjs';

const ADMIN_TOKEN = 'admin-token-0123456789';
const INSTALL_TOKEN = 'install-token-0123456789';

function pack(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-inst-src-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return execFileSync('tar', ['-czf', '-', '-C', dir, '.']);
}

function edge(port, host, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path, headers: { host, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed = data;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function admin(port, path, { method = 'GET', body, token = INSTALL_TOKEN, json } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (json) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: json ? JSON.stringify(json) : body, headers });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed };
}

// 系統應用：回報呼叫它的 service binding 帶來的 props
function systemApp(dir, name) {
  const d = join(dir, name);
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'wrangler.jsonc'), JSON.stringify({ name, main: 'src/worker.js' }));
  writeFileSync(join(d, 'src/worker.js'), `export default {
    fetch: (r, env, ctx) => Response.json({ app: ${JSON.stringify(name)}, props: ctx.props, token: env.RUCLOUD_INSTALL_TOKEN ?? null }),
  };`);
  return d;
}

const notes = (version, edgePort) => ({
  'wrangler.jsonc': JSON.stringify({ name: 'whatever', main: 'src/worker.js', vars: { VERSION: version } }),
  'src/worker.js': `export default {
    async fetch(request, env) {
      const u = new URL(request.url);
      if (u.pathname === '/files') return env.FILES ? env.FILES.fetch('http://files/whoami') : Response.json({ files: null });
      if (u.pathname === '/net') {
        const out = {};
        try { out.fetch = (await fetch('http://127.0.0.1:${edgePort}/', { headers: { host: 'files.localhost' } })).status; } catch (e) { out.fetch = e.message; }
        try { await import('node:http'); out.http = 'ok'; } catch (e) { out.http = e.message; }
        try { const { connect } = await import('cloudflare:sockets'); connect('127.0.0.1:${edgePort}'); out.connect = 'ok'; } catch (e) { out.connect = e.message; }
        return Response.json(out);
      }
      return Response.json({ version: env.VERSION, env: Object.keys(env).sort() });
    },
  };`,
});

test('安裝、權限、props、對外連線、重新啟動、移除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-inst-'));
  const [edgePort, adminPort, filesPort] = [await freePort(), await freePort(), await freePort()];
  const cfg = join(dir, 'rucloud.toml');
  writeFileSync(cfg, `state_dir = "${join(dir, 'state')}"
[edge]
port = ${edgePort}
[admin]
port = ${adminPort}
bind = "127.0.0.1"
token = "${ADMIN_TOKEN}"
[install]
token = "${INSTALL_TOKEN}"
grant = ["installer"]
services = ["files"]
max_apps = 2
[[app]]
path = "${systemApp(dir, 'files')}"
port = ${filesPort}
[[app]]
path = "${systemApp(dir, 'installer')}"
[[app]]
path = "${systemApp(dir, 'hello')}"
`);
  let rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${filesPort}/` });
  try {
    // 安裝程式拿到 token，其他應用沒有
    assert.equal((await edge(edgePort, 'installer.localhost', '/')).body.token, INSTALL_TOKEN);
    assert.equal((await edge(edgePort, 'hello.localhost', '/')).body.token, null);

    // 安裝：用自己的名稱，一開始沒有任何權限
    const created = await admin(adminPort, '/apps/notes?message=1.0', { method: 'PUT', body: pack(notes('1.0', edgePort)) });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual((await edge(edgePort, 'notes.localhost', '/')).body, { version: '1.0', env: ['VERSION'] });
    assert.deepEqual((await admin(adminPort, '/apps/notes/grants')).body, { services: [], network: false });
    const net = (await edge(edgePort, 'notes.localhost', '/net')).body;
    assert.match(net.fetch, /沒有連線到外部網路的權限/);
    assert.match(net.http, /沒有連線到外部網路的權限/);
    assert.match(net.connect, /沒有連線到外部網路的權限/);

    // 給權限：綁定到 files，props 說明是誰、什麼權限；並允許對外連線
    const props = { app: 'notes', perms: ['files:read'] };
    const granted = await admin(adminPort, '/apps/notes/grants', { method: 'PUT', json: { services: [{ binding: 'FILES', service: 'files', props }], network: true } });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.deepEqual((await edge(edgePort, 'notes.localhost', '/files')).body, { app: 'files', props, token: null });
    // 有網路權限也只能連網際網路：本機（例如這台機器上的其他應用）、區網都擋下
    const net2 = (await edge(edgePort, 'notes.localhost', '/net')).body;
    assert.match(net2.fetch, /只能連到網際網路上的位址/);
    assert.match(net2.http, /請用 fetch 或 WebSocket/);
    assert.match(net2.connect, /請用 fetch 或 WebSocket/);
    // 外來的請求偽造不了 props
    assert.deepEqual((await edge(edgePort, 'files.localhost', '/', { 'x-rucloud-props': '{"app":"evil"}' })).body.props, {});

    // 更新：權限與版本
    const updated = await admin(adminPort, '/apps/notes', { method: 'PUT', body: pack(notes('1.1', edgePort)) });
    assert.equal(updated.status, 200);
    assert.deepEqual((await edge(edgePort, 'notes.localhost', '/')).body, { version: '1.1', env: ['FILES', 'VERSION'] });

    // 拒絕的情況
    const put = (path, body, token) => admin(adminPort, path, { method: 'PUT', body, token });
    assert.equal((await put('/apps/files', pack(notes('x', edgePort)))).status, 403, '不能用系統應用的名稱');
    assert.equal((await put('/apps/notes', pack(notes('x', edgePort)), 'wrong-token-0123456789')).status, 401);
    const withService = notes('x', edgePort);
    withService['wrangler.jsonc'] = JSON.stringify({ main: 'src/worker.js', services: [{ binding: 'H', service: 'hello' }] });
    assert.match(JSON.stringify((await put('/apps/other', pack(withService))).body), /services/, '套件自己不能宣告綁定');
    const g = (json) => admin(adminPort, '/apps/notes/grants', { method: 'PUT', json });
    assert.match(JSON.stringify((await g({ services: [{ binding: 'H', service: 'hello' }] })).body), /不在 \[install\] services/);
    assert.match(JSON.stringify((await g({ services: [{ binding: 'bad-name', service: 'files' }] })).body), /綁定名稱/);
    assert.equal((await admin(adminPort, '/apps/files/logs')).status, 403);
    assert.equal((await admin(adminPort, '/apps/files', { method: 'DELETE' })).status, 403);
    assert.equal((await admin(adminPort, '/apps/files/grants')).status, 403);
    assert.equal((await admin(adminPort, '/stats')).status, 403);
    assert.equal((await admin(adminPort, '/apps')).status, 200);
    // 安裝失敗時，原本就有的資料（例如之前移除時保留的）不能被刪
    mkdirSync(join(dir, 'state', 'kept', 'd1'), { recursive: true });
    writeFileSync(join(dir, 'state', 'kept', 'd1', 'db.sqlite'), 'old data');
    const broken = notes('x', edgePort);
    broken['src/worker.js'] = 'export default {';
    assert.match(JSON.stringify((await put('/apps/kept', pack(broken))).body), /起不來/);
    assert.equal(existsSync(join(dir, 'state', 'kept', 'd1', 'db.sqlite')), true, '舊資料還在');
    // 密鑰：安裝程式可以替安裝的應用設定
    assert.equal((await admin(adminPort, '/apps/notes/secrets/AUTH_SECRET', { method: 'PUT', body: 's3cret' })).status, 200);
    assert.equal((await admin(adminPort, '/apps/files/secrets/AUTH_SECRET', { method: 'PUT', body: 'x' })).status, 403);
    assert.deepEqual((await edge(edgePort, 'notes.localhost', '/')).body.env, ['AUTH_SECRET', 'FILES', 'VERSION']);
    assert.equal((await put('/apps/second', pack(notes('2', edgePort)))).status, 201);
    assert.match(JSON.stringify((await put('/apps/third', pack(notes('3', edgePort)))).body), /max_apps/);
    const list = (await admin(adminPort, '/apps')).body;
    assert.deepEqual(list.filter((a) => a.kind === 'installed').map((a) => a.name), ['notes', 'second']);
  } finally {
    await rc.stop();
  }

  // 重新啟動：安裝的應用與權限都還在
  rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${filesPort}/` });
  try {
    assert.deepEqual((await edge(edgePort, 'notes.localhost', '/')).body, { version: '1.1', env: ['AUTH_SECRET', 'FILES', 'VERSION'] });
    assert.equal((await admin(adminPort, '/apps/notes?purge=true', { method: 'DELETE' })).status, 200);
    assert.equal((await edge(edgePort, 'notes.localhost', '/')).status, 404);
    assert.equal(existsSync(join(dir, 'state', 'notes')), false);
    // 重新安裝：舊的權限不沿用
    assert.equal((await admin(adminPort, '/apps/second', { method: 'DELETE' })).status, 200);
    assert.equal((await admin(adminPort, '/apps/notes', { method: 'PUT', body: pack(notes('2.0', edgePort)) })).status, 201);
    assert.deepEqual((await admin(adminPort, '/apps/notes/grants')).body, { services: [], network: false });
  } finally {
    await rc.stop();
  }
});
