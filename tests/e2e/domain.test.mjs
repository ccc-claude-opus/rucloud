// 網域：[domain] 自動子網域、wrangler 的 routes、網域衝突；trusted_proxies（真實 IP 與協定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, freePort, BIN, ROOT } from './helpers.mjs';
import { spawnSync } from 'node:child_process';

// 回傳 Worker 看到的網址與 IP 標頭
function echoApp(dir, name, extra = {}) {
  const d = join(dir, name);
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'wrangler.jsonc'), JSON.stringify({ name, main: 'src/worker.js', ...extra }));
  writeFileSync(join(d, 'src/worker.js'), `export default { fetch: (r) => Response.json({
    app: ${JSON.stringify(name)}, url: r.url,
    ip: r.headers.get('cf-connecting-ip'), xff: r.headers.get('x-forwarded-for'), proto: r.headers.get('x-forwarded-proto') }) };`);
  return d;
}

function get(port, host, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ port, path: '/p?q=1', headers: { host, ...headers } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let body = data;
        try { body = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, body });
      });
    }).on('error', reject);
  });
}

test('[domain]、routes、trusted_proxies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-domain-'));
  const edge = await freePort();
  const shop = echoApp(dir, 'shop', { routes: [{ pattern: 'www.shop.test', custom_domain: true }, 'buy.shop.test/*', '*.wild.test/*'] });
  const blog = echoApp(dir, 'blog');
  const rc = await start({
    toml: `[edge]\nport = ${edge}\n[domain]\nbase = "example.test"\nroot = "blog"\n` +
      `[[app]]\npath = "${shop}"\n[[app]]\npath = "${blog}"\nhosts = ["news.test"]\n`,
    ready: `http://127.0.0.1:${edge}/`,
  });
  try {
    const app = async (host) => (await get(edge, host)).body.app;
    assert.equal(await app('shop.example.test'), 'shop', '[domain] 自動子網域');
    assert.equal(await app('blog.example.test'), 'blog');
    assert.equal(await app('example.test'), 'blog', '[domain] root');
    assert.equal(await app('www.shop.test'), 'shop', 'routes 的 custom_domain');
    assert.equal(await app('buy.shop.test:8080'), 'shop', 'routes 的 pattern（含埠號）');
    assert.equal(await app('news.test'), 'blog', 'rucloud.toml 的 hosts');
    assert.equal(await app('SHOP.Example.Test'), 'shop', '不分大小寫');

    // 本機是預設信任的代理：採用 X-Forwarded-For / Proto
    const viaProxy = (await get(edge, 'shop.example.test', { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' })).body;
    assert.equal(viaProxy.ip, '198.51.100.7');
    assert.equal(viaProxy.url, 'https://shop.example.test/p?q=1');
    assert.equal(viaProxy.proto, 'https');
    // 偽造的最左邊不算
    assert.equal((await get(edge, 'shop.example.test', { 'x-forwarded-for': '6.6.6.6, 198.51.100.9' })).body.ip, '198.51.100.9');
  } finally {
    await rc.stop();
  }
});

test('trusted_proxies 不包含本機時，不信任別人帶的標頭', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-domain2-'));
  const edge = await freePort();
  const rc = await start({
    toml: `trusted_proxies = ["10.0.0.0/8"]\n[edge]\nport = ${edge}\n[[app]]\npath = "${echoApp(dir, 'a')}"\n`,
    ready: `http://127.0.0.1:${edge}/`,
  });
  try {
    const b = (await get(edge, 'a.localhost', { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https', 'cf-connecting-ip': '6.6.6.6' })).body;
    assert.equal(b.ip, '127.0.0.1');
    assert.equal(b.xff, '127.0.0.1');
    assert.equal(b.url, 'http://a.localhost/p?q=1');
    assert.equal(b.proto, 'http');
  } finally {
    await rc.stop();
  }
});

test('兩個應用搶同一個網域：拒絕啟動', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-domain3-'));
  const cfg = join(dir, 'rucloud.toml');
  writeFileSync(cfg, `state_dir = "${join(dir, 'state')}"\n` +
    `[[app]]\npath = "${echoApp(dir, 'x', { routes: ['same.test/*'] })}"\nport = 1\n` +
    `[[app]]\npath = "${echoApp(dir, 'y')}"\nhosts = ["same.test"]\nport = 2\n`);
  const r = spawnSync(BIN, ['serve', cfg], { cwd: ROOT, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /網域 same\.test 已經給了應用/);
});
