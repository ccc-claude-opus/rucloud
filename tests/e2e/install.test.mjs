// [install]：安裝的應用。安裝程式用 [install] 的 token 以應用自己的名稱新增、更新、移除，
// 權限（綁定到系統應用的 service binding 與 props、對外連線）由 PUT /apps/<名稱>/grants 給
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
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
    assert.deepEqual((await admin(adminPort, '/apps/notes/grants')).body, { services: [], network: false, email: false });
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
    assert.deepEqual((await admin(adminPort, '/apps/notes/grants')).body, { services: [], network: false, email: false });
  } finally {
    await rc.stop();
  }
});

// 安裝的應用可以用 Queues 與 Workflows：佇列名稱是應用自己的（`<應用>:<佇列>`），別的應用送不進來；
// 移除（purge）時佇列裡的訊息一起清掉
const jobs = {
  'wrangler.jsonc': JSON.stringify({
    name: 'whatever',
    main: 'src/worker.js',
    kv_namespaces: [{ binding: 'KV', id: 'kv' }],
    queues: { producers: [{ binding: 'Q', queue: 'tasks' }], consumers: [{ queue: 'tasks', max_batch_timeout: 0 }] },
    workflows: [{ name: 'flow', binding: 'FLOW', class_name: 'Flow' }],
  }),
  'src/worker.js': `import { WorkflowEntrypoint } from 'cloudflare:workers';
  export class Flow extends WorkflowEntrypoint {
    async run(event, step) {
      return await step.do('double', async () => event.payload.n * 2);
    }
  }
  export default {
    async fetch(request, env) {
      const u = new URL(request.url);
      if (u.pathname === '/send') { await env.Q.send({ text: u.searchParams.get('text') }); return new Response('ok'); }
      if (u.pathname === '/last') return Response.json({ last: await env.KV.get('last') });
      if (u.pathname === '/wf') return Response.json({ id: (await env.FLOW.create({ params: { n: 21 } })).id });
      if (u.pathname === '/wf/status') return Response.json(await (await env.FLOW.get(u.searchParams.get('id'))).status());
      return new Response('jobs');
    },
    async queue(batch, env) {
      for (const m of batch.messages) await env.KV.put('last', m.body.text);
    },
  };`,
};

test('安裝的應用：Queues 與 Workflows 各自一份', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-inst-q-'));
  const [edgePort, adminPort] = [await freePort(), await freePort()];
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
[[app]]
path = "${systemApp(dir, 'installer')}"
`);
  const rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${adminPort}/apps`});
  const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`等不到${what}`);
  };
  const depth = async () => (await admin(adminPort, '/metrics', { token: ADMIN_TOKEN })).body;
  try {
    const put = (name, files) => admin(adminPort, `/apps/${name}`, { method: 'PUT', body: pack(files) });
    assert.equal((await put('jobs', jobs)).status, 201);
    // 另一個應用用同樣的佇列名稱、沒有消費者：它的訊息留在自己的佇列裡，到不了 jobs
    const other = { ...jobs, 'wrangler.jsonc': JSON.stringify({ ...JSON.parse(jobs['wrangler.jsonc']), queues: { producers: [{ binding: 'Q', queue: 'tasks' }] }, workflows: [] }) };
    assert.equal((await put('other', other)).status, 201);

    assert.equal((await edge(edgePort, 'jobs.localhost', '/send?text=hello')).status, 200);
    await until(async () => (await edge(edgePort, 'jobs.localhost', '/last')).body.last === 'hello', ' jobs 的消費者');
    assert.equal((await edge(edgePort, 'other.localhost', '/send?text=evil')).status, 200);
    await until(async () => /queue="other:tasks"} 1/.test(await depth()), ' other:tasks 的訊息');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await edge(edgePort, 'jobs.localhost', '/last')).body.last, 'hello', '別的應用的訊息不會送到 jobs');

    // Workflows
    const { id } = (await edge(edgePort, 'jobs.localhost', '/wf')).body;
    const st = await until(async () => {
      const s = (await edge(edgePort, 'jobs.localhost', `/wf/status?id=${id}`)).body;
      return s.status === 'complete' && s;
    }, ' workflow 完成');
    assert.equal(st.output, 42);

    // 移除（含資料）時清掉它佇列裡的訊息
    assert.equal((await admin(adminPort, '/apps/other?purge=true', { method: 'DELETE' })).status, 200);
    assert.doesNotMatch(await depth(), /queue="other:tasks"} [1-9]/);
  } finally {
    await rc.stop();
  }
});

// 寄信：SMTP 設定（管理 API /email）、安裝的應用要有 email 權限、只能寄給驗證過的收件地址
function fakeSmtp() {
  const mails = [];
  const server = net.createServer((sock) => {
    let buf = '', data = null, mail = { to: [] };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d;
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mails.push({ ...mail, data: data + buf.slice(0, end) });
          buf = buf.slice(end + 5);
          data = null;
          mail = { to: [] };
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') { mail.from = /<(.*)>/.exec(line)[1]; sock.write('250 ok\r\n'); }
        else if (cmd === 'RCPT') { mail.to.push(/<(.*)>/.exec(line)[1]); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { data = ''; sock.write('354 go\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
        else sock.write('250 ok\r\n');
      }
    });
  });
  return { server, mails };
}

