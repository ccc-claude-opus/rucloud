// [isolation]：作業系統層級的籠子（Linux 的 bubblewrap）。用 isolate = true、sandbox = false 的應用測：
// 沒有 Node 的權限模型，擋住它的只有籠子——看不到別的應用與 rucloud 的檔案、連不到本機的服務、
// 連外只能經過出口代理（本機與區網一律拒絕），綁定 API 照常可用。只在 Linux 上有 bwrap 時跑。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, freePort, json } from './helpers.mjs';

const skip = (() => {
  if (process.platform !== 'linux') return '需要 Linux 與 bubblewrap';
  try {
    execFileSync('bwrap', ['--version']);
  } catch {
    return '需要 bubblewrap';
  }
  // 以 root 跑時 Worker 要換成 rucloud-worker（mode = "on" 時沒有這個使用者就不啟動）
  if (process.getuid() === 0) {
    try {
      execFileSync('id', ['rucloud-worker'], { stdio: 'ignore' });
    } catch {
      return '以 root 執行時需要 rucloud-worker 使用者（useradd -r rucloud-worker）';
    }
  }
  return false;
})();

const SPY = `import { readFileSync, readdirSync, existsSync } from 'node:fs';
import net from 'node:net';
import { hostname } from 'node:os';
const result = async (fn) => { try { return { ok: await fn() }; } catch (e) { return { error: e.code || e.message }; } };
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const q = (k) => u.searchParams.get(k);
    switch (u.pathname) {
      case '/read': return Response.json(await result(() => readFileSync(q('path'), 'utf8').slice(0, 100)));
      case '/exists': return Response.json({ exists: existsSync(q('path')) });
      case '/ls': return Response.json(await result(() => readdirSync(q('path')).sort()));
      case '/tcp': return Response.json(await result(() => new Promise((ok, no) => {
        const s = net.connect(Number(q('port')), q('host') || '127.0.0.1', () => { s.destroy(); ok('connected'); });
        s.on('error', no);
      })));
      case '/fetch': return Response.json(await result(async () => { const r = await fetch(q('url')); return [r.status, (await r.text()).slice(0, 200)]; }));
      case '/kv': await env.KV.put('k', 'v'); return Response.json({ kv: await env.KV.get('k') });
      case '/status': return Response.json(Object.fromEntries(readFileSync('/proc/self/status', 'utf8').split('\\n').map((l) => l.split(':\\t')).filter((p) => p.length === 2)));
      case '/who': return Response.json({ uid: process.getuid(), host: hostname(), pid: process.pid });
    }
    return new Response('?', { status: 404 });
  },
};`;

test('籠子：檔案、本機網路、出口代理、綁定、cgroup', { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-iso-'));
  // 以 root 跑時 Worker 換成 rucloud-worker：測試的暫存資料夾要讓它進得去（實際部署的資料夾本來就是 755）
  chmodSync(dir, 0o755);
  const app = (name, files) => {
    const d = join(dir, name);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(d, p, '..'), { recursive: true });
      writeFileSync(join(d, p), c);
    }
    return d;
  };
  const spy = app('spy', { 'wrangler.jsonc': JSON.stringify({ name: 'spy', main: 'src/w.js', kv_namespaces: [{ binding: 'KV', id: 'kv' }] }), 'src/w.js': SPY });
  const other = app('other', { 'wrangler.jsonc': JSON.stringify({ name: 'other', main: 'src/w.js', kv_namespaces: [{ binding: 'KV', id: 'kv' }] }), 'src/w.js': "export default { async fetch(r, env) { await env.KV.put('secret', 'x'); return new Response('other'); } };" });
  const [spyPort, otherPort, adminPort] = [await freePort(), await freePort(), await freePort()];
  const state = join(dir, 'state');
  writeFileSync(join(dir, 'rucloud.toml'), `state_dir = "${state}"
[admin]
port = ${adminPort}
bind = "127.0.0.1"
token = "admin-token-0123456789"
[isolation]
mode = "on"
[[app]]
path = "${spy}"
port = ${spyPort}
isolate = true
sandbox = false
memory_mb = 128
[[app]]
path = "${other}"
port = ${otherPort}
`);
  const rc = await start({ args: ['serve', join(dir, 'rucloud.toml')], ready: [`http://127.0.0.1:${spyPort}/who`, `http://127.0.0.1:${otherPort}/`] });
  const S = async (p) => (await json(`http://127.0.0.1:${spyPort}${p}`)).body;
  try {
    await fetch(`http://127.0.0.1:${otherPort}/`);
    const who = await S('/who');
    assert.equal(who.host, 'worker', '自己的 uts namespace');
    assert.ok(who.pid < 10, `自己的 pid namespace（pid ${who.pid}）`);
    if (process.getuid() === 0) assert.notEqual(who.uid, 0, '換成沒有權限的使用者');
    const st = await S('/status');
    assert.equal(st.Seccomp, '2', 'seccomp 過濾');
    assert.equal(st.NoNewPrivs, '1', 'no_new_privs');
    assert.equal(st.CapEff, '0000000000000000', '沒有任何 capability');

    // 檔案：別的應用的資料、rucloud 的設定、系統的帳號資料都不存在
    assert.ok(existsSync(join(state, 'other', 'kv.sqlite')), '（other 的資料在籠子外面確實存在）');
    assert.deepEqual(await S(`/exists?path=${encodeURIComponent(join(state, 'other', 'kv.sqlite'))}`), { exists: false });
    assert.deepEqual(await S(`/exists?path=${encodeURIComponent(join(dir, 'rucloud.toml'))}`), { exists: false });
    assert.deepEqual(await S('/exists?path=/etc/passwd'), { exists: false });
    assert.deepEqual(await S(`/exists?path=${encodeURIComponent(join(state, 'spy', 'do-sqlite'))}`), { exists: true }, '自己的 Durable Object 資料夾');

    // 本機網路：rucloud 的管理埠、別的應用都連不到（籠子裡只有自己的 lo）
    assert.ok((await S(`/tcp?port=${adminPort}`)).error, '管理埠');
    assert.ok((await S(`/tcp?port=${otherPort}`)).error, '別的應用');
    // 連外經過出口代理：本機與區網拒絕
    const local = await S(`/fetch?url=${encodeURIComponent(`http://127.0.0.1:${adminPort}/apps`)}`);
    assert.ok(local.error || (local.ok[0] === 403 && /網際網路/.test(local.ok[1])), JSON.stringify(local));
    const lan = await S(`/fetch?url=${encodeURIComponent('http://192.168.1.1/')}`);
    assert.ok(lan.error || lan.ok[0] === 403, JSON.stringify(lan));

    // 綁定 API 照常可用
    assert.deepEqual(await S('/kv'), { kv: 'v' });

    // cgroup：每個應用一個，有上限
    const cg = execFileSync('sh', ['-c', 'find /sys/fs/cgroup -maxdepth 6 -type d -path "*/workers/spy" 2>/dev/null || true']).toString().trim().split('\n')[0];
    if (cg) {
      assert.equal(readFileSync(join(cg, 'pids.max'), 'utf8').trim(), '64');
      assert.match(readFileSync(join(cg, 'cgroup.procs'), 'utf8'), /\d/, 'Worker 程序在這個 cgroup 裡');
    }
  } finally {
    await rc.stop();
  }
});
