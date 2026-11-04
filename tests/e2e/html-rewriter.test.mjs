// HTMLRewriter：串流處理（任意切段結果都一樣、第一段輸出不必等整份讀完）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HTMLRewriter } from '../../runtime/html-rewriter.mjs';

const HTML = `<!DOCTYPE html><html><head><title>T &amp; t</title><script>if (a < b) { x = "</p>"; }</script></head>
<body><!-- note --><div id="main" class="box big"><p>Hello <b>world</b></p><p class="x">second 中文字</p>
<a href="https://ext.com">ext</a><a href='/local'>local</a><img src="a.png"><br/>
<ul><li>1</li><li>2</li></ul><section class="ad">廣告<span>內容</span></section><em class="unwrap">keep <i>me</i></em></div></body></html>`;

function rewriter(log = []) {
  return new HTMLRewriter()
    .on('a[href^="https://"]', { element(el) { el.setAttribute('target', '_blank'); } })
    .on('#main > p:first-child', { element(el) { el.prepend('<strong>!</strong> ', { html: true }); el.append(' <end>'); } })
    .on('p.x', { text(t) { t.replace(t.text.toUpperCase()); } })
    .on('section.ad', { element(el) { el.replace('<aside>已移除</aside>', { html: true }); } })
    .on('em.unwrap', { element(el) { el.removeAndKeepContent(); } })
    .on('ul', { element(el) { el.setInnerContent('<li>new</li>', { html: true }); el.onEndTag((end) => end.after('<!-- /ul -->', { html: true })); } })
    .on('img', { element(el) { el.setAttribute('loading', 'lazy'); } })
    .on('script', { text(t) { if (t.lastInTextNode) log.push('script'); } })
    .on('title', { element(el) { el.setInnerContent('新標題'); } })
    .onDocument({ comments(c) { c.replace('<!-- replaced -->', { html: true }); }, end(e) { e.append('<!-- end -->', { html: true }); } });
}

function chunked(text, size, delay = 0) {
  const bytes = new TextEncoder().encode(text);  // 以位元組切，UTF-8 字元也會被切開
  let i = 0;
  return new ReadableStream({
    async pull(c) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

const res = (body) => new Response(body, { headers: { 'content-type': 'text/html' } });

test('不論怎麼切段，結果都和整份一次處理相同', async () => {
  const expected = await rewriter().transform(res(HTML)).text();
  assert.match(expected, /<a href="https:\/\/ext.com" target="_blank">/);
  assert.match(expected, /SECOND 中文字/);
  assert.match(expected, /<ul><li>new<\/li><\/ul><!-- \/ul -->/);
  assert.match(expected, /<aside>已移除<\/aside>keep <i>me<\/i>/);
  assert.match(expected, /x = "<\/p>"/, 'script 內容不被當成 HTML');
  assert.match(expected, /<!-- end -->$/);
  for (const size of [1, 2, 3, 7, 64]) {
    const log = [];
    assert.equal(await rewriter(log).transform(res(chunked(HTML, size))).text(), expected, `每段 ${size} bytes`);
    assert.deepEqual(log, ['script']);
  }
});

test('第一段輸出不必等整份讀完', async () => {
  const head = '<html><body><h1>title</h1>';
  const body = new ReadableStream({
    async start(c) {
      c.enqueue(new TextEncoder().encode(head));
      await new Promise((r) => setTimeout(r, 500));
      c.enqueue(new TextEncoder().encode('<p>late</p></body></html>'));
      c.close();
    },
  });
  const out = new HTMLRewriter().on('h1', { element(el) { el.setInnerContent('改過'); } }).transform(res(body));
  const reader = out.body.getReader();
  const t0 = Date.now();
  const { value } = await reader.read();
  assert.ok(Date.now() - t0 < 300, '第一段很快就出來');
  assert.match(new TextDecoder().decode(value), /<h1>改過<\/h1>/);
  let rest = '';
  for (;;) { const r = await reader.read(); if (r.done) break; rest += new TextDecoder().decode(r.value); }
  assert.match(rest, /<p>late<\/p>/);
});

test('非 HTML 原樣傳回', async () => {
  const r = new HTMLRewriter().on('p', { element(el) { el.remove(); } }).transform(new Response('{"a":1}', { headers: { 'content-type': 'application/json' } }));
  assert.equal(await r.text(), '{"a":1}');
});
