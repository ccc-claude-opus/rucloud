// 自動憑證：用 Let's Encrypt 官方的測試伺服器 Pebble 跑完整的 ACME 流程。
// 需要 pebble 與 pebble-challtestsrv：設 PEBBLE_BIN=<放這兩個執行檔的資料夾>，沒設就跳過。
//   https://github.com/letsencrypt/pebble/releases
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, freePort, sleep } from './helpers.mjs';

const PEBBLE = process.env.PEBBLE_BIN;
const skip = !PEBBLE && '沒有設 PEBBLE_BIN';

function fetchText(url, { ca, servername, host } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, ca, servername,
      headers: host ? { host } : {}, rejectUnauthorized: !!ca,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 起 Pebble 與假的 DNS（所有網域都解析到 127.0.0.1）；tlsPort 是 Pebble 做 TLS-ALPN-01 驗證時連的埠
async function pebble(tlsPort) {
  const dir = mkdtempSync(join(tmpdir(), 'rc-pebble-'));
  const run = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=pebble test ca');
  run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'key.pem', '-out', 'req.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'req.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'cert.pem', '-days', '2', '-extfile', 'ext.cnf');
  const [acmePort, mgmtPort, dnsPort, ctsPort] = await Promise.all(Array.from({ length: 4 }, freePort));
  writeFileSync(join(dir, 'pebble.json'), JSON.stringify({ pebble: {
    listenAddress: `127.0.0.1:${acmePort}`, managementListenAddress: `127.0.0.1:${mgmtPort}`,
    certificate: join(dir, 'cert.pem'), privateKey: join(dir, 'key.pem'),
    httpPort: 5002, tlsPort, ocspResponderURL: '', externalAccountBindingRequired: false,
  } }));
  const cts = spawn(join(PEBBLE, 'pebble-challtestsrv'), ['-defaultIPv4', '127.0.0.1', '-defaultIPv6', '', '-dnsserver', `127.0.0.1:${dnsPort}`,
    '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', '', '-management', `127.0.0.1:${ctsPort}`], { stdio: 'ignore' });
  const peb = spawn(join(PEBBLE, 'pebble'), ['-config', join(dir, 'pebble.json'), '-dnsserver', `127.0.0.1:${dnsPort}`],
    { env: { ...process.env, PEBBLE_VA_NOSLEEP: '1' }, stdio: 'ignore' });
  const caPem = readFileSync(join(dir, 'ca.pem'));
  for (let i = 0; i < 50; i++) {
    try { await fetchText(`https://127.0.0.1:${acmePort}/dir`, { ca: caPem }); break; } catch { await sleep(200); }
  }
  return {
    acmeToml: `directory = "https://127.0.0.1:${acmePort}/dir"\nca_root = "${join(dir, 'ca.pem')}"\n`,
    root: async () => (await fetchText(`https://127.0.0.1:${mgmtPort}/roots/0`, { ca: caPem })).body,
    // 假 DNS 的管理 API：設定 / 清除 TXT 記錄
    dns: (path, body) => fetch(`http://127.0.0.1:${ctsPort}${path}`, { method: 'POST', body: JSON.stringify(body) }),
    stop() { peb.kill(); cts.kill(); },
  };
}

function helloApp(dir) {
  const app = join(dir, 'hello');
  mkdirSync(join(app, 'src'), { recursive: true });
  writeFileSync(join(app, 'wrangler.jsonc'), JSON.stringify({ name: 'hello', main: 'src/worker.js' }));
  writeFileSync(join(app, 'src/worker.js'), 'export default { fetch: (r) => new Response("hi " + new URL(r.url).host + " " + new URL(r.url).protocol) };');
  return app;
}

