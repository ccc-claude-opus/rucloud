// markpedia 前端：hash 路由的維基式 SPA。
// 渲染順序固定為 marked（GFM）→ Mermaid 圖表 → KaTeX 數學，
// 先搬走 mermaid 區塊才掃數學，避免圖表的內容被誤判成 $...$。

const el = document.getElementById('app');

marked.use({ gfm: true });

if (window.mermaid) {
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
}

const LANG_LABEL = { zh: '繁體中文', en: 'English' };
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
let mermaidSeq = 0;

// 入口頁的表格：天、地、文、法、商、理、工、醫、農九大學門與其下轄次分類。
// 每個次分類都是一則條目（#/p/<slug>），學門本身也有一頁。
const PORTAL = [
  { name: '天', slug: 'cat-tian', subs: [
    ['天文', 'cat-astronomy'], ['太空科技', 'cat-space'],
    ['氣象大氣', 'cat-meteorology'], ['行星科學', 'cat-planetary'],
  ] },
  { name: '地', slug: 'cat-di', subs: [
    ['地質', 'cat-geology'], ['海洋', 'cat-ocean'],
    ['地理', 'cat-geography'], ['自然災害', 'cat-hazard'],
  ] },
  { name: '文', slug: 'cat-wen', subs: [
    ['文學', 'cat-literature'], ['語言', 'cat-languages'],
    ['歷史', 'cat-history'], ['哲學', 'cat-philosophy'],
  ] },
  { name: '法', slug: 'cat-fa', subs: [
    ['法律', 'cat-law'], ['政治', 'cat-politics'],
    ['公共政策', 'cat-policy'], ['社會學', 'cat-sociology'],
  ] },
  { name: '商', slug: 'cat-shang', subs: [
    ['經濟', 'cat-economics'], ['經營管理', 'cat-management'],
    ['金融投資', 'cat-finance'], ['會計商法', 'cat-accounting'],
  ] },
  { name: '理', slug: 'cat-li', subs: [
    ['數學', 'cat-math'], ['物理學', 'cat-physics'],
    ['化學', 'cat-chemistry'], ['統計資料', 'cat-statistics'],
  ] },
  { name: '工', slug: 'cat-gong', subs: [
    ['資訊技術', 'cat-info-tech'], ['機械製造', 'cat-mechanic'],
    ['電機電子', 'cat-electrical'], ['土木建築', 'cat-civil'],
  ] },
  { name: '醫', slug: 'cat-yi', subs: [
    ['醫學', 'cat-medicine'], ['公共衛生', 'cat-public-health'],
    ['藥學', 'cat-pharmacy'], ['營養健康', 'cat-nutrition'],
  ] },
  { name: '農', slug: 'cat-nong', subs: [
    ['農業', 'cat-farming'], ['生物', 'cat-biology'],
    ['林漁牧', 'cat-forestry'], ['生命科技', 'cat-biotech'],
  ] },
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { /* 非 JSON 回應就當空物件 */ }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function renderMarkdown(box, src) {
  box.innerHTML = DOMPurify.sanitize(marked.parse(src));

  // mermaid 區塊：language-mermaid 的 code 換成渲染容器
  for (const code of box.querySelectorAll('pre > code.language-mermaid')) {
    const pre = document.createElement('pre');
    pre.className = 'mermaid-box';
    pre.textContent = code.textContent;
    code.parentElement.replaceWith(pre);
  }
  if (window.mermaid) {
    for (const node of box.querySelectorAll('pre.mermaid-box')) {
      try {
        mermaidSeq += 1;
        const { svg } = await mermaid.render(`graph-${mermaidSeq}`, node.textContent);
        node.innerHTML = svg;
        node.className = 'mermaid-box ok';
      } catch (e) {
        node.className = 'mermaid-error';
      }
    }
  }

  // 數學：GitHub 慣例是行內 $...$ 前後留空白、整段用 $$...$$
  if (window.renderMathInElement) {
    renderMathInElement(box, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
      ],
      throwOnError: false,
    });
  }
}

