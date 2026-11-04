// 1.0 的設定檢查：rucloud check、設定檔打錯字、不支援的 wrangler 欄位、資料夾格式版本
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN, ROOT, freePort, start } from './helpers.mjs';

const run = (...args) => {
  const r = spawnSync(BIN, args, { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('rucloud check：正確的設定', () => {
  const r = run('check', 'examples/rucloud.toml');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /0 個錯誤/);
});

test('rucloud check：打錯字、重複的埠、找不到的檔案、不支援的欄位', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-check-'));
  const typo = join(dir, 'typo.toml');
  writeFileSync(typo, `[[app]]\npath = "${ROOT}/examples/hello"\ninstnaces = 2\n`);
  let r = run('check', typo);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown field `instnaces`/);

  const app = join(dir, 'app');
  cpSync(join(ROOT, 'examples/hello'), app, { recursive: true });
  writeFileSync(join(app, 'wrangler.jsonc'), '{ "name": "hello", "main": "src/worker.js", "routes": ["x.com/*"], "compatibility_flags": ["nodejs_compat"] }');
  const bad = join(dir, 'bad.toml');
  writeFileSync(bad, `[admin]\nport = 9100\n[[app]]\npath = "${app}"\nport = 9100\nenv_file = "nope.env"\nservices_typo = 1\n`);
  r = run('check', bad);
  assert.equal(r.code, 1);
  writeFileSync(bad, `[admin]\nport = 9100\nbind = "0.0.0.0"\n[[app]]\npath = "${app}"\nport = 9100\nenv_file = "nope.env"\n`);
  r = run('check', bad);
  assert.equal(r.code, 1);
  assert.match(r.out, /埠 9100 重複/);
  assert.match(r.out, /找不到 env_file/);
  assert.match(r.out, /沒有設定 token/);
  assert.match(r.out, /wrangler 設定的 routes/);
  assert.match(r.out, /compatibility_flags/);

  r = run('check', app);
  assert.equal(r.code, 0, '單一應用資料夾也能檢查');
});

test('serve 拒絕打錯字的設定檔', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-typo-'));
  const cfg = join(dir, 'rucloud.toml');
  writeFileSync(cfg, `stat_dir = "x"\n[[app]]\npath = "${ROOT}/examples/hello"\n`);
  const r = run('serve', cfg);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown field `stat_dir`/);
});

test('資料夾格式：寫入 VERSION；比這版新的拒絕啟動', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-ver-'));
  const port = await freePort();
  const state = join(dir, 's');
  const cfg = join(dir, 'rucloud.toml');
  writeFileSync(cfg, `state_dir = "${state}"\n[[app]]\npath = "${ROOT}/examples/hello"\nport = ${port}\n`);
  const rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${port}/` });
  await rc.stop();
  assert.equal(readFileSync(join(state, 'VERSION'), 'utf8').trim(), '1');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'VERSION'), '99\n');
  const r = run('serve', cfg);
  assert.equal(r.code, 1);
  assert.match(r.out, /請升級 rucloud/);
});