test('ACME：啟動時替網域申請、on-demand、只發給屬於應用的網域', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-acme-'));
  const [httpsPort, edgePort, adminPort] = await Promise.all(Array.from({ length: 3 }, freePort));
  const p = await pebble(httpsPort);
  let rc;
  try {
    const app = helloApp(dir);
    rc = await start({
      toml: `[edge]\nport = ${edgePort}\n[domain]\nbase = "example.test"\n` +
        `[admin]\nport = ${adminPort}\ntoken = "admin-token-0123456789"\n` +
        `[tls]\nport = ${httpsPort}\n[tls.acme]\n${p.acmeToml}[[app]]\npath = "${app}"\n`,
      ready: `http://127.0.0.1:${edgePort}/`,
    });
    // 啟動時就替 hello.example.test 申請
    const certFile = join(rc.state, 'acme', 'certs', 'hello.example.test.crt');
    for (let i = 0; i < 100 && !existsSync(certFile); i++) await sleep(200);
    assert.ok(existsSync(certFile), `沒有申請到憑證\n${rc.log()}`);
    // 用 Pebble 的根憑證驗證整條鏈（HTTP/2 也要能依網域分派）
    const root = await p.root();
    const r = await fetchText(`https://127.0.0.1:${httpsPort}/`, { ca: root, servername: 'hello.example.test', host: 'hello.example.test' });
    assert.equal(r.body, 'hi hello.example.test https:');

    // on-demand：部署時新增的應用，第一次連線才申請
    const tar = execFileSync('tar', ['-czf', '-', '-C', app, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const put = await fetch(`http://127.0.0.1:${adminPort}/apps/late`, { method: 'PUT', body: tar, headers: { authorization: 'Bearer admin-token-0123456789' } });
    assert.equal(put.status, 201);
    const d = await fetchText(`https://127.0.0.1:${httpsPort}/`, { ca: root, servername: 'late.example.test', host: 'late.example.test' });
    assert.equal(d.body, 'hi late.example.test https:');
    assert.ok(existsSync(join(rc.state, 'acme', 'certs', 'late.example.test.crt')));

    // 不屬於任何應用的網域：不申請，交握失敗
    await assert.rejects(fetchText(`https://127.0.0.1:${httpsPort}/`, { ca: root, servername: 'nobody.example.test', host: 'nobody.example.test' }));
    assert.equal(existsSync(join(rc.state, 'acme', 'certs', 'nobody.example.test.crt')), false);
  } finally {
    await rc?.stop();
    p.stop();
  }
});

// 模擬 DNS 供應商的 API：照它們的格式收請求，轉成假 DNS 的 TXT 記錄
function mockDns(provider, p) {
  const seen = [];
  const records = new Map();
  let next = 100;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const send = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers.authorization !== `Bearer ${provider}-token`) return send({ success: false, errors: ['auth'] }, 403);
    const u = new URL(req.url, 'http://x');
    seen.push(`${req.method} ${u.pathname}`);
    if (provider === 'cloudflare') {
      if (req.method === 'GET' && u.pathname === '/zones') {
        return send({ success: true, result: u.searchParams.get('name') === 'example.test' ? [{ id: 'zone1' }] : [] });
      }
      if (req.method === 'POST' && u.pathname === '/zones/zone1/dns_records') {
        const b = JSON.parse(body);
        assert.equal(b.type, 'TXT');
        await p.dns('/set-txt', { host: `${b.name}.`, value: b.content });
        const id = `r${next++}`;
        records.set(id, b.name);
        return send({ success: true, result: { id } });
      }
      const m = u.pathname.match(/^\/zones\/zone1\/dns_records\/(\w+)$/);
      if (req.method === 'DELETE' && m) {
        await p.dns('/clear-txt', { host: `${records.get(m[1])}.` });
        return send({ success: true, result: { id: m[1] } });
      }
    } else {
      if (req.method === 'GET' && u.pathname === '/domains') {
        const f = JSON.parse(req.headers['x-filter'] || '{}');
        return send({ data: f.domain === 'example.test' ? [{ id: 7, domain: 'example.test' }] : [], page: 1, pages: 1 });
      }
      if (req.method === 'POST' && u.pathname === '/domains/7/records') {
        const b = JSON.parse(body);
        assert.equal(b.type, 'TXT');
        assert.ok(!b.name.endsWith('example.test'), 'Linode 的記錄名稱是相對的');
        await p.dns('/set-txt', { host: `${b.name}.example.test.`, value: b.target });
        const id = next++;
        records.set(String(id), `${b.name}.example.test`);
        return send({ id });
      }
      const m = u.pathname.match(/^\/domains\/7\/records\/(\d+)$/);
      if (req.method === 'DELETE' && m) {
        await p.dns('/clear-txt', { host: `${records.get(m[1])}.` });
        return send({});
      }
    }
    send({ success: false, errors: ['not found'] }, 404);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

for (const provider of ['cloudflare', 'linode']) {
  test(`萬用字元憑證（DNS-01，${provider}）：涵蓋所有子網域，不再個別申請`, { skip }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-wild-'));
    const [httpsPort, edgePort] = await Promise.all(Array.from({ length: 2 }, freePort));
    const p = await pebble(httpsPort);
    const api = await mockDns(provider, p);
    let rc;
    try {
      rc = await start({
        toml: `[edge]\nport = ${edgePort}\n[domain]\nbase = "example.test"\nroot = "hello"\n[tls]\nport = ${httpsPort}\n[tls.acme]\n${p.acmeToml}` +
          `dns = { provider = "${provider}", api_token = "${provider}-token", api_url = "${api.url}", propagation_seconds = 0 }\n` +
          `[[app]]\npath = "${helloApp(dir)}"\n`,
        ready: `http://127.0.0.1:${edgePort}/`,
      });
      const certs = join(rc.state, 'acme', 'certs');
      for (let i = 0; i < 100 && !existsSync(join(certs, '_wildcard.example.test.crt')); i++) await sleep(200);
      assert.ok(existsSync(join(certs, '_wildcard.example.test.crt')), `沒有申請到萬用字元憑證\n${rc.log()}`);
      const root = await p.root();
      for (const host of ['hello.example.test', 'example.test']) {
        const r = await fetchText(`https://127.0.0.1:${httpsPort}/`, { ca: root, servername: host, host });
        assert.equal(r.body, `hi ${host} https:`);
      }
      // 任何一層子網域都有憑證（交握成功；沒有這個應用所以是 404）
      assert.equal((await fetchText(`https://127.0.0.1:${httpsPort}/`, { ca: root, servername: 'other.example.test', host: 'other.example.test' })).status, 404);
      await sleep(300);
      assert.deepEqual(readdirSync(certs).sort(), ['_wildcard.example.test.crt', '_wildcard.example.test.key'], '只有一張萬用字元憑證');
      // 建立兩筆 TXT 記錄（*.example.test 與 example.test），用完刪掉
      assert.equal(api.seen.filter((s) => s.startsWith('POST')).length, 2, api.seen.join('\n'));
      assert.equal(api.seen.filter((s) => s.startsWith('DELETE')).length, 2, api.seen.join('\n'));
    } finally {
      await rc?.stop();
      api.close();
      p.stop();
    }
  });
}
