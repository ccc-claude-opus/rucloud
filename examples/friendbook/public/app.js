// friendbook 前端：單頁 vanilla JS，只跟 /api 溝通
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const headers = { ...opts.headers };
  if (!(opts.body instanceof FormData)) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  const r = await fetch(path, {
    credentials: 'same-origin',
    ...opts,
    headers,
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* 精簡回應 */ }
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
};

const state = { me: null, tab: 'recommend', cursor: null, postId: null, mode: localStorage.getItem('viewMode') || 'markdown' };

// ---------- 工具 ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 行內 markdown（在已 escape 的字串上處理）：`code`、**粗體**、*斜體*、[文字](連結)、裸網址
function mdInline(e) {
  return e
    .replace(/`([^`\n]{1,200})`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]{1,200})\*\*/g, '<b>$1</b>')
    .replace(/\*([^*\n]{1,200})\*/g, '<i>$1</i>')
    .replace(/\[([^\]\n]{1,100})\]\((https?:\/\/[^)\s]{1,300})\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(（])((?:https?:\/\/)[^\s<>()&#]+[^\s<>().,!?&#])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

// 區塊化（逐行解析）+ GFM 表格 + TeX + mermaid：
//   markdown 主體交給 marked（GFM 表格、autolink、清單等），
//   TeX（$$…$$ / \(…\) / \[…\] / $…$）在 parse 前用 token 保護，輸出成 .math-tex 待 KaTeX 渲染，
//   ```mermaid 圍欄輸出後由 decorateRich() 換成 mermaid 圖（函式庫按需動態載入）。
function renderMd(raw) {
  if (!(window.marked && window.DOMPurify)) return renderPlain(raw); // 函式庫還沒載入就先純文字
  const math = [];
  const stripDelims = (t) => (t.startsWith('$$') || t.startsWith('\\[') || t.startsWith('\\('))
    ? t.slice(2, -2) : t.slice(1, -1);
  const protect = raw.replace(
    /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^\s$][^$\n]*?[^\s$]\$|\$[^\s$]\$)/g,
    (m) => {
      math.push(m);
      // 區塊數學獨立成段，行內數學原地保持
      return (m.startsWith('$$') || m.startsWith('\\['))
        ? `\n\n@@FBMATH${math.length - 1}@@\n\n`
        : `@@FBMATH${math.length - 1}@@`;
    });
  let html = marked.parse(protect, { gfm: true, breaks: true });
  html = html.replace(/@@FBMATH(\d+)@@/g, (m, i) => {
    const t = math[Number(i)] || '';
    const display = t.startsWith('$$') || t.startsWith('\\[');
    const inner = esc(stripDelims(t).slice(0, 500));
    return display
      ? `<div class="math-tex math-display" data-disp="1">${inner}</div>`
      : `<span class="math-tex" data-disp="0">${inner}</span>`;
  });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, ADD_ATTR: ['target', 'rel'] });
}

// 插入 DOM 後的富文本修飾：KaTeX 渲染數學式、mermaid 圖表按需載入並渲染
let mermaidLib = null;
function loadMermaid() {
  mermaidLib ||= new Promise((res) => {
    const s = document.createElement('script');
    s.src = 'vendor/mermaid.min.js';
    s.onload = () => {
      window.mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
      res(window.mermaid);
    };
    s.onerror = () => res(null);
    document.head.appendChild(s);
  });
  return mermaidLib;
}

function decorateRich(root) {
  if (state.mode !== 'markdown') return;
  if (!(window.marked && window.DOMPurify)) { // 庫還在載，載好後重跑一次
    setTimeout(() => decorateRich(root), 200);
    return;
  }
  root.querySelectorAll('.math-tex').forEach((el) => {
    if (el.dataset.done) return;
    el.dataset.done = '1';
    try { window.katex.render(el.textContent, el, { displayMode: el.dataset.disp === '1', throwOnError: false }); }
    catch (e) { /* TeX 有錯就照原文顯示 */ }
  });
  const blocks = [...root.querySelectorAll('code.language-mermaid')];
  if (blocks.length) {
    const divs = blocks.map((c) => {
      const d = document.createElement('div');
      d.className = 'mermaid-source'; // 先文字呈現，避免語法錯誤時畫面爛掉
      d.textContent = c.textContent;
      c.closest('pre').replaceWith(d);
      return d;
    });
    loadMermaid().then((m) => {
      if (!m) return;
      m.run({ nodes: divs }).catch(() => { /* mermaid.run 失敗就維持原始碼顯示 */ });
    });
  }
}

// 純文字模式：保留換行；網址自動變連結（YouTube 之後再轉成嵌入影片），#標籤 一樣高亮
function renderPlain(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map((b) => `<p>${mdInline(b.replace(/\n/g, '<br>'))}</p>`)
    .join('');
}