test('寄信：SMTP 設定、email 權限、驗證過的收件地址', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-mail-'));
  const smtp = fakeSmtp();
  await new Promise((r) => smtp.server.listen(0, '127.0.0.1', r));
  const smtpPort = smtp.server.address().port;
  const [edgePort, adminPort] = [await freePort(), await freePort()];
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
[[app]]
path = "${systemApp(dir, 'installer')}"
`);
  const rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${adminPort}/apps` });
  const mailer = {
    'wrangler.jsonc': JSON.stringify({ name: 'x', main: 'src/worker.js', send_email: [{ name: 'MAIL' }, { name: 'ONLY', destination_address: 'boss@example.com' }] }),
    'src/worker.js': `import { EmailMessage } from 'cloudflare:email';
    export default {
      async fetch(request, env) {
        const u = new URL(request.url);
        const to = u.searchParams.get('to');
        try {
          if (u.pathname === '/raw') {
            await env.MAIL.send(new EmailMessage('app@example.com', to, 'From: app@example.com\\r\\nTo: ' + to + '\\r\\nSubject: raw\\r\\n\\r\\nhello raw\\r\\n'));
            return new Response('sent');
          }
          if (u.pathname === '/only') { await env.ONLY.send({ from: 'app@example.com', to, subject: 'x', text: 'x' }); return new Response('sent'); }
          const r = await env.MAIL.send({ from: { email: 'app@example.com', name: '應用' }, to, subject: '你好', text: '純文字', html: '<b>HTML</b>' });
          return new Response(r.messageId ? 'sent' : 'no id');
        } catch (e) {
          return new Response(e.message, { status: 500 });
        }
      },
    };`,
  };
  const get = async (path) => {
    const r = await edge(edgePort, 'mailer.localhost', path);
    return `${r.status} ${typeof r.body === 'string' ? r.body : JSON.stringify(r.body)}`;
  };
  try {
    assert.equal((await admin(adminPort, '/apps/mailer', { method: 'PUT', body: pack(mailer) })).status, 201);
    // 還沒設定 SMTP、也還沒有權限
    assert.match(await get('/?to=me@example.com'), /500 .*沒有寄信的權限/);
    assert.equal((await admin(adminPort, '/apps/mailer/grants', { method: 'PUT', json: { email: true } })).status, 200);
    assert.match(await get('/?to=me@example.com'), /500 .*還沒設定寄信/);

    // 寄信設定只有完整的管理 token 能改；不加密只限本機
    const email = { host: '127.0.0.1', port: smtpPort, security: 'none', from: 'me@example.com', recipients: ['me@example.com', 'boss@example.com'] };
    assert.equal((await admin(adminPort, '/email', { method: 'PUT', json: email })).status, 403, 'install token');
    assert.match(JSON.stringify((await admin(adminPort, '/email', { method: 'PUT', json: { ...email, host: 'smtp.example.com' }, token: ADMIN_TOKEN })).body), /只能用在本機/);
    const set = await admin(adminPort, '/email', { method: 'PUT', json: { ...email, password: 'pw' }, token: ADMIN_TOKEN });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.has_password, true);
    assert.equal(JSON.stringify(set.body).includes('"pw"'), false, '不回傳密碼');
    assert.equal((await admin(adminPort, '/email')).body.from, 'me@example.com', 'install token 可以讀（不含密碼）');

    // 物件形式（純文字 + HTML）、EmailMessage（MIME）
    assert.equal(await get('/?to=me@example.com'), '200 sent');
    assert.equal(await get('/raw?to=me@example.com'), '200 sent');
    assert.equal(smtp.mails.length, 2);
    assert.equal(smtp.mails[0].from, 'me@example.com', 'SMTP 的寄件者是設定的帳號');
    assert.deepEqual(smtp.mails[0].to, ['me@example.com']);
    assert.match(smtp.mails[0].data, /Subject: =\?UTF-8\?B\?5L2g5aW9\?=/);
    assert.match(smtp.mails[0].data, /multipart\/alternative/);
    assert.match(smtp.mails[1].data, /hello raw/);
    // 只能寄給驗證過的地址；綁定的 destination_address
    assert.match(await get('/?to=stranger@example.com'), /500 .*不是驗證過的收件地址/);
    assert.match(await get('/only?to=me@example.com'), /500 .*只能寄給 boss@example.com/);
    assert.equal(await get('/only?to=boss@example.com'), '200 sent');
    // 測試信
    assert.equal((await admin(adminPort, '/email/test', { method: 'POST', json: { to: 'me@example.com' }, token: ADMIN_TOKEN })).status, 200);
    assert.equal(smtp.mails.length, 4);
    // 拿掉權限
    assert.equal((await admin(adminPort, '/apps/mailer/grants', { method: 'PUT', json: { email: false } })).status, 200);
    assert.match(await get('/?to=me@example.com'), /500 .*沒有寄信的權限/);
  } finally {
    await rc.stop();
    smtp.server.close();
  }
});
