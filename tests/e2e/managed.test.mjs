// 像 wrangler deploy：部署時自動新增應用、rucloud secret、rucloud delete；管理 API 透過 HTTPS 的網域對外
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN, ROOT, start, freePort } from './helpers.mjs';

const TOKEN = 'admin-token-0123456789';

function rucloud(args, input) {
  const r = spawnSync(BIN, args, { cwd: ROOT, encoding: 'utf8', input, env: { ...process.env, RUCLOUD_ADMIN_TOKEN: TOKEN } });
  return { code: r.status, out: r.stdout + r.stderr };
}

function get(port, host, path = '/') {
  return new Promise((resolve, reject) => {
    http.get({ port, path, headers: { host } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function blogApp(dir) {
  const d = join(dir, 'blog');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'wrangler.jsonc'), JSON.stringify({
    name: 'blog', main: 'src/worker.js', routes: [{ pattern: 'myblog.test', custom_domain: true }],
    kv_namespaces: [{ binding: 'KV', id: 'local' }], services: [{ binding: 'HELLO', service: 'hello' }],
  }));
  writeFileSync(join(d, 'src/worker.js'), `export default { async fetch(r, env) {
    const n = Number(await env.KV.get('n') || 0) + 1; await env.KV.put('n', String(n));
    const hello = await (await env.HELLO.fetch('http://hello/')).text();
    return Response.json({ n, secret: env.API_KEY ?? null, hello: hello.length > 0 });
  } };`);
  writeFileSync(join(d, '.dev.vars'), 'API_KEY=from-dev-vars-should-not-upload\n');
  return d;
}

test('rucloud deploy 新增應用、secret、delete、重新啟動後還在', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-managed-'));
  const [edge, adminPort, helloPort] = [await freePort(), await freePort(), await freePort()];
  const cfg = join(dir, 'rucloud.toml');
  writeFileSync(cfg, `state_dir = "${join(dir, 'state')}"\n[edge]\nport = ${edge}\n[domain]\nbase = "example.test"\n` +
    `[admin]\nport = ${adminPort}\ntoken = "${TOKEN}"\n[[app]]\npath = "${ROOT}/examples/hello"\nport = ${helloPort}\n`);
  const admin = ['--admin', `http://127.0.0.1:${adminPort}`];
  let rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${helloPort}/` });
  try {
    const app = blogApp(dir);
    const d = rucloud(['deploy', app, ...admin, '-m', 'first']);
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /已新增應用 blog/);
    assert.match(d.out, /http:\/\/blog\.example\.test\//);
    assert.match(d.out, /http:\/\/myblog\.test\//, 'routes 的網域');
    // 自己的程式碼：service binding、KV 都能用；.dev.vars 不會被上傳
    assert.deepEqual(JSON.parse((await get(edge, 'blog.example.test')).body), { n: 1, secret: null, hello: true });
    assert.equal(JSON.parse((await get(edge, 'myblog.test')).body).n, 2);

    // 密鑰：值從標準輸入讀，只寫不讀
    let r = rucloud(['secret', 'put', 'blog', 'API_KEY', ...admin], 'sk-test-123\n');
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse((await get(edge, 'blog.example.test')).body).secret, 'sk-test-123');
    r = rucloud(['secret', 'list', 'blog', ...admin]);
    assert.equal(r.out.trim(), 'API_KEY');
    assert.ok(!JSON.stringify(await (await fetch(`http://127.0.0.1:${adminPort}/apps/blog/secrets`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()).includes('sk-test'));
    const mode = (readFileSync(join(dir, 'state', 'blog', 'secrets.json')) && execFileSync('stat', process.platform === 'darwin' ? ['-f', '%Lp', join(dir, 'state', 'blog', 'secrets.json')] : ['-c', '%a', join(dir, 'state', 'blog', 'secrets.json')]).toString().trim());
    assert.equal(mode, '600');
    assert.notEqual(rucloud(['secret', 'put', 'blog', 'bad-name', ...admin], 'x').code, 0);

    // 再部署一次：資料還在
    assert.match(rucloud(['deploy', app, ...admin]).out, /已部署 blog 版本/);
    assert.equal(JSON.parse((await get(edge, 'blog.example.test')).body).n, 4);
    assert.notEqual(rucloud(['delete', 'hello', ...admin]).code, 0, 'rucloud.toml 的應用不能刪');
  } finally {
    await rc.stop();
  }
  // 重新啟動：應用、資料、密鑰都還在
  rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${helloPort}/` });
  try {
    const b = JSON.parse((await get(edge, 'blog.example.test')).body);
    assert.equal(b.n, 5);
    assert.equal(b.secret, 'sk-test-123');
    const r = rucloud(['delete', 'blog', '--purge', ...admin]);
    assert.equal(r.code, 0, r.out);
    assert.equal((await get(edge, 'myblog.test')).status, 404);
    assert.equal(existsSync(join(dir, 'state', 'blog')), false);
  } finally {
    await rc.stop();
  }
});

test('[admin] host：管理 API 只透過 HTTPS 的網域對外', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-adminhost-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '2', '-subj', '/CN=admin.example.test',
    '-addext', 'subjectAltName=DNS:admin.example.test,DNS:hello.example.test'], { cwd: dir, stdio: 'pipe' });
  const [edge, tls, adminPort] = [await freePort(), await freePort(), await freePort()];
  const rc = await start({
    toml: `[edge]\nport = ${edge}\n[domain]\nbase = "example.test"\n[admin]\nport = ${adminPort}\nhost = "admin.example.test"\n` +
      `[tls]\nport = ${tls}\ncert = "${join(dir, 'cert.pem')}"\nkey = "${join(dir, 'key.pem')}"\n[[app]]\npath = "${ROOT}/examples/hello"\n`,
    ready: `http://127.0.0.1:${edge}/`,
  });
  try {
    const ca = readFileSync(join(dir, 'cert.pem'));
    const req = (host, path, token) => new Promise((resolve, reject) => {
      https.get({ hostname: '127.0.0.1', port: tls, path, servername: host, ca, headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
        let data = '';
        res.on('data', (d) => { data += d; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }).on('error', reject);
    });
    // 沒設 token 也會自動產生
    const token = readFileSync(join(rc.state, 'admin-token'), 'utf8').trim();
    assert.equal((await req('admin.example.test', '/apps')).status, 401);
    const apps = JSON.parse((await req('admin.example.test', '/apps', token)).body);
    assert.deepEqual(apps.map((a) => a.name), ['hello']);
    assert.match((await req('hello.example.test', '/')).body, /.+/, '其他網域照常');
    // HTTP 的 edge 不提供管理 API
    assert.equal((await get(edge, 'admin.example.test', '/apps')).status, 404);
  } finally {
    await rc.stop();
  }
});
