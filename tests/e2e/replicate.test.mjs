// 持續複寫：送到資料夾與 S3（另一台 rucloud 的 S3 API），還原到新的資料夾、還原到某個時間點
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BIN, ROOT, start, freePort, json, sleep } from './helpers.mjs';

const rucloud = (...args) => {
  const r = spawnSync(BIN, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stdout + r.stderr);
  return r.stdout;
};

function config(dir, port, state, replicate) {
  const cfg = join(dir, `rucloud-${port}.toml`);
  writeFileSync(cfg, `state_dir = "${state}"\n${replicate}\n[[app]]\npath = "${ROOT}/examples/showcase"\nport = ${port}\n`);
  return cfg;
}

async function writeData(u, hits) {
  for (let i = 0; i < hits; i++) await fetch(`${u}/api/d1`);
  await fetch(`${u}/api/kv`);
  await fetch(`${u}/api/r2?key=rep/a.txt`, { method: 'PUT', body: 'replicated!', headers: { 'content-type': 'text/plain' } });
}

async function verify(cfg, port, expectHits) {
  const rc = await start({ args: ['serve', cfg], ready: `http://127.0.0.1:${port}/` });
  try {
    const u = `http://127.0.0.1:${port}`;
    assert.equal((await json(`${u}/api/d1`)).body.hits, expectHits + 1, 'D1 的資料還原了（這次又加一）');
    assert.equal(await (await fetch(`${u}/api/r2?key=rep/a.txt`)).text(), 'replicated!', 'R2 物件還原了');
    assert.ok((await json(`${u}/api/kv`)).body.visits >= 2, 'KV 還原了');
  } finally {
    await rc.stop();
  }
}

test('複寫到資料夾、還原、還原到某個時間點', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-rep-'));
  const remote = join(dir, 'remote');
  const port = await freePort();
  const rep = `[replicate]\ntarget = "file://${remote}"\ninterval = 1\n`;
  const cfgA = config(dir, port, join(dir, 'a'), rep);
  const rc = await start({ args: ['serve', cfgA], ready: `http://127.0.0.1:${port}/` });
  const u = `http://127.0.0.1:${port}`;
  await writeData(u, 3);
  await sleep(2500);
  const middle = new Date().toISOString();
  await sleep(1100);
  for (let i = 0; i < 4; i++) await fetch(`${u}/api/d1`);   // 之後又加 4 次，總共 7
  await rc.stop();                                           // 關閉前會再送最後一輪
  assert.ok(existsSync(join(remote, 'manifest.json')));
  const m = JSON.parse(readFileSync(join(remote, 'manifest.json'), 'utf8'));
  assert.ok(Object.keys(m.dbs).some((k) => k.endsWith('showcase-db.sqlite')));
  assert.ok(Object.keys(m.files).some((k) => k.includes('/r2/objects/')), 'R2 物件檔案也送了');
  assert.match(rucloud('replica', 'status', '--config', cfgA), /showcase-db\.sqlite：\d+ 份快照/);

  // 還原最新的到新資料夾
  const port2 = await freePort();
  const cfgB = config(dir, port2, join(dir, 'b'), rep.replace('interval = 1', 'interval = 3600'));
  assert.match(rucloud('replica', 'restore', '--config', cfgB), /已從 .* 還原 \d+ 個資料庫/);
  await verify(cfgB, port2, 7);

  // 還原到中間的時間點：當時只寫了 3 次
  const port3 = await freePort();
  const cfgC = config(dir, port3, join(dir, 'c'), rep.replace('interval = 1', 'interval = 3600'));
  rucloud('replica', 'restore', '--config', cfgC, '--at', middle);
  await verify(cfgC, port3, 3);
  assert.throws(() => rucloud('replica', 'restore', '--config', cfgC), /--force/);
});

test('複寫到 S3（另一台 rucloud 的 S3 API）並還原', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-reps3-'));
  // 當作遠端儲存的 rucloud：showcase 的 R2 bucket 透過 S3 API 對外
  const [s3Port, storePort] = [await freePort(), await freePort()];
  const storeCfg = join(dir, 'store.toml');
  writeFileSync(storeCfg, `state_dir = "${join(dir, 'store')}"\n[s3]\nport = ${s3Port}\naccess_key_id = "rep"\nsecret_access_key = "replication-secret-123"\n[[app]]\npath = "${ROOT}/examples/showcase"\nport = ${storePort}\n`);
  const store = await start({ args: ['serve', storeCfg], ready: `http://127.0.0.1:${storePort}/` });
  try {
    const rep = `[replicate]\ntarget = "s3://showcase-files/backups/prod"\nendpoint = "http://127.0.0.1:${s3Port}"\naccess_key_id = "rep"\nsecret_access_key = "replication-secret-123"\ninterval = 1\n`;
    const port = await freePort();
    const cfgA = config(dir, port, join(dir, 'a'), rep);
    const rc = await start({ args: ['serve', cfgA], ready: `http://127.0.0.1:${port}/` });
    await writeData(`http://127.0.0.1:${port}`, 2);
    await sleep(2500);
    await rc.stop();
    // 遠端儲存那邊看得到檔案
    const listed = await (await fetch(`http://127.0.0.1:${storePort}/api/r2`)).json();
    assert.ok(listed.objects.some((o) => o.key === 'backups/prod/manifest.json'));

    const port2 = await freePort();
    const cfgB = config(dir, port2, join(dir, 'b'), rep.replace('interval = 1', 'interval = 3600'));
    rucloud('replica', 'restore', '--config', cfgB);
    await verify(cfgB, port2, 2);

    const bad = config(dir, port2, join(dir, 'x'), rep.replace('replication-secret-123', 'wrong-secret-xxxxxxx'));
    assert.throws(() => rucloud('replica', 'status', '--config', bad), /403|SignatureDoesNotMatch/);
  } finally {
    await store.stop();
  }
});
