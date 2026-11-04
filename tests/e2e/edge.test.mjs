// 邊緣：閘道快取、跨程序的 Cache API、壓縮、HTTPS、HTTP 轉址
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, start, freePort, cli, sleep } from './helpers.mjs';

const text = async (u, init) => { const r = await fetch(u, init); return [r.status, await r.text(), r.headers]; };

test('閘道快取、Cache API、purge、壓縮', async () => {
  const [port, admin] = [await freePort(), await freePort()];
  const rc = await start({
    toml: `[admin]\nport = ${admin}\n[[app]]\npath = "${ROOT}/tests/fixtures/cachey"\nport = ${port}\ninstances = 2\ncache_mb = 1\n`,
    ready: `http://127.0.0.1:${port}/`,
  });
  const u = (p) => `http://127.0.0.1:${port}${p}`;
  try {
    const [, a, ha] = await text(u('/w/cached'));
    const [, b, hb] = await text(u('/w/cached'));
    assert.equal(ha.get('cf-cache-status'), 'MISS');
    assert.equal(hb.get('cf-cache-status'), 'HIT');
    assert.equal(a, b, '命中時不進 Worker');
    assert.ok(Number(hb.get('age')) >= 0);
    const [, , hq] = await text(u('/w/cached?x=1'));
    assert.equal(hq.get('cf-cache-status'), 'MISS', 'query 不同是不同的 key');
    const [, , hp] = await text(u('/w/private'));
    assert.equal(hp.get('cf-cache-status'), 'BYPASS');
    const [, big, hbig] = await text(u('/w/big'));
    assert.equal(big.length, 300_000);
    assert.equal(hbig.get('cf-cache-status'), 'BYPASS', '超過單筆上限');
    const [, , hauth] = await text(u('/w/cached'), { headers: { authorization: 'Bearer x' } });
    assert.equal(hauth.get('cf-cache-status'), null, '帶 Authorization 不走快取');

    // purge
    assert.match(cli('purge', 'cachey', '--admin', `http://127.0.0.1:${admin}`), /清掉 [1-9]/);
    const [, , hpurged] = await text(u('/w/cached'));
    assert.equal(hpurged.get('cf-cache-status'), 'MISS');

    // Cache API：兩個程序共用（帶 Authorization 繞過閘道快取，才會進到 Worker）
    const auth = { headers: { authorization: 'x' } };
    const first = (await text(u('/w/api-cache'), auth))[1];
    assert.match(first, /^made by pid \d+$/);
    for (let i = 0; i < 4; i++) assert.equal((await text(u('/w/api-cache'), auth))[1], `from cache: ${first}`);

    // 壓縮：靜態 HTML 會壓、SSE 不壓
    const [, html, hh] = await text(u('/'), { headers: { 'accept-encoding': 'br' } });
    assert.equal(hh.get('content-encoding'), 'br');
    assert.match(html, /壓縮測試/);
    const [, , hg] = await text(u('/'), { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(hg.get('content-encoding'), 'gzip');
    const [, , hs] = await text(u('/w/sse'), { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(hs.get('content-encoding'), null, 'SSE 不能壓縮（會卡住串流）');

    const m = await (await fetch(`http://127.0.0.1:${admin}/metrics`)).text();
    assert.match(m, /rucloud_cache_hits_total\{app="cachey"\} [1-9]/);
    assert.match(m, /rucloud_cache_bytes\{app="cachey",cache="api"\} [1-9]/);
  } finally {
    await rc.stop();
  }
});

function httpsGet(port, path, host) {
  return new Promise((res, rej) => {
    https.get({ host: '127.0.0.1', port, path, servername: 'localhost', rejectUnauthorized: false, headers: { host } }, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => res([r.statusCode, d]));
    }).on('error', rej);
  });
}

test('HTTPS（自備憑證）與 HTTP 轉址', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,DNS:cachey.localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const [tls, edge] = [await freePort(), await freePort()];
  const rc = await start({
    toml: `[tls]\nport = ${tls}\ncert = "${join(dir, 'cert.pem')}"\nkey = "${join(dir, 'key.pem')}"\nredirect_http = true\n[edge]\nport = ${edge}\n[[app]]\npath = "${ROOT}/tests/fixtures/cachey"\n`,
    ready: `http://127.0.0.1:${edge}/`,
  });
  try {
    let ok;
    for (let i = 0; i < 50 && !ok; i++) {
      ok = await httpsGet(tls, '/w/url', `cachey.localhost:${tls}`).catch(() => null);
      if (!ok) await sleep(100);
    }
    assert.deepEqual(ok, [200, `https://cachey.localhost:${tls}/w/url`], 'Worker 看到的協定是 https');
    const loc = await new Promise((res) => http.get({ host: '127.0.0.1', port: edge, path: '/a?b=1', headers: { host: `cachey.localhost:${edge}` } }, (r) => res([r.statusCode, r.headers.location])));
    assert.deepEqual(loc, [308, `https://cachey.localhost:${tls}/a?b=1`]);
  } finally {
    await rc.stop();
  }
});