// ---------- 路由 ----------

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  return { segs: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

async function route() {
  const { segs, params } = parseHash();
  try {
    if (!segs.length) return await pagePortal();
    if (segs[0] === 'admin') return await pageHome(params.get('q'));
    if (segs[0] === 'new') return pageNew();
    if (segs[0] === 'p' && segs[1]) return await pageEntry(segs[1], params.get('lang') || 'zh');
    if (segs[0] === 'edit' && segs[1]) return await pageEdit(segs[1], params.get('lang') || 'zh');
    pageMissing(`沒有這一頁。`);
  } catch (e) {
    el.innerHTML = `<div class="page"><p class="error">錯誤：${esc(e.message)}</p></div>`;
  }
}

// ---------- 入口頁 ----------

function pagePortal() {
  document.title = 'Markpedia';
  const rows = PORTAL.map((g) => `
    <tr>
      <th scope="row"><a class="gate" href="#/p/${g.slug}">${esc(g.name)}</a></th>
      <td>${g.subs.map(([label, slug]) =>
        `<a href="#/p/${slug}">${esc(label)}</a>`).join(' · ')}</td>
    </tr>`).join('\n');

  el.innerHTML = `
    <div class="page">
      <h1>入口頁</h1>
      <table class="portal-table">
        <thead><tr><th>學門</th><th>次分類</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ---------- 條目清單／搜尋 ----------

function groupBySlug(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.slug)) map.set(e.slug, { slug: e.slug, langs: {} });
    map.get(e.slug).langs[e.lang] = e;
  }
  return [...map.values()];
}

async function pageHome(q) {
  const { entries } = await api('/api/entries' + (q ? `?q=${encodeURIComponent(q)}` : ''));
  document.title = q ? `搜尋「${q}」 - Markpedia` : '管理員 - Markpedia';

  let body;
  if (q) {
    // 搜尋時不分組，直接列出每個語言版本的命中
    const rows = entries.map((e) => `
      <li>
        <a class="title-link" href="#/p/${e.slug}?lang=${e.lang}">${esc(e.title)}</a>
        <span class="chip">${LANG_LABEL[e.lang]}</span>
        <span class="meta">${esc(e.slug)} · 最後更新 ${e.updatedAt.slice(0, 10)}</span>
      </li>`).join('\n');
    body = `
      <p class="meta">搜尋「${esc(q)}」共命中 ${entries.length} 篇 · <a href="#/admin">查看全部</a></p>
      <ul class="entry-list">${rows || '<li>沒有符合的條目。</li>'}</ul>`;
  } else {
    const rows = groupBySlug(entries).map((g) => {
      const zh = g.langs.zh;
      const en = g.langs.en;
      const first = zh || en;
      const updated = (zh && en
        ? (zh.updatedAt >= en.updatedAt ? zh.updatedAt : en.updatedAt)
        : first.updatedAt).slice(0, 10);
      const chips = LANG_LABEL ? Object.keys(LANG_LABEL).map((l) => g.langs[l]
        ? `<a class="chip${first.lang === l ? ' active' : ''}" href="#/p/${g.slug}?lang=${l}">${LANG_LABEL[l]}</a>`
        : `<a class="chip ghost" href="#/new">尚無${LANG_LABEL[l]}版</a>`).join('\n') : '';
      return `
      <li>
        <a class="title-link" href="#/p/${g.slug}?lang=${first.lang}">${esc(first.title)}</a>
        <br>${chips}
        <span class="meta">${esc(g.slug)} · 最後更新 ${updated}</span>
      </li>`;
    }).join('\n');
    body = `
      <h1>管理員</h1>
      <p class="meta"><a href="#/">回入口頁</a> · <a href="#/new">新增條目</a></p>
      <h2>所有條目 (${entries.length})</h2>
      <ul class="entry-list">${rows || '<li>還沒有任何條目。</li>'}</ul>`;
  }

  el.innerHTML = `<div class="page">${body}</div>`;
}

// ---------- 條目頁 ----------

async function pageEntry(slug, lang) {
  let data;
  try {
    data = await api(`/api/entry/${encodeURIComponent(slug)}?lang=${lang}`);
  } catch (e) {
    return pageMissing(`找不到條目「${esc(slug)}」。`);
  }
  const { entry, langs } = data;
  document.title = `${entry.title} - Markpedia`;

  const chips = Object.keys(LANG_LABEL).map((l) => langs[l]
    ? `<a class="chip${entry.lang === l ? ' active' : ''}" href="#/p/${entry.slug}?lang=${l}">${LANG_LABEL[l]}</a>`
    : `<span class="chip ghost" title="尚未建立這個語言版本">${LANG_LABEL[l]}</span>`).join('\n');

  el.innerHTML = `
    <div class="page">
      <div class="lang-tabs">${chips}</div>
      <h1>${esc(entry.title)}</h1>
      <p class="meta">
        最後更新 ${entry.updatedAt.slice(0, 10)} ·
        <a href="#/edit/${entry.slug}?lang=${entry.lang}">編輯此頁</a> ·
        <button class="danger" id="delete-btn">刪除</button>
      </p>
      <article id="body"></article>
    </div>`;

  await renderMarkdown(document.getElementById('body'), entry.body);

  document.getElementById('delete-btn').addEventListener('click', async () => {
    if (!confirm(`確定要刪除條目「${entry.title}」？\n將刪除它的所有語言版本。`)) return;
    try {
      await api(`/api/entry/${entry.slug}?lang=all`, { method: 'DELETE' });
      location.hash = '/';
    } catch (e) {
      alert(`刪除失敗：${e.message}`);
    }
  });
}

function pageMissing(msg) {
  document.title = '找不到頁面 - Markpedia';
  el.innerHTML = `
    <div class="page">
      <h1>找不到頁面</h1>
      <p>${msg}</p>
      <p><a href="#/new">新增條目</a> 或 <a href="#/">回首頁</a>。</p>
    </div>`;
}

// ---------- 新增／編輯 ----------

function editorHtml(state) {
  const slugField = state.isNew
    ? `<input id="f-slug" required placeholder="cloudflare-workers">`
    : `<input id="f-slug" value="${esc(state.slug)}" disabled>`;
  const cancelHref = state.isNew ? '#/' : `#/p/${state.slug}?lang=${state.origLang}`;
  const heading = state.isNew ? '新增條目' : `編輯「${esc(state.title)}」`;
  return `
    <div class="page">
      <h1>${heading}</h1>
      <form id="entry-form">
        <label>條目代稱 slug（小寫英文、數字與 -）</label>
        ${slugField}
        <label>語言</label>
        <select id="f-lang"${state.isNew ? '' : ' disabled'}>
          <option value="zh">繁體中文</option>
          <option value="en">English</option>
        </select>
        <label>標題</label>
        <input id="f-title" value="${esc(state.title || '')}" required>
        <label>內容（GitHub Flavored Markdown）</label>
        <textarea id="f-body" rows="22">${esc(state.body || '')}</textarea>
        <p class="muted">提示：行內數學用 $...$ 且前後留一個空白，整段公式用 $$...$$，
        圖表用 mermaid 的程式碼區塊，表格用直線與減號。</p>
        <p id="form-error" class="error" hidden></p>
        <div class="row">
          <button type="submit">${state.isNew ? '建立' : '儲存'}</button>
          <button type="button" id="preview-btn">預覽</button>
          <a class="btn" href="${cancelHref}">取消</a>
        </div>
      </form>
      <section id="preview" class="page preview" hidden></section>
    </div>`;
}

function wireEditor(state) {
  document.getElementById('f-lang').value = state.isNew ? state.lang : state.origLang;

  document.getElementById('preview-btn').addEventListener('click', async () => {
    const box = document.getElementById('preview');
    if (box.hidden) {
      box.hidden = false;
      await renderMarkdown(box, document.getElementById('f-body').value);
      document.getElementById('preview-btn').textContent = '收起預覽';
    } else {
      box.hidden = true;
      document.getElementById('preview-btn').textContent = '預覽';
    }
  });

  document.getElementById('entry-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const errBox = document.getElementById('form-error');
    errBox.hidden = true;
    const slug = state.isNew
      ? document.getElementById('f-slug').value.trim()
      : state.slug;
    const lang = state.isNew
      ? document.getElementById('f-lang').value
      : state.origLang;
    const title = document.getElementById('f-title').value.trim();
    const body = document.getElementById('f-body').value;

    if (state.isNew && !SLUG_RE.test(slug)) {
      errBox.textContent = 'slug 只能用小寫英文、數字與 -（第一位須為英數）。';
      errBox.hidden = false;
      return;
    }
    const payload = JSON.stringify(state.isNew
      ? { slug, lang, title, body }
      : { lang: state.origLang, title, body });
    try {
      if (state.isNew) {
        await api('/api/entries', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
        location.hash = `/p/${slug}?lang=${lang}`;
      } else {
        await api(`/api/entry/${state.slug}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });
        location.hash = `/p/${state.slug}?lang=${state.origLang}`;
      }
    } catch (e) {
      errBox.textContent = e.message;
      errBox.hidden = false;
    }
  });
}

function pageNew() {
  document.title = '新增條目 - Markpedia';
  el.innerHTML = editorHtml({ isNew: true, slug: '', lang: 'zh', title: '', body: '' });
  wireEditor({ isNew: true, lang: 'zh' });
}

async function pageEdit(slug, lang) {
  let data;
  try {
    data = await api(`/api/entry/${encodeURIComponent(slug)}?lang=${lang}`);
  } catch (e) {
    return pageMissing(`找不到條目「${esc(slug)}」，無法編輯。`);
  }
  const { entry, langs } = data;
  document.title = `編輯 ${entry.title} - Markpedia`;
  el.innerHTML = editorHtml({
    isNew: false,
    slug: entry.slug,
    origLang: entry.lang,
    title: entry.title,
    body: entry.body,
  });
  wireEditor({ isNew: false, slug: entry.slug, origLang: entry.lang });
}

// ---------- 啟動 ----------

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = document.getElementById('search-input').value.trim();
  location.hash = q ? `/admin?q=${encodeURIComponent(q)}` : '/';
});

document.getElementById('random-link').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const { slug } = await api('/api/random');
    location.hash = `/p/${slug}`;
  } catch (err) { alert(err.message); }
});

window.addEventListener('hashchange', route);
route();
