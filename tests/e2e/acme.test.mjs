// 自動憑證：用 Let's Encrypt 官方的測試伺服器 Pebble 跑完整的 ACME 流程。
// 需要 pebble 與 pebble-challtestsrv：設 PEBBLE_BIN=<放這兩個執行檔的資料夾>，沒設就跳過。
//   https://github.com/letsencrypt/pebble/releases
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, start, freePort, sleep } from './helpers.mjs';

const PEBBLE = process.env.PEBBLE_BIN;

// Pebble 自己的 HTTPS 用的測試 CA 與憑證
function pebbleCerts(dir) {
  const run = (...a) => execFileSync('openssl', a, { cwd: dir, stdio: 'pipe' });
  run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=pebble test ca');
  run('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', 'key.pem', '-out', 'req.csr', '-subj', '/CN=localhost');
  writeFileSync(join(dir, 'ext.cnf'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  run('x509', '-req', '-in', 'req.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'cert.pem', '-days', '2', '-extfile', 'ext.cnf');
}

function spawnBg(bin, args, env = {}) {
  const p = spawn(bin, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
  return p;
}

async function waitHttps(url, ca) {
  for (let i = 0; i < 50; i++) {
    try { await fetchText(url, { ca }); return; } catch { await sleep(200); }
  }
  throw new Error(`${url} 沒有起來`);
}

function fetchText(url, { ca, servername, host } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, ca, servername,
      headers: host ? { host } : {}, rejectUnauthorized: !!ca,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('ACME：啟動時替網域申請、on-demand、只發給屬於應用的網域', { skip: !PEBBLE && '沒有設 PEBBLE_BIN' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-acme-'));
  pebbleCerts(dir);
  const [acmePort, mgmtPort, dnsPort, ctsMgmt, httpsPort, edgePort, adminPort] = await Promise.all(Array.from({ length: 7 }, freePort));
  writeFileSync(join(dir, 'pebble.json'), JSON.stringify({ pebble: {
    listenAddress: `127.0.0.1:${acmePort}`, managementListenAddress: `127.0.0.1:${mgmtPort}`,
    certificate: join(dir, 'cert.pem'), privateKey: join(dir, 'key.pem'),
    httpPort: 5002, tlsPort: httpsPort, ocspResponderURL: '', externalAccountBindingRequired: false,
  } }));
  const cts = spawnBg(join(PEBBLE, 'pebble-challtestsrv'), ['-defaultIPv4', '127.0.0.1', '-defaultIPv6', '', '-dnsserver', `127.0.0.1:${dnsPort}`,
    '-http01', '', '-https01', '', '-tlsalpn01', '', '-doh', '', '-management', `127.0.0.1:${ctsMgmt}`]);
  const pebble = spawnBg(join(PEBBLE, 'pebble'), ['-config', join(dir, 'pebble.json'), '-dnsserver', `127.0.0.1:${dnsPort}`], { PEBBLE_VA_NOSLEEP: '1' });
  const caPem = (await import('node:fs')).readFileSync(join(dir, 'ca.pem'));
  let rc;
  try {
    await waitHttps(`https://127.0.0.1:${acmePort}/dir`, caPem);
    const app = join(dir, 'hello');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'wrangler.jsonc'), JSON.stringify({ name: 'hello', main: 'src/worker.js' }));
    writeFileSync(join(app, 'src/worker.js'), 'export default { fetch: (r) => new Response("hi " + new URL(r.url).host + " " + new URL(r.url).protocol) };');
    rc = await start({
      toml: `[edge]\nport = ${edgePort}\n[domain]\nbase = "example.test"\n` +
        `[admin]\nport = ${adminPort}\ntoken = "admin-token-0123456789"\n[dynamic]\n` +
        `[tls]\nport = ${httpsPort}\n[tls.acme]\ndirectory = "https://127.0.0.1:${acmePort}/dir"\nca_root = "${join(dir, 'ca.pem')}"\n` +
        `[[app]]\npath = "${app}"\n`,
      ready: `http://127.0.0.1:${edgePort}/`,
    });
    // 啟動時就替 hello.example.test 申請
    const certFile = join(rc.state, 'acme', 'certs', 'hello.example.test.crt');
    for (let i = 0; i < 100 && !existsSync(certFile); i++) await sleep(200);
    assert.ok(existsSync(certFile), `沒有申請到憑證\n${rc.log()}`);
    // 用 Pebble 的根憑證驗證整條鏈（HTTP/2 也要能依網域分派）
    const root = (await fetchText(`https://127.0.0.1:${mgmtPort}/roots/0`, { ca: caPem })).body;
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
    pebble.kill();
    cts.kill();
  }
});
