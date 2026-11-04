// connect()（cloudflare:sockets）：TCP 連線、讀寫、連不上時的錯誤
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ROOT, start, freePort } from './helpers.mjs';

let rc;
let echo;
const P = {};
before(async () => {
  // 測試用的 TCP 回聲伺服器：收到的內容加上前綴回傳，對方關閉寫入後才結束
  echo = net.createServer({ allowHalfOpen: true }, (s) => {
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('end', () => s.end(`echo: ${got}`));
  });
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  P.echo = echo.address().port;
  [P.app, P.calc, P.closed] = [await freePort(), await freePort(), await freePort()];
  rc = await start({
    toml: `[[app]]\npath = "${ROOT}/tests/fixtures/sockets"\nport = ${P.app}\n[[app]]\npath = "${ROOT}/tests/fixtures/calc"\nport = ${P.calc}\n`,
    ready: [`http://127.0.0.1:${P.app}/`, `http://127.0.0.1:${P.calc}/`],
  });
});
after(async () => { await rc?.stop(); echo?.close(); });

test('TCP 讀寫與半關閉', async () => {
  const r = await (await fetch(`http://127.0.0.1:${P.app}/echo?port=${P.echo}`)).json();
  assert.deepEqual(r, { text: 'echo: hello rucloud', remote: true });
});

test('用 socket 送原始的 HTTP 請求', async () => {
  assert.equal(await (await fetch(`http://127.0.0.1:${P.app}/http?port=${P.calc}`)).text(), 'calc');
});

test('連不上時 opened 會 reject', async () => {
  assert.equal(await (await fetch(`http://127.0.0.1:${P.app}/refused?port=${P.closed}`)).text(), 'error: ECONNREFUSED');
});
