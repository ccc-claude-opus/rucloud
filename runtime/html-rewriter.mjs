// rucloud 的 HTMLRewriter（Cloudflare HTMLRewriter 的子集）
//
//   new HTMLRewriter()
//     .on('a[href^="http"]', { element(el) { el.setAttribute('target', '_blank'); } })
//     .onDocument({ end(end) { end.append('<!-- by rucloud -->', { html: true }); } })
//     .transform(response)
//
// 和 Cloudflare 的差異：整份 HTML 讀完才處理（不是邊讀邊改）；一個文字節點只給一次 text()（lastInTextNode 一定是 true）；
// 選擇器支援 * 標籤 #id .class [attr] [attr=v] [attr^=v] [attr$=v] [attr*=v] [attr~=v] [attr|=v]、後代（空白）與子代（>），
// 以及 :first-child、:not(簡單選擇器)；不支援 :nth-child 等其他虛擬類別。

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const content = (c, opts) => (opts?.html ? String(c) : escText(c));

// ---------- 選擇器 ----------

function parseCompound(src) {
  const c = { tag: null, id: null, classes: [], attrs: [], not: [], firstChild: false };
  const re = /\*|[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[\s*([\w:-]+)\s*(?:([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*))\s*(i)?\s*)?\]|:first-child|:not\(([^)]*)\)/gy;
  let m;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    m = re.exec(src);
    if (!m) throw new TypeError(`HTMLRewriter：不支援的選擇器「${src}」`);
    const t = m[0];
    if (t === '*') { /* 全部 */ } else if (t[0] === '#') c.id = t.slice(1);
    else if (t[0] === '.') c.classes.push(t.slice(1));
    else if (t[0] === '[') c.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? '', ci: !!m[6] });
    else if (t === ':first-child') c.firstChild = true;
    else if (t.startsWith(':not(')) c.not.push(parseCompound(m[7].trim()));
    else c.tag = t.toLowerCase();
    pos = re.lastIndex;
  }
  return c;
}

function parseSelector(sel) {
  // 結果：由右到左的 [{compound, combinator}]，combinator 是和「左邊那一個」的關係
  const parts = [];
  const tokens = sel.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  let comb = ' ';
  for (const tok of tokens) {
    if (tok === '>') { comb = '>'; continue; }
    parts.push({ compound: parseCompound(tok), combinator: comb });
    comb = ' ';
  }
  return parts;
}

function attrMatch(a, el) {
  if (!el.attrs.has(a.name)) return false;
  if (!a.op) return true;
  let v = el.attrs.get(a.name);
  let want = a.value;
  if (a.ci) { v = v.toLowerCase(); want = want.toLowerCase(); }
  switch (a.op) {
    case '=': return v === want;
    case '~=': return v.split(/\s+/).includes(want);
    case '|=': return v === want || v.startsWith(`${want}-`);
    case '^=': return want !== '' && v.startsWith(want);
    case '$=': return want !== '' && v.endsWith(want);
    case '*=': return want !== '' && v.includes(want);
    default: return false;
  }
}

function compoundMatch(c, node) {
  const el = node.el;
  if (c.tag && c.tag !== el.tagName) return false;
  if (c.id && el.attrs.get('id') !== c.id) return false;
  if (c.classes.length) {
    const cls = (el.attrs.get('class') || '').split(/\s+/);
    if (!c.classes.every((x) => cls.includes(x))) return false;
  }
  if (!c.attrs.every((a) => attrMatch(a, el))) return false;
  if (c.firstChild && node.index !== 0) return false;
  if (c.not.some((n) => compoundMatch(n, node))) return false;
  return true;
}

// stack：從根到目前元素的節點陣列，最後一個是要比對的元素
function selectorMatch(parts, stack, at = stack.length - 1, pi = parts.length - 1) {
  if (pi < 0) return true;
  if (at < 0 || !compoundMatch(parts[pi].compound, stack[at])) return false;
  if (pi === 0) return true;
  if (parts[pi].combinator === '>') return selectorMatch(parts, stack, at - 1, pi - 1);
  for (let a = at - 1; a >= 0; a--) if (selectorMatch(parts, stack, a, pi - 1)) return true;
  return false;
}

// ---------- 給 handler 用的物件 ----------

class Mutations {
  constructor() { this.before = ''; this.after = ''; this.removed = false; this.replacement = null; }
  _before(c, o) { this.before += content(c, o); return this; }
  _after(c, o) { this.after = content(c, o) + this.after; return this; }
}