// 貼文文字渲染：markdown 或 純文字，兩種模式都保留換行；#標籤 高亮、YouTube 網址嵌影片
function renderText(text) {
  const html = state.mode === 'markdown' ? renderMd(text) : renderPlain(text);
  // 只在標籤外處理（視覺起頭是行首、空白或前一個標籤的結尾 >），連結等屬性內不會中招
  const tagged = html.replace(/(^|[\s(（>])#([^\s#<>]{1,24})/g, (m, pre, t) => `${pre}<span class="post-tag">#${t}</span>`);
  return embedifyYouTube(tagged);
}

// YouTube 網址轉 iframe：
//   排版後模式是 <a href=...>；純文字模式也會先自動連結再轉，兩種模式都能看影片
function embedifyYouTube(html) {
  return html.replace(/<a href="(https?:\/\/[^"]*?(?:youtube\.com|youtu\.be)[^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    (m, href, label) => {
      const id = (href.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/) || [])[1];
      if (!id) return m;
      return `<div class="yt-embed"><iframe src="https://www.youtube-nocookie.com/embed/${id}" loading="lazy" title="${esc((label.match(/https?:\/\/\S+/) || [href])[0])}" allowfullscreen allow="encrypted-media"></iframe></div>`;
    });
}

const avatarInitial = (name) => esc(((name || '?').match(/[a-z0-9]/i) || [])[0] || '?').toUpperCase();

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 1000;
  if (s < 60) return '剛剛';
  if (s < 3600) return `${s / 60 | 0} 分鐘`;
  if (s < 86400) return `${s / 3600 | 0} 小時`;
  if (s < 86400 * 7) return `${s / 86400 | 0} 天`;
  return (iso || '').slice(0, 10);
}

// ---------- 貼文渲染 ----------

function postHTML(p) {
  const likeBtn = `
    <button class="act like ${p.likedByMe ? 'on' : ''}" data-post-act="like"
      data-id="${p.id}" data-liked="${p.likedByMe ? 1 : 0}">
      ♥ ${p.likes + (state.me && p.likedByMe ? 0 : 0)}</button>`;
  return `
  <article class="post" data-id="${p.id}">
    <div class="post-head">
      <span class="avatar" data-open-user="${esc(p.author.name)}">${avatarInitial(p.author.name)}</span>
      <span class="post-user" data-open-user="${esc(p.author.name)}">${esc(p.author.name)}</span>
      <span class="post-time">${timeAgo(p.createdAt)}</span>
    </div>
    <div class="post-text" data-open-post="${p.id}">${renderText(p.text)}</div>
    ${p.image ? `<img class="post-image" src="${esc(p.image)}" loading="lazy" alt="貼圖" data-open-post="${p.id}">` : ''}
    <div class="post-actions">
      ${likeBtn}
      <button class="act" data-open-post="${p.id}">💬 ${p.comments}</button>
      ${p.mine ? `<button class="act del" data-post-act="del" data-id="${p.id}">刪除</button>` : ''}
    </div>
  </article>`;
}

function renderFeed(res) {
  const feed = $('feed');
  if (!state.cursor) feed.innerHTML = '';
  if (!res.posts.length && !state.cursor) {
    feed.innerHTML = `<div class="empty">${{ following: '還沒追蹤任何人，去點別人的名字吧！', mine: '還沒發過筆記。', hot: '今天還沒有人被按讚。' }[state.tab] || '還沒有任何筆記，發第一篇吧！'}</div>`;
  }
  feed.insertAdjacentHTML('beforeend', res.posts.map(postHTML).join(''));
  decorateRich($('feed'));
  state.cursor = res.nextCursor;
  $('feed-more').hidden = !res.nextCursor;
}

async function loadFeed(reset = true) {
  if (reset) state.cursor = null;
  const res = await api(`/api/feed?tab=${state.tab}${state.cursor ? `&cursor=${state.cursor}` : ''}`);
  renderFeed(res);
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('feed').innerHTML = '<div class="empty">載入中…</div>';
  loadFeed().catch((e) => { $('feed').innerHTML = `<div class="empty">${esc(e.message)}</div>`; });
}

// ---------- 發文 ----------

const POST_MAX = 10000;

function composeCount() {
  const n = $('compose-text').value.length;
  const over = n > POST_MAX;
  $('compose-count').textContent = over
    ? `超過字數限制：${n} / ${POST_MAX}，請刪減後再發佈`
    : `${n} / ${POST_MAX}`;
  $('compose-count').classList.toggle('over', over);
  $('compose-go').disabled = over;
}

const openCompose = () => {
  $('compose-text').value = '';
  $('compose-msg').textContent = '';
  setComposeImage('');
  $('compose-modal').hidden = false;
  composeCount();
  $('compose-text').focus();
};
const closeCompose = () => { $('compose-modal').hidden = true; };

