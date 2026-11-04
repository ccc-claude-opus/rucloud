// 整合測試的共用工具：在暫存資料夾起一個 rucloud，測完關掉
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const BIN = process.env.RUCLOUD_BIN || join(ROOT, 'target', 'debug', 'rucloud');

export function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
    s.on('error', rej);
  });
}

async function waitFor(url, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url, { redirect: 'manual' }); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`等不到 ${url}`);
}

/// 起一個 rucloud。args 是指令列參數（dev / serve …）；toml 給了就寫成設定檔並用 serve 起
export async function start({ args, toml, ready, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'rucloud-e2e-'));
  let argv = args;
  if (toml) {
    const cfg = join(dir, 'rucloud.toml');
    writeFileSync(cfg, `state_dir = "${join(dir, 'state')}"\n${toml}`);
    argv = ['serve', cfg];
  }
  const child = spawn(BIN, argv, { cwd: ROOT, env: { ...process.env, RUCLOUD_LOG: 'warn', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((r) => child.on('exit', r));
  try {
    for (const u of [].concat(ready)) await waitFor(u);
  } catch (e) {
    child.kill();
    throw new Error(`${e.message}\n--- rucloud log ---\n${log}`);
  }
  return {
    dir,
    child,
    exited,
    state: join(dir, 'state'),
    log: () => log,
    async stop() {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      child.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function cli(...args) {
  return execFileSync(BIN, args, { cwd: ROOT, encoding: 'utf8' });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function json(url, init) {
  const r = await fetch(url, init);
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}

/// 一個 cookie jar 的 fetch（myshop、friendbook 的登入用）
export function session() {
  let cookie = '';
  return async (url, init = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const r = await fetch(url, { ...init, headers, redirect: 'manual' });
    const set = r.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