class Element {
  constructor(tagName, attrs, selfClosing) {
    this.tagName = tagName;
    this.attrs = attrs;          // Map，保留順序
    this.selfClosing = selfClosing;
    this.canHaveContent = !VOID.has(tagName);
    this.namespaceURI = 'http://www.w3.org/1999/xhtml';
    this._m = new Mutations();
    this._prepend = '';
    this._append = '';
    this._inner = null;
    this._keepContent = false;
    this._dirty = false;
    this._endHandlers = [];
  }
  get attributes() { return this.attrs.entries(); }
  get removed() { return this._m.removed; }
  getAttribute(n) { return this.attrs.has(n.toLowerCase()) ? this.attrs.get(n.toLowerCase()) : null; }
  hasAttribute(n) { return this.attrs.has(n.toLowerCase()); }
  setAttribute(n, v) { this.attrs.set(n.toLowerCase(), String(v)); this._dirty = true; return this; }
  removeAttribute(n) { this._dirty = this.attrs.delete(n.toLowerCase()) || this._dirty; return this; }
  before(c, o) { this._m._before(c, o); return this; }
  after(c, o) { this._m._after(c, o); return this; }
  prepend(c, o) { this._prepend = content(c, o) + this._prepend; return this; }
  append(c, o) { this._append += content(c, o); return this; }
  replace(c, o) { this._m.replacement = content(c, o); this._m.removed = true; return this; }
  setInnerContent(c, o) { this._inner = content(c, o); return this; }
  remove() { this._m.removed = true; return this; }
  removeAndKeepContent() { this._keepContent = true; return this; }
  onEndTag(handler) { this._endHandlers.push(handler); }
  _startTag(raw) {
    if (!this._dirty) return raw;
    let s = `<${this.tagName}`;
    for (const [k, v] of this.attrs) s += v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`;
    return `${s}${this.selfClosing ? ' /' : ''}>`;
  }
}

class EndTag {
  constructor(name) { this.name = name; this._m = new Mutations(); }
  before(c, o) { this._m._before(c, o); return this; }
  after(c, o) { this._m._after(c, o); return this; }
  remove() { this._m.removed = true; return this; }
}

class TextChunk {
  constructor(text) { this.text = text; this.lastInTextNode = true; this._m = new Mutations(); }
  get removed() { return this._m.removed; }
  before(c, o) { this._m._before(c, o); return this; }
  after(c, o) { this._m._after(c, o); return this; }
  replace(c, o) { this._m.replacement = content(c, o); this._m.removed = true; return this; }
  remove() { this._m.removed = true; return this; }
}

class Comment {
  constructor(text) { this.text = text; this._m = new Mutations(); }
  get removed() { return this._m.removed; }
  before(c, o) { this._m._before(c, o); return this; }
  after(c, o) { this._m._after(c, o); return this; }
  replace(c, o) { this._m.replacement = content(c, o); this._m.removed = true; return this; }
  remove() { this._m.removed = true; return this; }
}

class DocumentEnd {
  constructor() { this._append = ''; }
  append(c, o) { this._append += content(c, o); return this; }
}

const emitMut = (m, body) => m.before + (m.removed ? (m.replacement ?? '') : body) + m.after;

// ---------- 斷詞 ----------

function* tokenize(html) {
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { yield { type: 'text', raw: html.slice(i) }; return; }
    if (lt > i) yield { type: 'text', raw: html.slice(i, lt) };
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const stop = end < 0 ? n : end + 3;
      yield { type: 'comment', raw: html.slice(i, stop), text: html.slice(i + 4, end < 0 ? n : end) };
      i = stop;
      continue;
    }
    if (/^<!doctype/i.test(html.slice(i, i + 9))) {
      const end = html.indexOf('>', i);
      const stop = end < 0 ? n : end + 1;
      yield { type: 'doctype', raw: html.slice(i, stop) };
      i = stop;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 64));
    if (!m) { yield { type: 'text', raw: '<' }; i++; continue; }
    // 找標籤結尾（跳過引號裡的 >）
    let j = i + m[0].length;
    let quote = null;
    while (j < n) {
      const c = html[j];
      if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const raw = html.slice(i, j + 1);
    const name = m[2].toLowerCase();
    i = j + 1;
    if (m[1]) { yield { type: 'end', raw, name }; continue; }
    const attrs = new Map();
    const body = raw.slice(m[0].length, -1);
    const are = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a;
    while ((a = are.exec(body))) {
      const k = a[1].toLowerCase();
      if (!attrs.has(k)) attrs.set(k, a[2] ?? a[3] ?? a[4] ?? '');
    }
    const selfClosing = /\/\s*>$/.test(raw);
    yield { type: 'start', raw, name, attrs, selfClosing };
    if (RAW_TEXT.has(name) && !selfClosing) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      const stop = close < 0 ? n : close;
      if (stop > i) yield { type: 'text', raw: html.slice(i, stop), rawText: true };
      i = stop;
    }
  }
}

// ---------- 主體 ----------

export class HTMLRewriter {
  constructor() { this._el = []; this._doc = []; }
  on(selector, handlers) { this._el.push({ parts: parseSelector(selector), h: handlers }); return this; }
  onDocument(handlers) { this._doc.push(handlers); return this; }

  transform(response) {
    const ct = response.headers.get('content-type') || '';
    if (ct && !/html/i.test(ct)) return response;
    const self = this;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    const body = new ReadableStream({
      async start(controller) {
        try {
          const html = response.body ? await response.text() : '';
          controller.enqueue(new TextEncoder().encode(await self._rewrite(html)));
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }

  async _rewrite(html) {
    let out = '';
    const stack = [];        // { el, index, childCount, skip, keep, raw }
    let skipDepth = 0;       // >0：在被移除 / 被替換內容的元素裡面
    const rootCounter = { childCount: 0 };
    const handlersFor = (kind) => this._el.filter((r) => r.h[kind] && selectorMatch(r.parts, stack));
    const textHandlers = () => {
      const hs = [];
      for (const r of this._el) {
        if (!r.h.text) continue;
        // 文字屬於比對到的元素（含其後代）
        for (let k = stack.length - 1; k >= 0; k--) {
          if (selectorMatch(r.parts, stack, k)) { hs.push(r.h); break; }
        }
      }
      return hs;
    };

    for (const tok of tokenize(html)) {
      if (tok.type === 'start') {
        if (skipDepth > 0) { if (!VOID.has(tok.name) && !tok.selfClosing) skipDepth++; continue; }
        const parent = stack[stack.length - 1] || rootCounter;
        const el = new Element(tok.name, tok.attrs, tok.selfClosing);
        const node = { el, index: parent.childCount++, childCount: 0, raw: tok.raw };
        stack.push(node);
        for (const r of handlersFor('element')) await r.h.element(el);
        const isVoid = VOID.has(tok.name) || tok.selfClosing;
        if (el._m.removed && !el._keepContent) {
          out += el._m.before + (el._m.replacement ?? '');
          stack.pop();
          if (isVoid) { out += el._m.after; } else { node.skip = true; skipDepth = 1; node.pendingAfter = el._m.after; stack.push(node); }
          continue;
        }
        out += el._m.before;
        if (!el._keepContent) out += el._startTag(tok.raw);
        out += el._prepend;
        if (isVoid) {
          stack.pop();
          out += el._append + el._m.after;
          continue;
        }
        if (el._inner !== null) { out += el._inner; node.skip = true; skipDepth = 1; }
        continue;
      }
      if (tok.type === 'end') {
        if (skipDepth > 1) { skipDepth--; continue; }
        // 找對應的開始標籤（容忍沒關好的 HTML）
        let k = stack.length - 1;
        while (k >= 0 && stack[k].el.tagName !== tok.name) k--;
        if (k < 0) { if (skipDepth === 0) out += tok.raw; continue; }
        while (stack.length - 1 > k) await closeNode(stack.pop(), null);
        skipDepth = 0;
        await closeNode(stack.pop(), tok);
        continue;
      }
      if (skipDepth > 0) continue;
      if (tok.type === 'text') {
        const hs = [...textHandlers(), ...this._doc.filter((d) => d.text)];
        if (!hs.length) { out += tok.raw; continue; }
        const chunk = new TextChunk(tok.raw);
        for (const h of hs) await h.text(chunk);
        out += emitMut(chunk._m, tok.raw);
        continue;
      }
      if (tok.type === 'comment') {
        const hs = [];
        for (const r of this._el) if (r.h.comments && stack.some((_, k) => selectorMatch(r.parts, stack, k))) hs.push(r.h);
        hs.push(...this._doc.filter((d) => d.comments));
        if (!hs.length) { out += tok.raw; continue; }
        const c = new Comment(tok.text);
        for (const h of hs) await h.comments(c);
        out += emitMut(c._m, c.text === tok.text ? tok.raw : `<!--${c.text}-->`);
        continue;
      }
      if (tok.type === 'doctype') {
        const m = /^<!doctype\s+([^\s>]+)?(?:\s+public\s+"([^"]*)")?(?:\s+"([^"]*)")?/i.exec(tok.raw) || [];
        for (const d of this._doc) if (d.doctype) await d.doctype({ name: m[1] ?? null, publicId: m[2] ?? null, systemId: m[3] ?? null });
        out += tok.raw;
      }
    }
    while (stack.length) await closeNode(stack.pop(), null);
    const end = new DocumentEnd();
    for (const d of this._doc) if (d.end) await d.end(end);
    return out + end._append;

    async function closeNode(node, tok) {
      const el = node.el;
      if (node.skip && el._m.removed) { out += node.pendingAfter ?? el._m.after; return; }
      const end = new EndTag(el.tagName);
      for (const h of el._endHandlers) await h(end);
      out += el._append;
      if (!el._keepContent) out += emitMut(end._m, tok ? tok.raw : '');
      else out += end._m.before + end._m.after;
      out += el._m.after;
    }
  }
}