// ---------- 發文圖片（剪貼簿 ⌘V / 拖放 / 選圖）----------

function setComposeImage(url) {
  state.composeImage = url;
  $('compose-image').hidden = !url;
  if (url) $('compose-image-preview').src = url;
  $('compose-msg').textContent = url ? '' : $('compose-msg').textContent;
}

async function sendImage(file) {
  if (!IMAGE_TYPES_OK.includes(file.type)) { $('compose-msg').textContent = '只支援 jpeg / png / webp / gif'; return; }
  if (file.size > 5 * 1024 * 1024) { $('compose-msg').textContent = '圖片最大 5MB'; return; }
  const fd = new FormData();
  fd.append('image', file);
  try {
    const { url } = await api('/api/upload', { method: 'POST', body: fd });
    setComposeImage(url);
  } catch (e) { $('compose-msg').textContent = e.message; }
}

const IMAGE_TYPES_OK = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

async function sendPost() {
  const text = $('compose-text').value;
  if (text.length > POST_MAX) return; // 貼文前再檢查一次，超限不送出
  if (!text.trim() && !state.composeImage) { $('compose-msg').textContent = '寫點內容吧，或貼一張圖'; return; }
  try {
    await api('/api/posts', {
      method: 'POST',
      body: JSON.stringify({ text, image: state.composeImage || '' }),
    });
    closeCompose();
    switchTab(state.tab === 'mine' ? 'mine' : state.tab);
    loadFeed();
  } catch (e) { $('compose-msg').textContent = e.message; }
}

// ---------- 貼文詳情 ----------

async function openPost(id) {
  state.postId = id;
  $('post-modal').hidden = false;
  $('comment-input').focus();
  await refreshPost();
}

async function refreshPost() {
  try {
    const { post, comments, views } = await api(`/api/posts/${state.postId}`);
    $('post-detail').innerHTML = `
      ${postHTML(post)}
      <div class="post-time">${views} 次瀏覽</div>
      ${comments.map((c) => `
        <div class="comment">
          <div class="comment-head">
            <span class="comment-user" data-open-user="${esc(c.name)}">${esc(c.name)}</span>
            <span class="post-time">${timeAgo(c.created_at)}</span>
            ${c.mine ? `<button class="del" data-comment-del="${c.id}">刪除</button>` : ''}
          </div>
          <div class="post-text" style="font-size:14px">${renderText(c.text)}</div>
        </div>`).join('')}`;
    decorateRich($('post-detail'));
  } catch (e) {
    $('post-detail').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

const closePost = () => { $('post-modal').hidden = true; state.postId = null; };

async function sendComment() {
  const text = $('comment-input').value.trim();
  if (!text || !state.postId) return;
  try {
    await api(`/api/posts/${state.postId}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
    $('comment-input').value = '';
    await refreshPost();
  } catch (e) { $('post-detail').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// ---------- 個人頁 ----------

async function openProfile(name) {
  state.profileName = name;
  $('profile-modal').hidden = false;
  $('profile-body').innerHTML = '<div class="empty">載入中…</div>';
  try {
    const { user, followers, following, meFollows, isMe, posts } = await api(`/api/u/${encodeURIComponent(name)}`);
    $('profile-body').innerHTML = `
      <div class="profile-head">
        <div class="avatar">${avatarInitial(user.name)}</div>
        <div class="profile-name">${esc(user.name)}</div>
        <div class="profile-bio">${esc(user.bio || '這個人什麼都沒寫。')}</div>
        <div class="profile-stats">
          <span>追蹤者 ${followers}</span><span>追蹤中 ${following}</span><span>筆記 ${posts.length}</span>
        </div>
        ${!isMe ? `<button class="primary" id="follow-btn" data-follow="${user.id}" data-following="${meFollows ? 1 : 0}">${meFollows ? '取消追蹤' : '追蹤'}</button>` : ''}
      </div>
      ${posts.map(postHTML).join('') || '<div class="empty">還沒有任何筆記。</div>'}`;
    decorateRich($('profile-body'));
    state.profileData = { user, isMe };
  } catch (e) {
    $('profile-body').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

// ---------- 事件 ----------

document.body.addEventListener('click', async (ev) => {
  const t = ev.target;

  const openUser = t.closest('[data-open-user]');
  if (openUser) { ev.stopPropagation(); closePost(); return openProfile(openUser.dataset.openUser); }

  const openPostEl = t.closest('[data-open-post]');
  if (openPostEl) { ev.stopPropagation(); return openPost(Number(openPostEl.dataset.openPost)); }

  const act = t.closest('[data-post-act]');
  if (act) {
    const id = act.dataset.id;
    ev.stopPropagation();
    if (act.dataset.postAct === 'like') {
      try {
        const { liked, likes } = await api(`/api/posts/${id}/like`, { method: 'POST' });
        act.dataset.liked = liked ? 1 : 0;
        act.classList.toggle('on', liked);
        act.textContent = `♥ ${likes}`;
      } catch (e) { alert(e.message); }
    }
    if (act.dataset.postAct === 'del') {
      if (!confirm('刪掉這篇筆記？')) return;
      act.textContent = '刪除中…';
      try {
        await api(`/api/posts/${id}`, { method: 'DELETE' });
        loadFeed();
      } catch (e) { alert(e.message); }
    }
    return;
  }

  const cd = t.closest('[data-comment-del]');
  if (cd) { await api(`/api/comments/${cd.dataset.commentDel}`, { method: 'DELETE' }); return refreshPost(); }

  const fb = t.closest('[data-follow]');
  if (fb) {
    const { following } = await api(`/api/follow/${fb.dataset.follow}`, { method: 'POST' });
    fb.textContent = following ? '取消追蹤' : '追蹤';
    return;
  }
});

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('feed-more').addEventListener('click', () => loadFeed(false));

// ---------- 檢視模式（純文字 / Markdown）----------

// ---------- 檢視模式（純文字 / 排版後）單鈕切換 ----------

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('viewMode', mode);
  const label = mode === 'markdown' ? '排版後' : '純文字';
  $('mode-toggle').textContent = label;
  loadFeed();                       // 重畫動態牆
  if (state.postId) refreshPost();  // 詳情視窗開著就重畫
  if (state.profileName) openProfile(state.profileName); // 個人頁開著就重畫
}
$('mode-toggle').addEventListener('click', () => setMode(state.mode === 'markdown' ? 'plain' : 'markdown'));
$('compose-btn').addEventListener('click', openCompose);
$('compose-cancel').addEventListener('click', closeCompose);
$('compose-go').addEventListener('click', sendPost);
$('comment-send').addEventListener('click', sendComment);
$('comment-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendComment(); });
$('compose-text').addEventListener('input', composeCount);
// 剪貼簿貼圖：⌘V 含圖片檔就直接上傳當貼文圖片
$('compose-text').addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((it) => IMAGE_TYPES_OK.includes(it.type));
  if (!item) return; // 文字照常貼上
  e.preventDefault();
  sendImage(item.getAsFile());
});
$('compose-modal').addEventListener('dragover', (e) => e.preventDefault());
$('compose-modal').addEventListener('drop', (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find((f) => IMAGE_TYPES_OK.includes(f.type));
  if (file) sendImage(file);
});
$('compose-pick').addEventListener('click', () => $('compose-file').click());
$('compose-file').addEventListener('change', () => { if ($('compose-file').files[0]) sendImage($('compose-file').files[0]); $('compose-file').value = ''; });
$('compose-image-remove').addEventListener('click', () => setComposeImage(''));
$('post-close').addEventListener('click', closePost);
const closeProfile = () => { $('profile-modal').hidden = true; state.profileName = null; };
$('profile-close').addEventListener('click', closeProfile);
[$('compose-modal'), $('post-modal'), $('profile-modal')].forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) { m.hidden = true; if (m === $('profile-modal')) state.profileName = null; } }));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeCompose(); closePost(); closeProfile(); }
});

// ---------- 帳號 ----------

let authMode = 'login';
function setAuthMode(m) {
  authMode = m;
  $('a-name-row').hidden = m !== 'signup';
  $('a-go').textContent = m === 'login' ? '登入' : '註冊';
  $('a-switch-text').textContent = m === 'login' ? '還沒有帳號？' : '已經有帳號了？';
  $('a-switch').textContent = m === 'login' ? '註冊' : '登入';
  $('a-msg').textContent = '';
}

async function doAuth() {
  $('a-msg').textContent = '';
  const body = { email: $('a-email').value, password: $('a-pass').value };
  if (authMode === 'signup') body.name = $('a-name').value;
  try {
    await api(`/api/${authMode}`, { method: 'POST', body: JSON.stringify(body) });
    await enter();
  } catch (e) { $('a-msg').textContent = e.message; }
}

async function enter() {
  try {
    state.me = await api('/api/me');
    $('view-auth').hidden = true;
    $('view-app').hidden = false;
    $('h-user').textContent = `@${state.me.user.name}`;
    $('h-user').onclick = () => openProfile(state.me.user.name);
    switchTab('recommend');
  } catch (e) {
    state.me = null;
    $('view-auth').hidden = false;
    $('view-app').hidden = true;
  }
}

$('a-go').addEventListener('click', doAuth);
$('a-switch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
$('a-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAuth(); });
$('h-logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); enter(); });

// @(me-chip) 訪客也能逛（只是不能發文按讚）
$('mode-toggle').textContent = state.mode === 'markdown' ? '排版後' : '純文字';
enter();
