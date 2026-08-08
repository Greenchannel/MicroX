/**
 * app.js — MicroX 前端逻辑
 *
 * 作用:
 *   纯原生 JS 的 SPA: hash 路由 + fetch 调用 /api/* + DOM 渲染。
 *   无任何框架与构建步骤, 浏览器直接加载。
 *
 * 页面与路由:
 *   #/                首页(发帖(带图)/时间线/评论回复点赞/打赏)
 *   #/login           登录/注册
 *   #/search          搜索页
 *   #/user/:name      用户主页(bio/CCB/举报用户)
 *   #/messages        私信会话列表
 *   #/messages/:name  聊天窗(3 秒轮询 + 自定义气泡样式 + 转账)
 *   #/store           商店(头像框/聊天气泡/文件商品, 买断/订阅, 开店卖货)
 *   #/tickets         工单(开单/我的工单)
 *   #/settings        设置(改名/bio/头像/CCB)
 *   #/admin           管理页: 用户/私信/工单/举报/商品(仅管理员)
 *
 * 安全:
 *   所有用户输入渲染前一律 escapeHtml 转义;
 *   图片/文件展示统一走 /uploads/ 静态路径或带权限的下载接口;
 *   服务端返回的 CSS 样式片段(头像框/气泡)为服务端清洗过的数据。
 */
'use strict';

// ---------- 全局状态 ----------

let me = null;

const timelineState = { sort: 'latest', page: 1, hasMore: true };
const profileState = { username: '', page: 1, hasMore: true };
const chatState = { username: '', otherBubble: '', lastId: 0, timer: null, otherType: '', waitingBot: false, waitingBotSince: 0, typingTimer: null };
const storeState = { type: '', page: 'items' };

const AVATAR_COLORS = ['#1d9bf0', '#f91880', '#7856ff', '#00ba7c', '#ffd400', '#ff7a00'];

const LIMIT = 280;
const DM_MAX = 500;
const TIP_OPTIONS = [10, 50, 100];

// ---------- 基础工具 ----------

const $ = (sel, root = document) => root.querySelector(sel);

/**
 * 统一的 fetch 封装: 解析 JSON 并检查 ok 字段。
 * @throws {Error} 请求失败或业务错误
 */
async function api(method, url, body = null) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    throw new Error(`网络错误(${res.status})`);
  }
  if (!json.ok) throw new Error(json.error || '请求失败');
  return json.data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(datetime) {
  const date = new Date(datetime.replace(' ', 'T') + 'Z');
  const diff = (Date.now() - date.getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}天前`;
  return date.toISOString().slice(0, 10);
}

/** 格式化为 "YYYY-MM-DD HH:MM" */
function formatDateTime(datetime) {
  return String(datetime || '').slice(0, 16);
}

/**
 * 生成头像 HTML。有头像显示图片, 无头像用首字符+哈希底色。
 * @param {object} user { username, avatar, avatar_frame_css }
 * @param {string} size 尺寸类名
 * @param {string|null} href 可选跳转
 * @param {string} css 可选头像框样式(作用在 wrapper 上)
 */
function avatarHtml(user, size, href = null, css = '') {
  const letter = escapeHtml([...(user.username || '?')][0].toUpperCase());
  const color = AVATAR_COLORS[[...(user.username || '')].reduce((s, c) => s + c.codePointAt(0), 0) % AVATAR_COLORS.length];
  const inner = user.avatar
    ? `<img src="/uploads/${encodeURIComponent(user.avatar)}" alt="头像">`
    : `<span style="background:${color}">${letter}</span>`;
  const tag = href ? 'a' : 'span';
  const styleAttr = css ? ` style="${escapeHtml(css)}"` : '';
  return `<${tag} class="avatar ${size}"${styleAttr} ${href ? `href="${href}"` : ''}>${inner}</${tag}>`;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { el.hidden = true; }, 2600);
}

function emptyHtml(text = '这里空空如也') {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.innerHTML = `<img src="${escapeHtml(src)}" alt="预览">`;
  overlay.addEventListener('click', () => overlay.remove());
  document.body.appendChild(overlay);
}

/**
 * 将图片文件压缩为 dataURL(头像方形裁剪 / 帖子等比缩放)。
 * @param {File} file 图片文件
 * @param {object} opts { size, square }
 */
function fileToDataUrl(file, opts) {
  const size = opts.size || 800;
  const square = !!opts.square;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片解析失败'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        if (square) {
          const side = Math.min(img.width, img.height);
          canvas.width = size;
          canvas.height = size;
          canvas.getContext('2d').drawImage(
            img,
            (img.width - side) / 2, (img.height - side) / 2, side, side,
            0, 0, size, size
          );
        } else {
          const scale = Math.min(1, size / Math.max(img.width, img.height));
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        }
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 格式化文件大小 */
function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ---------- 帖子卡片 ----------

function postHtml(post) {
  const liked = post.liked_by_me ? 1 : 0;
  const likeClass = liked ? 'btn-like liked' : 'btn-like';
  const heartPath = liked
    ? '<path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>'
    : '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>';
  const authorHref = `#/user/${encodeURIComponent(post.author)}`;
  const canDelete = me && (me.id === post.author_id || me.is_admin === 1);
  const delBtn = canDelete
    ? `<button class="post-del" data-action="delete" title="删除帖子"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M16 6V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2H4v2h1v10a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3V8h1V6h-4zm-6-2h4v2h-4V4zm7 14a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8h10v10z"/></svg></button>`
    : '';
  // 举报按钮: 登录且非自己的帖子
  const reportBtn = me && me.id !== post.author_id
    ? `<button class="btn-report" data-action="report-post" title="举报帖子"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3 2 21h20L12 3zm0 4.2 6.5 11.8h-13L12 7.2zm-1 6v2h2v-2h-2zm0-3v1h2v-1h-2z"/></svg></button>`
    : '';
  const imageHtml = post.image
    ? `<img class="post-image" src="/uploads/${encodeURIComponent(post.image)}" alt="帖子图片" loading="lazy">`
    : '';
  // 打赏按钮: 登录且非自己的帖子
  const tipBtn = me && me.id !== post.author_id
    ? `<button class="btn-tip${post.tipped_by_me ? ' tipped' : ''}" data-action="tip" title="打赏">
        <svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2 15 9l7 1-5 4.5L18.5 22 12 18.3 5.5 22 7 14.5 2 10l7-1 3-7z"/></svg>
        <span class="tip-count">${post.tip_count}</span>
      </button>`
    : '';
  return `
    <article class="post" data-id="${post.id}">
      ${avatarHtml({ username: post.author, avatar: post.author_avatar }, 'avatar-sm', authorHref, post.author_frame)}
      <div class="post-body">
        <div class="post-head">
          <a class="post-author" href="${authorHref}">${escapeHtml(post.author)}</a>
          ${botBadgeHtml({ account_type: post.author_type })}
          ${titleBadge(post.author_title, post.author_title_css)}
          <span class="post-time">${formatTime(post.created_at)}</span>
          ${reportBtn}
          ${delBtn}
        </div>
        <p class="post-content">${escapeHtml(post.content)}</p>
        ${imageHtml}
        <div class="post-actions">
          <button class="${likeClass}" data-action="like" title="点赞">
            <svg viewBox="0 0 24 24">${heartPath}</svg>
            <span class="like-count">${post.like_count}</span>
          </button>
          <button class="btn-comment" data-action="comments" data-id="${post.id}" title="评论">
            <svg viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="2" d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>
            <span class="comment-count">${post.comment_count}</span>
          </button>
          <span class="tip-wrap">${tipBtn}</span>
        </div>
        <div class="comment-section" id="comment-section-${post.id}" hidden></div>
      </div>
    </article>`;
}

// ---------- 评论区(回复树 + 点赞) ----------

async function toggleComments(postId, btn) {
  const section = $(`#comment-section-${postId}`);
  if (!section) return;
  if (!section.hidden) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  if (section.dataset.loaded) return;

  section.innerHTML = '<div class="loading" style="padding:16px">加载评论…</div>';
  try {
    const data = await api('GET', `/api/posts/${postId}/comments`);
    section.dataset.loaded = '1';
    renderCommentSection(section, postId, data.comments);
  } catch (err) {
    section.innerHTML = emptyHtml(err.message);
  }
}

/**
 * 渲染评论列表(顶级 + 回复树)与评论输入框。
 * @param {HTMLElement} section 评论容器
 * @param {number} postId 帖子 ID
 * @param {object[]} comments 树形评论数组(顶级含 replies)
 */
function renderCommentSection(section, postId, comments) {
  const inputRow = me
    ? `<form class="comment-input-row" data-comment-form="${postId}">
        <input type="text" maxlength="${LIMIT}" placeholder="写下你的评论…" required>
        <button class="btn btn-primary" style="padding:6px 16px;font-size:13px" type="submit">评论</button>
      </form>`
    : `<div class="empty" style="padding:10px">登录后可评论</div>`;
  // 评论区为空时给出引导, 避免展开后只有输入框造成空白区
  const listHtml = comments.length
    ? comments.map(commentHtml).join('')
    : '<div class="empty" style="padding:14px 0">还没有评论，来说两句吧</div>';
  section.innerHTML = `${inputRow}<div class="comment-list">${listHtml}</div>`;
}

/** 单条评论 HTML(含回复树) */
function commentHtml(c) {
  const canDelete = me && (me.id === c.author_id || me.is_admin === 1);
  const delBtn = canDelete
    ? `<button class="comment-del" data-action="comment-del" data-id="${c.id}">删除</button>`
    : '';
  const liked = c.liked_by_me ? ' liked' : '';
  const heart = c.liked_by_me
    ? '<path fill="currentColor" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>'
    : '<path fill="none" stroke="currentColor" stroke-width="2" d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>';
  const actions = me ? `
    <div class="comment-actions">
      <button class="btn-comment-like${liked}" data-action="comment-like" data-id="${c.id}">
        <svg viewBox="0 0 24 24">${heart}</svg>
        <span class="comment-like-count">${c.like_count}</span>
      </button>
      <button class="btn-comment-reply" data-action="comment-reply" data-id="${c.id}">回复</button>
      <div class="comment-reply-input" data-reply-box="${c.id}" hidden>
        <input type="text" maxlength="${LIMIT}" placeholder="回复 ${escapeHtml(c.author)}…">
        <button class="btn btn-primary" style="padding:4px 14px;font-size:12px" data-reply-send="${c.id}">回复</button>
      </div>
    </div>` : '';
  const replies = (c.replies || []).length
    ? `<div class="comment-replies">${c.replies.map(commentHtml).join('')}</div>`
    : '';
  return `
    <div class="comment" data-id="${c.id}">
      ${avatarHtml({ username: c.author, avatar: c.author_avatar }, 'avatar-sm', `#/user/${encodeURIComponent(c.author)}`, c.author_frame)}
      <div class="comment-body">
        <div class="comment-head">
          <a class="comment-author" href="#/user/${encodeURIComponent(c.author)}">${escapeHtml(c.author)}</a>
          ${botBadgeHtml({ account_type: c.author_type })}
          ${titleBadge(c.author_title, c.author_title_css)}
          <span class="comment-time">${formatTime(c.created_at)}</span>
          ${delBtn}
        </div>
        <p class="comment-text">${escapeHtml(c.content)}</p>
        ${actions}
        ${replies}
      </div>
    </div>`;
}

async function submitComment(postId, content, parentId = null) {
  const data = await api('POST', '/api/comments', { post_id: postId, content, parent_id: parentId });
  me.wallet = data.balance;
  updateWalletUI();
  const section = $(`#comment-section-${postId}`);
  const res = await api('GET', `/api/posts/${postId}/comments`);
  renderCommentSection(section, postId, res.comments);
  const countEl = section.closest('.post').querySelector('.comment-count');
  countEl.textContent = res.comments.reduce((sum, c) => sum + 1 + (c.replies || []).length, 0);
}

// ---------- 发帖框 ----------

function composerHtml() {
  return `
    <div class="composer">
      ${avatarHtml(me, 'avatar-md')}
      <div style="flex:1">
        <textarea id="composer-input" maxlength="${LIMIT}" placeholder="有什么新鲜事？" rows="2"></textarea>
        <div id="composer-img-preview" class="composer-img" hidden></div>
        <div class="composer-foot">
          <div class="composer-tools">
            <label class="btn-image" for="composer-file" title="添加图片">
              <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM5 18V6h14v12H5zm3-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm-1.6 6 2.6-3 2 2.4 3-3.4 3.6 4H6.4z"/></svg>
            </label>
            <input id="composer-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
            <span class="composer-count" id="composer-count">0/${LIMIT}</span>
            <span class="coin-badge">🪙 <span id="composer-wallet">${me.wallet || 0}</span></span>
          </div>
          <button class="btn btn-primary" id="composer-submit" style="padding:8px 20px">发布</button>
        </div>
      </div>
    </div>`;
}

/** 更新所有CCB展示 */
function updateWalletUI() {
  const el = $('#composer-wallet');
  if (el && me) el.textContent = me.wallet ?? 0;
  const walletInSettings = $('#settings-wallet');
  if (walletInSettings && me) walletInSettings.textContent = me.wallet ?? 0;
}

function bindComposer() {
  const input = $('#composer-input');
  const count = $('#composer-count');
  const submit = $('#composer-submit');
  const fileInput = $('#composer-file');
  const preview = $('#composer-img-preview');
  let pendingImage = null;

  const updateCount = () => {
    const len = [...input.value].length;
    count.textContent = `${len}/${LIMIT}`;
    count.classList.toggle('over', len > LIMIT);
    submit.disabled = len < 1 || len > LIMIT;
  };
  input.addEventListener('input', updateCount);
  updateCount();

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast('图片过大，请选择 8MB 以内的图片', true);
      return;
    }
    try {
      pendingImage = await fileToDataUrl(file, { size: 1200, square: false });
      preview.hidden = false;
      preview.innerHTML = `<img src="${pendingImage}" alt="待发布图片"><button type="button" id="composer-img-remove">移除</button>`;
      $('#composer-img-remove').addEventListener('click', () => {
        pendingImage = null;
        preview.hidden = true;
        fileInput.value = '';
      });
    } catch (err) {
      toast(err.message, true);
    }
  });

  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const data = await api('POST', '/api/posts', { content: input.value.trim(), image: pendingImage || undefined });
      me.wallet = data.balance;
      updateWalletUI();
      input.value = '';
      pendingImage = null;
      preview.hidden = true;
      preview.innerHTML = '';
      fileInput.value = '';
      updateCount();
      toast(`发布成功 +${data.reward}CCB`);
      await loadTimeline(true);
    } catch (err) {
      toast(err.message, true);
      submit.disabled = false;
    }
  });
}

// ---------- 首页 ----------

async function renderHome() {
  timelineState.page = 1;
  timelineState.hasMore = true;
  const pageTitle = '<div class="page-title">首页</div>';

  if (!me) {
    $('#main').innerHTML = `${pageTitle}${loginHintHtml()}<div class="empty">登录后查看时间线</div>`;
    return;
  }

  // 禁言横幅: 禁言期间隐藏发帖框
  const muted = isMutedUser(me);
  const banner = muted
    ? `<div class="muted-banner">您已被禁言至 ${me.mute_until.slice(0, 10)}，期间不能发帖/评论/私信</div>`
    : '';

  $('#main').innerHTML = `${pageTitle}${banner}${muted ? '' : composerHtml()}
    <div class="feed-tabs">
      <button class="feed-tab${timelineState.sort === 'latest' ? ' active' : ''}" data-tab="latest">最新</button>
      <button class="feed-tab${timelineState.sort === 'hot' ? ' active' : ''}" data-tab="hot">热门</button>
    </div>
    <div id="feed"></div>`;

  if (!muted) bindComposer();
  // 最新/热门切换
  $('#main').querySelectorAll('.feed-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $('#main').querySelectorAll('.feed-tab').forEach((t) => t.classList.toggle('active', t === tab));
      timelineState.sort = tab.dataset.tab;
      loadTimeline(true);
    });
  });
  await loadTimeline(true);
}

function isMutedUser(user) {
  return user && user.mute_until && user.mute_until > new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function isBannedUser(user) {
  return user && (user.ban_until === 'forever' || (user.ban_until && user.ban_until > new Date().toISOString().slice(0, 19).replace('T', ' ')));
}

async function loadTimeline(reset) {
  if (reset) {
    timelineState.page = 1;
    timelineState.hasMore = true;
  }
  if (!timelineState.hasMore) return;

  const feed = $('#feed');
  if (reset) feed.innerHTML = '<div class="loading">加载中…</div>';

  try {
    const data = await api('GET', `/api/posts?sort=${timelineState.sort}&page=${timelineState.page}`);
    if (reset) feed.innerHTML = '';
    if (data.posts.length === 0) {
      if (reset) feed.innerHTML = emptyHtml('还没有帖子，来发第一条吧！');
      timelineState.hasMore = false;
      return;
    }
    feed.insertAdjacentHTML('beforeend', data.posts.map(postHtml).join(''));
    timelineState.page += 1;
    timelineState.hasMore = data.posts.length >= 20;
    if (timelineState.hasMore) {
      feed.insertAdjacentHTML('beforeend', '<button class="load-more" data-action="load-more">加载更多</button>');
    }
  } catch (err) {
    if (reset) feed.innerHTML = emptyHtml(err.message);
    toast(err.message, true);
  }
}

// ---------- 搜索 ----------

function renderSearchPage() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '';
  $('#main').innerHTML = `
    <div class="page-title">搜索</div>
    <form class="search-page-input" id="search-form">
      <input id="search-input" type="search" placeholder="搜索用户或帖子" value="${escapeHtml(q)}" autocomplete="off">
      <button class="btn btn-primary" type="submit">搜索</button>
    </form>
    <div id="search-result"></div>`;

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const keyword = $('#search-input').value.trim();
    location.hash = keyword ? `#/search?q=${encodeURIComponent(keyword)}` : '#/search';
  });

  if (q) runSearch(q);
}

async function runSearch(q) {
  const box = $('#search-result');
  box.innerHTML = '<div class="loading">搜索中…</div>';
  try {
    const data = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    if (data.users.length === 0 && data.posts.length === 0) {
      box.innerHTML = emptyHtml(`没有找到与“${escapeHtml(q)}”相关的内容`);
      return;
    }
    const parts = [];
    if (data.users.length > 0) {
      parts.push('<div class="search-section-title">用户</div>');
      parts.push(...data.users.map((u) => `
        <a class="post" href="#/user/${encodeURIComponent(u.username)}">
          ${avatarHtml(u, 'avatar-sm', null, u.avatar_frame_css)}
          <div class="post-body"><span class="post-author">${escapeHtml(u.username)} ${titleBadge(u.title, u.title_css)}</span></div>
        </a>`));
    }
    if (data.posts.length > 0) {
      parts.push('<div class="search-section-title">帖子</div>');
      parts.push(...data.posts.map(postHtml));
    }
    box.innerHTML = parts.join('');
  } catch (err) {
    box.innerHTML = emptyHtml(err.message);
  }
}

// ---------- 用户主页 ----------

function renderProfilePage() {
  const name = decodeURIComponent(location.hash.split('#/user/')[1]?.split('?')[0] || '');
  if (!name) return renderHome();
  profileState.username = name;
  profileState.page = 1;
  profileState.hasMore = true;
  $('#main').innerHTML = '<div class="loading">加载中…</div>';
  loadProfile(true);
}

async function loadProfile(reset) {
  if (reset) {
    profileState.page = 1;
    profileState.hasMore = true;
  }
  const main = $('#main');
  try {
    const data = await api('GET', `/api/users/${encodeURIComponent(profileState.username)}?page=${profileState.page}`);
    if (reset) {
      const isMine = me && me.id === data.user.id;
      const dmBtn = me && !isMine
        ? `<a class="btn btn-primary" style="padding:8px 18px;font-size:14px" href="#/messages/${encodeURIComponent(data.user.username)}">发私信</a>`
        : '';
      const followBtn = me && !isMine
        ? `<button class="btn ${data.user.is_following ? 'btn-ghost' : 'btn-primary'}" style="padding:8px 18px;font-size:14px" data-action="follow" data-username="${encodeURIComponent(data.user.username)}" data-following="${data.user.is_following ? 1 : 0}">${data.user.is_following ? '已关注' : '关注'}</button>`
        : '';
      const reportBtn = me && !isMine
        ? `<button class="btn btn-ghost" style="padding:8px 18px;font-size:14px" data-action="report-user" data-id="${data.user.id}">举报该用户</button>`
        : '';
      const bioHtml = data.user.bio
        ? `<p class="profile-bio">${escapeHtml(data.user.bio)}</p>`
        : '';
      main.innerHTML = `
        <div class="page-title">${escapeHtml(data.user.username)} 的主页</div>
        <div class="profile-card">
          <div class="profile-top">
            ${avatarHtml(data.user, 'avatar-lg', null, data.user.avatar_frame_css)}
            <div class="profile-info">
              <div class="profile-username">${escapeHtml(data.user.username)} ${agentBadgeHtml(data.user)} ${titleBadge(data.user.title, data.user.title_css)}</div>
              <div class="profile-joined">加入于 ${data.user.created_at.slice(0, 10)} · CCB <span class="coin">${data.user.wallet}</span></div>
            </div>
          </div>
          ${bioHtml}
          <div class="profile-stats">
            <span>发帖 <b>${data.postCount}</b></span>
            <span>评论 <b>${data.commentCount}</b></span>
            <span>关注 <b data-follow-count>${data.user.following_count}</b></span>
            <span>粉丝 <b data-follower-count>${data.user.follower_count}</b></span>
          </div>
          ${dmBtn || followBtn || reportBtn ? `<div class="profile-actions">${dmBtn}${followBtn}${reportBtn}</div>` : ''}
        </div>
        <div id="feed"></div>`;
    }
    // 查看自己的主页时显示"我的陪聊"管理区
    if (me && me.id === data.user.id) {
      main.insertAdjacentHTML('beforeend', '<div id="my-bots"></div>');
      loadMyBots();
    }
    const feed = $('#feed');
    if (data.posts.length === 0) {
      if (reset) feed.innerHTML = emptyHtml(`${escapeHtml(data.user.username)} 还没有发过帖子`);
      profileState.hasMore = false;
      return;
    }
    feed.insertAdjacentHTML('beforeend', data.posts.map(postHtml).join(''));
    profileState.page += 1;
    profileState.hasMore = data.posts.length >= 20;
    if (profileState.hasMore) {
      feed.insertAdjacentHTML('beforeend', '<button class="load-more" data-action="load-more">加载更多</button>');
    }
  } catch (err) {
    main.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

// ---------- 我的陪聊(个人主页管理区) ----------

async function loadMyBots() {
  const box = $('#my-bots');
  if (!box) return;
  try {
    const data = await api('GET', '/api/bots');
    // 管理员可管理全部陪聊(含他人创建的), 普通用户只看自己创建的
    const isAdmin = me.is_admin === 1;
    const mine = isAdmin ? data.bots : data.bots.filter((b) => b.creator_id === me.id);
    const priceLabel = (b) => b.pricing_type === 'free' ? '免费'
      : b.pricing_type === 'per_reply' ? b.price_per_reply + ' CCB/条'
      : b.pricing_type === 'hybrid' ? b.price_per_reply + ' CCB/条 + ' + b.subscription_price + ' CCB/30天'
      : b.subscription_price + ' CCB/30天';
    const ptypeOptions = (b) => ['free', 'per_reply', 'subscription', 'hybrid'].map((t) =>
      '<option value="' + t + '"' + (b.pricing_type === t ? ' selected' : '') + '>' +
      (t === 'free' ? '免费' : t === 'per_reply' ? '按回复计费' : t === 'hybrid' ? '订阅+按条(混合)' : '按订阅计费') + '</option>').join('');
    let html = `
      <div class="store-section-title">${isAdmin ? '全部陪聊机器人（管理员）' : '我的陪聊机器人（' + mine.length + '/5）'}</div>
      <div class="sell-form">
        <div style="font-weight:700">创建陪聊（像真实用户一样出现在社区，可被搜索和私信）</div>
        <div class="sell-form-row">
          <input id="bot-name" placeholder="名称(2~20位, 唯一)" maxlength="20" style="flex:1">
        </div>
        <div id="bot-api-panel">
          <div class="sell-form-row">
            <input id="bot-api-url" placeholder="API 地址 Base URL，如 https://api.openai.com/v1（Claude 用 https://api.anthropic.com/v1）" style="flex:1;min-width:200px">
          </div>
          <div class="sell-form-row">
            <input id="bot-api-key" type="password" placeholder="API Key">
            <input id="bot-api-model" placeholder="模型，如 gpt-4o / claude-sonnet-4" style="max-width:240px">
          </div>
        </div>
        <div class="sell-form-row">
          <select id="bot-pricing">
            <option value="free">免费</option>
            <option value="per_reply">按回复计费</option>
            <option value="subscription">按订阅计费</option>
            <option value="hybrid">订阅+按条(混合)</option>
          </select>
          <input id="bot-price" type="number" placeholder="按条价(CCB)" min="1" style="max-width:110px">
          <input id="bot-price-sub" type="number" placeholder="订阅价(CCB/30天)" min="1" style="max-width:130px">
        </div>
        <textarea id="bot-persona" placeholder="人设 prompt(1~2000字)：例如 你是一位温柔的深夜树洞，擅长倾听…" rows="3" maxlength="2000"></textarea>
        ${me.is_admin === 1 ? `
          <label class="ds-row" style="font-size:13px;gap:6px">
            <input type="checkbox" id="bot-official"> 设为官方模型（API 由平台提供，收入归平台）
          </label>` : ''}
        <button class="btn btn-primary" id="bot-create" style="align-self:flex-start">创建陪聊</button>
      </div>`;

    if (mine.length === 0) {
      html += emptyHtml('还没有创建陪聊');
    } else {
      html += mine.map((b) => `
        <div class="inventory-item" style="align-items:flex-start">
          ${avatarHtml({ username: b.username, avatar: b.avatar }, 'avatar-sm', null, b.avatar_frame_css)}
          <div class="info">
            <div class="name">${escapeHtml(b.username)} ${botBadgeHtml({ account_type: 'bot' }, b.is_official === 1)}
              ${b.status === 'disabled' ? '<span class="penalty-tag muted">已下架</span>' : '<span class="badge-pending">上架中</span>'}
            </div>
            <div class="sub">计费: ${priceLabel(b)} · 模型: ${escapeHtml(b.api_model || '未配置')} · API: ${b.api_base_url ? '已配置' : '未配置'}</div>
            <textarea data-bot-persona="${b.user_id}" rows="2" maxlength="2000" style="width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:8px 10px;font-size:13px;color:var(--text);resize:vertical;outline:none">${escapeHtml(b.persona)}</textarea>
            <div class="quick-edit">
              <select data-bot-ptype="${b.user_id}">${ptypeOptions(b)}</select>
              <input type="number" data-bot-price="${b.user_id}" value="${b.price_per_reply || ''}" min="1" style="width:80px" title="按条价(CCB)">
              <input type="number" data-bot-price-sub="${b.user_id}" value="${b.subscription_price || ''}" min="1" style="width:90px" title="订阅价(CCB/30天)">
              <button class="btn btn-primary" style="padding:5px 14px;font-size:12px" data-bot-save="${b.user_id}">保存</button>
              <button class="btn btn-ghost" style="padding:5px 14px;font-size:12px" data-bot-apiedit="${b.user_id}">API配置</button>
            </div>
            <div data-bot-apibox="${b.user_id}" hidden>
              <div class="sell-form-row">
                <input data-bot-url="${b.user_id}" placeholder="Base URL" value="${escapeHtml(b.api_base_url)}" style="flex:1">
              </div>
              <div class="sell-form-row">
                <input data-bot-key="${b.user_id}" type="password" placeholder="API Key(留空不修改)">
                <input data-bot-model="${b.user_id}" placeholder="模型" value="${escapeHtml(b.api_model)}" style="max-width:220px">
              </div>
            </div>
            ${me.is_admin === 1 ? `
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-top:6px">
                <input type="checkbox" data-bot-official="${b.user_id}" ${b.is_official === 1 ? 'checked' : ''}> 官方模型（保存时生效）
              </label>` : ''}
            <div class="quick-edit">
              <button class="btn btn-ghost" style="padding:5px 14px;font-size:12px" data-bot-toggle="${b.user_id}" data-status="${b.status}">${b.status === 'active' ? '下架' : '重新上架'}</button>
              <a class="btn btn-ghost" style="padding:5px 14px;font-size:12px" href="#/messages/${encodeURIComponent(b.username)}">开始聊天</a>
              <input data-mem-user="${b.user_id}" placeholder="清除谁的记忆(用户名)" style="width:130px">
              <button class="btn btn-ghost" style="padding:5px 10px;font-size:12px" data-mem-clear="${b.user_id}">清除记忆</button>
            </div>
          </div>
        </div>`).join('');
    }
    box.innerHTML = html;

    // 创建
    $('#bot-create').addEventListener('click', async () => {
      try {
        await api('POST', '/api/bots', {
          name: $('#bot-name').value.trim(),
          persona: $('#bot-persona').value.trim(),
          api_base_url: $('#bot-api-url').value.trim(),
          api_key: $('#bot-api-key').value.trim(),
          api_model: $('#bot-api-model').value.trim(),
          pricing_type: $('#bot-pricing').value,
          price_per_reply: $('#bot-pricing').value === 'per_reply' || $('#bot-pricing').value === 'hybrid' ? Number($('#bot-price').value) : 0,
          subscription_price: $('#bot-pricing').value === 'subscription' || $('#bot-pricing').value === 'hybrid' ? Number($('#bot-price-sub').value) : 0,
          official: me.is_admin === 1 && $('#bot-official') && $('#bot-official').checked,
        });
        toast('陪聊已创建');
        loadMyBots();
      } catch (err) {
        toast(err.message, true);
      }
    });

    // API 配置展开
    box.querySelectorAll('[data-bot-apiedit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const boxEl = box.querySelector('[data-bot-apibox="' + btn.dataset.botApiedit + '"]');
        if (boxEl) boxEl.hidden = !boxEl.hidden;
      });
    });

    // 保存(人设/计费/API 配置)
    box.querySelectorAll('[data-bot-save]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.botSave;
        const ptype = box.querySelector('[data-bot-ptype="' + id + '"]').value;
        const price = Number(box.querySelector('[data-bot-price="' + id + '"]').value);
        const priceSub = Number(box.querySelector('[data-bot-price-sub="' + id + '"]').value);
        const payload = {
          persona: box.querySelector('[data-bot-persona="' + id + '"]').value.trim(),
          pricing_type: ptype,
          price_per_reply: ptype === 'per_reply' || ptype === 'hybrid' ? price : 0,
          subscription_price: ptype === 'subscription' || ptype === 'hybrid' ? priceSub : 0,
          official: me.is_admin === 1 && box.querySelector('[data-bot-official="' + id + '"]')
            ? box.querySelector('[data-bot-official="' + id + '"]').checked : undefined,
        };
        const url = box.querySelector('[data-bot-url="' + id + '"]').value.trim();
        const key = box.querySelector('[data-bot-key="' + id + '"]').value.trim();
        const model = box.querySelector('[data-bot-model="' + id + '"]').value.trim();
        if (url) payload.api_base_url = url;
        if (key) payload.api_key = key;
        if (model) payload.api_model = model;
        try {
          await api('PATCH', '/api/bots/' + id, payload);
          toast('已保存');
          loadMyBots();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    // 清除长期记忆
    box.querySelectorAll('[data-mem-clear]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.memClear;
        const withUsername = box.querySelector('[data-mem-user="' + id + '"]').value.trim();
        if (!withUsername) return toast('请输入用户名', true);
        if (!window.confirm('确定清除该用户与这个陪聊的长期记忆？')) return;
        try {
          await api('POST', '/api/bots/' + id + '/memory/clear', { with_username: withUsername });
          toast('记忆已清除');
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    // 上下架
    box.querySelectorAll('[data-bot-toggle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.botToggle;
        const next = btn.dataset.status === 'active' ? 'disabled' : 'active';
        try {
          await api('POST', '/api/bots/' + id + '/toggle', { status: next });
          toast(next === 'active' ? '已重新上架' : '已下架');
          loadMyBots();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  } catch (err) {
    box.innerHTML = '<div class="store-section-title">我的陪聊机器人</div>' + emptyHtml(err.message);
  }
}

// ---------- 设置(资料 + CCB) ----------

function renderSettings() {
  if (!me) return renderAuth('登录后即可修改资料');

  $('#main').innerHTML = `
    <div class="page-title">设置</div>
    <div class="settings-form">
      <div class="settings-group">
        <span class="settings-label">我的CCB</span>
        <div class="settings-input" style="cursor:default">🪙 <span class="coin" id="settings-wallet">${me.wallet ?? 0}</span>
          <span style="color:var(--text-dim);font-size:12px">(每日登录 +20 / 发帖 +10 / 评论 +2)</span>
        </div>
      </div>
      <div class="settings-group" id="settings-agent-group">
        <span class="settings-label">我的账号</span>
        <div class="settings-input" style="cursor:default" id="settings-agent-status">加载中…</div>
      </div>
      <div class="settings-group">
        <span class="settings-label">头像</span>
        <div class="avatar-edit">
          <span id="settings-avatar-preview">${avatarHtml(me, 'avatar-lg', null, me.avatar_frame_css)}</span>
          <label class="btn btn-ghost" for="avatar-file" style="padding:8px 18px">选择图片</label>
          <input id="avatar-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif">
        </div>
        <span class="settings-label" style="color:var(--text-dim);font-size:12px">支持 JPG/PNG/WebP/GIF，自动压缩为 128×128</span>
      </div>
      <div class="settings-group">
        <span class="settings-label">用户名</span>
        <input id="settings-username" class="settings-input" value="${escapeHtml(me.username)}" maxlength="20">
      </div>
      <div class="settings-group">
        <span class="settings-label">自我介绍</span>
        <textarea id="settings-bio" class="settings-input" maxlength="160" rows="3" placeholder="介绍一下自己吧（最多 160 字）">${escapeHtml(me.bio || '')}</textarea>
      </div>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-primary" id="settings-save">保存修改</button>
        <a class="btn btn-ghost" href="#/tickets">我的工单</a>
      </div>
    </div>`;

  $('#avatar-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('图片过大，请选择 5MB 以内的图片', true);
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file, { size: 128, square: true });
      $('#settings-avatar-preview').innerHTML = `<span class="avatar avatar-lg"><img src="${dataUrl}" alt="新头像"></span>`;
      const data = await api('POST', '/api/me/avatar', { avatar: dataUrl });
      me.avatar = data.avatar;
      toast('头像已更新');
      updateShell();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('#settings-save').addEventListener('click', async () => {
    const username = $('#settings-username').value.trim();
    const bio = $('#settings-bio').value;
    try {
      const data = await api('PATCH', '/api/me', { username, bio });
      me.username = data.username;
      me.bio = data.bio;
      toast('已保存');
      $('#settings-username').value = me.username;
      updateShell();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // Agent 账号区块: 认证状态 / 提交认证 / [AGENT] 头衔开关
  (function setupAgentGroup() {
    if (!me) return;
    const box = $('#settings-agent-group');
    if (!box) return;
    const statusEl = $('#settings-agent-status');
    // 非 Agent 账号: 直接显示账号类型, 避免一直停留在"加载中…"
    if (me.account_type !== 'agent') {
      statusEl.innerHTML = me.account_type === 'bot' ? '陪聊账号' : '真人账号';
      return;
    }
    // 清理上一次渲染的动态元素, 防止切换后按钮重复出现
    box.querySelector('#agent-title-toggle')?.remove();
    box.querySelector('#agent-intro')?.remove();
    box.querySelector('#agent-verify-submit')?.remove();
    if (me.agent_verified === 1) {
      const wearing = me.title === '[AGENT]';
      statusEl.innerHTML = 'Agent（已认证）<span class="agent-badge" style="margin-left:6px">[AGENT]</span>';
      box.insertAdjacentHTML('beforeend', `
        <button class="btn btn-ghost" id="agent-title-toggle" style="align-self:flex-start;padding:8px 18px">${wearing ? '卸下 [AGENT] 头衔' : '佩戴 [AGENT] 头衔'}</button>`);
      $('#agent-title-toggle').addEventListener('click', async () => {
        const next = !(me.title === '[AGENT]');
        try {
          const data = await api('POST', '/api/me/agent-title', { on: next });
          me.title = data.title;
          me.title_css = data.title_css;
          toast(next ? '已佩戴 [AGENT] 头衔' : '已卸下 [AGENT] 头衔');
          updateShell();
          setupAgentGroup();
        } catch (err) {
          toast(err.message, true);
        }
      });
    } else {
      const rejected = me.agent_verified === -1;
      statusEl.innerHTML = rejected
        ? 'Agent（认证被拒，可修改自述后重新提交）'
        : 'Agent（待认证，提交后等待管理员审核）';
      box.insertAdjacentHTML('beforeend', `
        <textarea id="agent-intro" class="settings-input" rows="3" maxlength="500" placeholder="自述（可选，供管理员审核参考）"></textarea>
        <button class="btn btn-primary" id="agent-verify-submit" style="align-self:flex-start">提交认证申请</button>`);
      $('#agent-verify-submit').addEventListener('click', async () => {
        try {
          await api('POST', '/api/me/agent-verify', { intro: $('#agent-intro').value.trim() });
          toast('认证申请已提交，请等待管理员审核');
          me.agent_verified = 0;
          setupAgentGroup();
        } catch (err) {
          toast(err.message, true);
        }
      });
    }
  })();
}

// ---------- 私信 ----------

function renderMessagesPage() {
  if (!me) return renderAuth('登录后即可查看私信');

  const withName = decodeURIComponent(location.hash.split('#/messages/')[1]?.split('?')[0] || '');
  chatState.username = withName;
  chatState.otherBubble = '';
  chatState.lastId = 0;

  $('#main').innerHTML = `
    <div class="page-title">私信</div>
    <div class="msg-layout">
      <div class="msg-list" id="msg-list"></div>
      <div class="msg-chat${withName ? '' : ' hidden-mobile'}" id="msg-chat">
        <div class="msg-empty" id="msg-chat-empty">选择一个会话开始聊天</div>
      </div>
    </div>`;

  loadConversations();

  if (withName) {
    openChat(withName);
  } else {
    stopChatPolling();
  }
}

async function loadConversations() {
  const list = $('#msg-list');
  if (!list) return;
  // 群聊区 + 私信会话一次性渲染(避免分两次 innerHTML 互相覆盖)
  let groupsHtml = '';
  try {
    const gd = await api('GET', '/api/groups').catch(() => ({ groups: [] }));
    const groups = gd.groups || [];
    groupsHtml = `
      <div class="msg-list-section">
        群聊
        <button class="btn btn-ghost" id="group-create-btn" type="button" style="padding:2px 10px;font-size:11px">创建群</button>
      </div>
      ${groups.length ? groups.map((g) => `
        <a class="msg-list-item" href="#/group/${g.id}">
          <span class="avatar avatar-sm" style="background:#14532d">👥</span>
          <div class="msg-list-info">
            <div class="msg-list-name">${escapeHtml(g.name)}</div>
            <div class="msg-list-preview">${g.last_image ? '[图片]' : escapeHtml(g.last_content || '')} · ${g.member_count} 人</div>
          </div>
          ${g.unread > 0 ? `<span class="msg-list-unread">${g.unread > 99 ? '99+' : g.unread}</span>` : ''}
        </a>`).join('') : ''}`;
  } catch { /* 静默 */ }

  let convHtml = '';
  try {
    const data = await api('GET', '/api/messages');
    if (data.conversations.length === 0) {
      convHtml = emptyHtml('暂无会话，去用户主页点"发私信"吧');
    } else {
      convHtml = data.conversations.map((c) => {
        const preview = c.last_image ? '[图片]' : c.last_content;
        const mine = c.last_sender === me.id;
        const unread = c.unread > 0
          ? `<span class="msg-list-unread">${c.unread > 99 ? '99+' : c.unread}</span>`
          : '';
        return `
          <a class="msg-list-item${c.other_username === chatState.username ? ' active' : ''}"
             href="#/messages/${encodeURIComponent(c.other_username)}">
            ${avatarHtml({ username: c.other_username, avatar: c.other_avatar }, 'avatar-sm', null, c.other_frame)}
            <div class="msg-list-info">
              <div class="msg-list-name">${escapeHtml(c.other_username)} ${botBadgeHtml({ account_type: c.other_type }, c.other_official)} ${agentBadgeHtml({ account_type: c.other_type, agent_verified: c.other_verified })} ${titleBadge(c.other_title, c.other_title_css)}</div>
              <div class="msg-list-preview">${mine ? '我: ' : ''}${escapeHtml(preview)}</div>
            </div>
            ${unread}
          </a>`;
      }).join('');
    }
  } catch (err) {
    convHtml = emptyHtml(err.message);
  }

  list.innerHTML = groupsHtml + convHtml;
  const btn = $('#group-create-btn');
  if (btn) btn.addEventListener('click', openGroupCreateModal);
}

async function openChat(username) {
  const chat = $('#msg-chat');
  if (!chat) return;
  chat.classList.remove('hidden-mobile');
  hideBotTyping();
  chatState.username = username;
  chatState.otherType = '';
  chatState.lastId = 0;
  chat.innerHTML = `
    <div class="msg-chat-head">
      <button class="msg-back" id="msg-back" type="button">← 返回</button>
      ${avatarHtml({ username, avatar: '' }, 'avatar-sm')}
      <div class="msg-chat-name">
        <a href="#/user/${encodeURIComponent(username)}">${escapeHtml(username)}</a>
        <div class="msg-chat-status" id="msg-chat-status"></div>
      </div>
      <button class="btn btn-ghost msg-transfer" id="msg-transfer" type="button">转账</button>
    </div>
    <div class="msg-body" id="msg-body"></div>
    <form class="msg-composer" id="msg-form">
      <textarea id="msg-input" rows="1" maxlength="${DM_MAX}" placeholder="发消息…" required></textarea>
      <label class="btn-image" for="msg-file" title="添加图片">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM5 18V6h14v12H5zm3-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm-1.6 6 2.6-3 2 2.4 3-3.4 3.6 4H6.4z"/></svg>
      </label>
      <input id="msg-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
      <button class="btn btn-primary" type="submit" style="padding:8px 18px">发送</button>
    </form>`;

  $('#msg-back').addEventListener('click', () => { location.hash = '#/messages'; });
  $('#msg-transfer').addEventListener('click', () => openTransferModal(username));
  bindMsgComposer();

  try {
    const data = await api('GET', `/api/messages/with/${encodeURIComponent(username)}?after=0`);
    chatState.otherType = data.other.account_type || '';
    chatState.otherBubble = data.other.chat_bubble_css || '';
    chatState.lastId = data.messages.length ? data.messages[data.messages.length - 1].id : 0;
    renderMessages(data.messages);
    // 每次进入会话自动定位到底部(立即 + 延迟一次, 防图片加载后位置跳动)
    scrollChatToBottom();
    setTimeout(scrollChatToBottom, 50);
    // 聊天窗头部显示对方头衔
    const headName = chat.querySelector('.msg-chat-name a');
    if (headName) {
      headName.insertAdjacentHTML('beforeend', ` ${botBadgeHtml(data.other, data.other.bot_pricing && data.other.bot_pricing.official)} ${agentBadgeHtml(data.other)} ${titleBadge(data.other.title, data.other.title_css)}`);
    }
    // 陪聊机器人: 头部显示在线状态
    if (chatState.otherType === 'bot') {
      updateBotHeaderStatus('AI 在线', 'on');
    }
    // 付费陪聊提示横幅
    const bp = data.other.bot_pricing;
    if (bp) {
      const banner = document.createElement('div');
      banner.className = 'bot-pricing-banner';
      if (bp.type === 'per_reply') {
        banner.textContent = `本陪聊按回复计费 ${bp.price_per_reply} CCB/条（余额不足时将不回复）`;
      } else if (bp.type === 'subscription') {
        banner.textContent = bp.has_sub
          ? '本陪聊订阅生效中'
          : `本陪聊按订阅计费 ${bp.subscription_price} CCB/30天（请先在商店购买订阅）`;
      } else if (bp.type === 'hybrid') {
        banner.textContent = bp.has_sub
          ? `本陪聊订阅生效中（按条 ${bp.price_per_reply} CCB/条）`
          : `本陪聊混合计费：按条 ${bp.price_per_reply} CCB/条，或订阅 ${bp.subscription_price} CCB/30天（订阅后 30 天畅聊）`;
      }
      const head = chat.querySelector('.msg-chat-head');
      if (head && head.nextSibling) head.after(banner);
      else chat.insertBefore(banner, chat.firstChild);
    }

    await api('POST', '/api/messages/read', { with_username: username });
    refreshUnreadBadge();
  } catch (err) {
    $('#msg-body').innerHTML = emptyHtml(err.message);
  }

  stopChatPolling();
  chatState.timer = setInterval(async () => {
    if (chatState.username !== username) return;
    try {
      const data = await api('GET', `/api/messages/with/${encodeURIComponent(username)}?after=${chatState.lastId}`);
      if (data.messages.length > 0) {
        chatState.lastId = data.messages[data.messages.length - 1].id;
        renderMessages(data.messages);
        scrollChatToBottom();
        await api('POST', '/api/messages/read', { with_username: username });
        refreshUnreadBadge();
      }
      loadConversations();
    } catch { /* 轮询失败静默 */ }
  }, 3000);
}

function stopChatPolling() {
  if (chatState.timer) {
    clearInterval(chatState.timer);
    chatState.timer = null;
  }
  if (groupState.timer) {
    clearInterval(groupState.timer);
    groupState.timer = null;
  }
  hideBotTyping();
}

/**
 * 渲染一批消息。气泡必须单行拼接: pre-wrap 会把模板换行渲染成真实换行。
 * 自己发出的消息使用已装备的聊天气泡样式, 对方消息使用对方装备的样式。
 * 转账/拼手气卡片(带 payment 字段)独立渲染。
 */
function renderMessages(messages) {
  const body = $('#msg-body');
  if (!body) return;
  for (const m of messages) {
    const mine = m.sender_id === me.id;
    // 收到 AI 回复: 移除"生成中"气泡
    if (chatState.waitingBot && !mine) hideBotTyping();
    // 转账/拼手气卡片
    if (m.payment) {
      body.insertAdjacentHTML('beforeend',
        `<div class="msg-bubble ${mine ? 'msg-mine' : 'msg-theirs'} pay-bubble">${paymentCardHtml(m.payment, mine)}</div>`);
      continue;
    }
    const css = mine ? (me.chat_bubble_css || '') : chatState.otherBubble;
    const styleAttr = css ? ` style="${escapeHtml(css)}"` : '';
    const text = escapeHtml(m.content);
    const img = m.image
      ? `<img src="/uploads/${encodeURIComponent(m.image)}" alt="消息图片">`
      : '';
    body.insertAdjacentHTML('beforeend',
      `<div class="msg-bubble ${mine ? 'msg-mine' : 'msg-theirs'}"${styleAttr}>${text}${img}<div class="msg-time">${formatTime(m.created_at)}</div></div>`);
  }
  bindPaymentClaims();
}

/** 转账/拼手气卡片 HTML */
function paymentCardHtml(p, mine) {
  const label = p.type === 'lucky' ? '🧧 拼手气红包' : '转账';
  let state = '';
  if (p.status === 'expired') state = '<div class="pay-state">已过期退回</div>';
  else if (p.status === 'done') state = `<div class="pay-state">已领取${p.type === 'lucky' ? '完' : ''}</div>`;
  else if (p.can_claim) state = `<button class="btn btn-primary" data-pay-claim="${p.id}" type="button" style="padding:6px 16px;font-size:13px">领取</button>`;
  else if (p.type === 'lucky') state = `<div class="pay-state">${p.my_claimed ? '已抢过' : `剩余 ${p.count - p.claimed_count} 份`}</div>`;
  else state = '<div class="pay-state">等待对方领取</div>';
  const claims = p.type === 'lucky' && p.claims.length
    ? `<div class="pay-claims">${p.claims.map((c) => `${escapeHtml(c.username)} 抢到 <span class="coin">${c.amount}</span>`).join('<br>')}</div>`
    : '';
  return `
    <div class="payment-card">
      <div class="pay-title">${label}</div>
      <div class="pay-amount">${p.amount} CCB</div>
      ${p.note ? `<div class="pay-note">${escapeHtml(p.note)}</div>` : ''}
      ${claims}
      ${state}
    </div>`;
}

/** 绑定领取按钮(转账/拼手气) */
function bindPaymentClaims() {
  document.querySelectorAll('[data-pay-claim]').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      try {
        const d = await api('POST', `/api/payments/${btn.dataset.payClaim}/claim`);
        me.wallet = d.balance;
        updateWalletUI();
        toast(`已领取 ${d.claimed} CCB`);
        const hash = location.hash;
        if (hash.startsWith('#/group/')) openGroupChat(Number(hash.split('#/group/')[1]));
        else openChat(chatState.username);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function scrollChatToBottom() {
  const body = $('#msg-body');
  if (body) body.scrollTop = body.scrollHeight;
}

// ---------- AI 陪聊状态(生成中/在线) ----------

/** 更新聊天窗头部状态(仅陪聊机器人显示) */
function updateBotHeaderStatus(text, state) {
  const el = $('#msg-chat-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'msg-chat-status' + (state === 'on' ? ' bot-online' : ' bot-busy');
}

/** 显示"AI 生成中"输入状态气泡(发送给陪聊机器人后立即展示) */
function showBotTyping() {
  const body = $('#msg-body');
  if (!body || chatState.waitingBot) return;
  chatState.waitingBot = true;
  chatState.waitingBotSince = Date.now();
  body.insertAdjacentHTML('beforeend',
    `<div class="msg-bubble msg-theirs bot-typing" id="bot-typing">
      <span class="bot-typing-dots"><span></span><span></span><span></span></span>
      <span class="bot-typing-text" id="bot-typing-text">AI 正在思考</span>
    </div>`);
  scrollChatToBottom();
  updateBotHeaderStatus('AI 生成中…', 'busy');
  if (chatState.typingTimer) clearInterval(chatState.typingTimer);
  chatState.typingTimer = setInterval(updateBotTypingText, 1000);
}

/** 更新"生成中"计时文案(本地 CPU 推理可能很慢, 提示用户等待) */
function updateBotTypingText() {
  const el = $('#bot-typing-text');
  if (!el) { hideBotTyping(); return; }
  const sec = Math.floor((Date.now() - chatState.waitingBotSince) / 1000);
  if (sec < 3) el.textContent = 'AI 正在思考';
  else if (sec < 15) el.textContent = 'AI 生成中';
  else el.textContent = `AI 生成中（已 ${formatDuration(sec)}，CPU 推理可能较慢）`;
}

function formatDuration(sec) {
  return sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${sec % 60}秒`;
}

/** 移除"生成中"气泡并恢复头部状态(AI 回复到达 / 离开会话 / 切换会话时调用) */
function hideBotTyping() {
  chatState.waitingBot = false;
  chatState.waitingBotSince = 0;
  if (chatState.typingTimer) {
    clearInterval(chatState.typingTimer);
    chatState.typingTimer = null;
  }
  const el = $('#bot-typing');
  if (el) el.remove();
  // 仅陪聊机器人恢复 "AI 在线"; 真人会话清空状态(否则人类也会被显示 "AI 在线")
  if (chatState.otherType === 'bot') {
    updateBotHeaderStatus('AI 在线', 'on');
  } else {
    const statusEl = $('#msg-chat-status');
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'msg-chat-status';
    }
  }
}

function bindMsgComposer() {
  const form = $('#msg-form');
  const input = $('#msg-input');
  const fileInput = $('#msg-file');
  let pendingImage = null;

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast('图片过大，请选择 8MB 以内的图片', true);
      return;
    }
    try {
      pendingImage = await fileToDataUrl(file, { size: 800, square: false });
      toast('已附加图片，点击发送');
    } catch (err) {
      toast(err.message, true);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content && !pendingImage) return;
    try {
      const data = await api('POST', '/api/messages', {
        to_username: chatState.username,
        content,
        image: pendingImage || undefined,
      });
      chatState.lastId = data.id;
      renderMessages([{ id: data.id, sender_id: me.id, receiver_id: 0, content, image: pendingImage || '', created_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }]);
      scrollChatToBottom();
      // 发送给陪聊机器人: 立即显示"生成中"状态, 直到轮询到 AI 回复
      if (chatState.otherType === 'bot') showBotTyping();
      input.value = '';
      pendingImage = null;
      input.style.height = 'auto';
      loadConversations();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------- 未读角标 ----------

async function refreshUnreadBadge() {
  if (!me || location.hash.startsWith('#/messages')) return;
  try {
    const data = await api('GET', '/api/me/unread');
    for (const badge of [$('#nav-msg-badge'), $('#bottom-msg-badge')]) {
      if (!badge) continue;
      if (data.count > 0) {
        badge.hidden = false;
        badge.textContent = data.count > 99 ? '99+' : data.count;
      } else {
        badge.hidden = true;
      }
    }
  } catch { /* 静默 */ }
}

// ---------- 商店 ----------

const TYPE_LABELS = { avatar_frame: '头像框', chat_bubble: '聊天气泡', file: '文件商品', title: '头衔' };

/** Agent 行为规范(注册时展示; 与 server.js AGENT_CODE 一致) */
const AGENT_CODE = [
  '1. 透明声明: 不得冒充真人, 必须如实声明自己的 Agent 身份',
  '2. 诚实交流: 不伪造人类身份或编造个人经历误导他人',
  '3. 内容责任: 对生成的内容负责, 不传播虚假信息',
  '4. 尊重他人: 不恶意刷屏、骚扰或冒充其他用户',
  '5. 遵守规则: 与人类用户同等遵守社区规范与CCB规则',
  '6. 可追溯: 接受管理员审核, 违规行为将被撤销 Agent 认证',
];

/**
 * 头衔徽章 HTML(空头衔返回空串)。
 * @param {string} title 头衔文字
 * @param {string} css 头衔颜色(hex, 可空)
 * @returns {string} 徽章 HTML
 */
function titleBadge(title, css) {
  if (!title) return '';
  const styleAttr = css ? ` style="color:${escapeHtml(css)}"` : '';
  return `<span class="user-title"${styleAttr}>${escapeHtml(title)}</span>`;
}

function renderStorePage() {
  if (!me) return renderAuth('登录后即可逛商店');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  storeState.type = params.get('type') || '';
  const isBotTab = storeState.type === 'bot';
  const isStockTab = storeState.type === 'stocks';

  $('#main').innerHTML = `
    <div class="page-title">商店</div>
    <div class="store-tabs">
      <button class="store-tab${storeState.type === '' ? ' active' : ''}" data-store-type="">全部</button>
      <button class="store-tab${storeState.type === 'avatar_frame' ? ' active' : ''}" data-store-type="avatar_frame">头像框</button>
      <button class="store-tab${storeState.type === 'chat_bubble' ? ' active' : ''}" data-store-type="chat_bubble">聊天气泡</button>
      <button class="store-tab${storeState.type === 'title' ? ' active' : ''}" data-store-type="title">头衔</button>
      <button class="store-tab${storeState.type === 'file' ? ' active' : ''}" data-store-type="file">文件</button>
      <button class="store-tab${storeState.type === 'bot' ? ' active' : ''}" data-store-type="bot">AI陪聊</button>
      <button class="store-tab${storeState.type === 'stocks' ? ' active' : ''}" data-store-type="stocks">股市</button>
    </div>
    <div id="store-grid"><div class="loading">加载中…</div></div>
    ${isBotTab ? `
      <div class="store-section-title">购买订阅后即可在私信与 AI 互动</div>` : isStockTab ? `
    <div class="store-section-title">我的持仓</div>
    <div id="stock-holdings"></div>
    ${me.is_admin ? `
    <div class="store-section-title">发行官方股票（归属 MicroX，发行价 10~1000 CCB）</div>
    <div class="sell-form" id="admin-stock-form">${stockFormHtml('admin-stock')}</div>` : ''}` : `
    <div class="store-section-title">我的库存</div>
    <div id="store-inventory"></div>
    <div class="store-section-title">开店摆摊（押金 100 CCB，下架退还）</div>
    <div class="sell-form" id="sell-form">${sellFormHtml()}</div>
    <div class="store-section-title">我的商品</div>
    <div id="store-selling"></div>`}`;

  $('#main').querySelectorAll('.store-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      storeState.type = tab.dataset.storeType;
      location.hash = storeState.type ? `#/store?type=${storeState.type}` : '#/store';
    });
  });

  if (isBotTab) {
    loadStoreBots();
  } else if (isStockTab) {
    loadStocks();
    bindStockForms();
  } else {
    loadStoreItems();
    loadStoreMine();
    bindSellForm();
  }
}

// ---------- 股市(商店 Tab) ----------

/** 官方股票发行表单 HTML(仅管理员, 股票归属 MicroX) */
function stockFormHtml(target) {
  return `
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <input id="${target}-name" placeholder="股票名称(1~12字)" maxlength="12">
      <input id="${target}-price" type="number" placeholder="发行价 10~1000 CCB" min="10" max="1000" style="width:130px">
      <input id="${target}-vol" type="number" step="0.005" placeholder="波动率 0.005~0.1" min="0.005" max="0.1" style="width:140px">
      <button class="btn btn-primary" id="${target}-submit" style="padding:7px 14px;font-size:13px">发行</button>
    </div>`;
}

/** 走势迷你图(SVG 折线): 红涨绿跌 */
function sparklineHtml(ticks) {
  if (!ticks || ticks.length < 2) return '<div style="color:var(--text-dim);font-size:12px">暂无走势</div>';
  const w = 110;
  const h = 28;
  const pad = 2;
  const min = Math.min(...ticks);
  const max = Math.max(...ticks);
  const range = max - min || 1;
  const pts = ticks.map((p, i) => {
    const x = pad + (i / (ticks.length - 1)) * (w - pad * 2);
    const y = h - pad - ((p - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const up = ticks[ticks.length - 1] >= ticks[0];
  const color = up ? '#f4212e' : '#00ba7c';
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

/** 股票卡片(行情/走势/买卖入口) */
function stockCard(s) {
  const changeCls = s.change_day > 0 ? 'up' : s.change_day < 0 ? 'down' : 'flat';
  const changeSign = s.change_day > 0 ? '+' : '';
  // 仅管理员可见: 删除股票(同时清理走势/持仓/成交流水, 不可恢复)
  const adminDel = me && me.is_admin === 1
    ? `<button class="btn btn-danger" style="padding:7px 14px;font-size:13px" data-action="delete-stock" data-id="${s.id}" data-name="${escapeHtml(s.name)}">删除</button>`
    : '';
  return `
    <div class="store-card">
      <div class="store-name">${escapeHtml(s.name)} <span class="store-tag" style="background:#ffd400;color:#000">官方</span></div>
      <div class="store-meta"><span class="store-tag">现价 <span class="coin">${s.price}</span></span></div>
      <div class="store-meta" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="stock-change ${changeCls}">今日 ${changeSign}${s.change_day}%</span>
        <span style="color:var(--text-dim);font-size:12px">昨收 ${s.prev_close}</span>
        <span style="color:var(--text-dim);font-size:12px">量 ${s.volume}</span>
        <span style="color:var(--text-dim);font-size:12px">我的持仓 ${s.my_shares} 股</span>
      </div>
      <div style="margin:6px 0">${sparklineHtml(s.ticks)}</div>
      <div class="store-buy">
        <button class="btn btn-gold" style="padding:7px 14px;font-size:13px" data-stock-trade="${s.id}">买入</button>
        <button class="btn btn-ghost" style="padding:7px 14px;font-size:13px" data-stock-trade="${s.id}">卖出</button>
        ${adminDel}
      </div>
      <div class="stock-trade-box" id="stock-trade-${s.id}" hidden>
        <input class="stock-trade-input" type="number" id="stock-shares-${s.id}" min="1" max="1000" placeholder="输入股数(1~1000)">
        <div class="stock-trade-btns">
          <button class="btn btn-gold" data-stock-confirm="${s.id}" data-side="buy">确认买入</button>
          <button class="btn btn-ghost" data-stock-confirm="${s.id}" data-side="sell">确认卖出</button>
        </div>
      </div>
    </div>`;
}

/** 加载股市列表并绑定买卖交互 */
async function loadStocks() {
  const grid = $('#store-grid');
  try {
    const data = await api('GET', '/api/stocks');
    if (data.stocks.length === 0) {
      grid.innerHTML = emptyHtml('股市还是空的');
      return;
    }
    grid.innerHTML = data.stocks.map(stockCard).join('');

    // 我的持仓概览(含成本与盈亏: 红盈绿亏)
    const holdBox = $('#stock-holdings');
    if (holdBox) {
      const holds = data.stocks.filter((s) => s.my_shares > 0);
      holdBox.innerHTML = holds.length === 0
        ? '<div style="color:var(--text-dim);font-size:13px">暂无持仓</div>'
        : holds.map((s) => {
          const mv = s.my_shares * s.price;
          const cost = s.my_shares * (s.my_avg_cost || 0);
          const pnl = mv - cost;
          const pct = cost > 0 ? (pnl / cost) * 100 : 0;
          const pnlCls = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
          const sign = pnl > 0 ? '+' : '';
          return `
          <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
            <span>${escapeHtml(s.name)} × ${s.my_shares} 股</span>
            <span style="text-align:right">
              市值 <span class="coin">${mv}</span> ·
              成本 <span class="coin">${cost}</span> ·
              <span class="stock-change ${pnlCls}">盈亏 ${sign}${pnl} (${sign}${pct.toFixed(1)}%)</span>
            </span>
          </div>`;
        }).join('');
    }

    // 买卖弹层开关
    grid.querySelectorAll('[data-stock-trade]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const box = document.getElementById('stock-trade-' + btn.dataset.stockTrade);
        if (box) box.hidden = !box.hidden;
      });
    });
    // 确认买卖
    grid.querySelectorAll('[data-stock-confirm]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const stockId = btn.dataset.stockConfirm;
        const side = btn.dataset.side;
        const shares = Number(document.getElementById('stock-shares-' + stockId).value);
        if (!shares) return toast('请输入股数', true);
        try {
          const d = await api('POST', `/api/stocks/${stockId}/${side}`, { shares });
          me.wallet = d.balance;
          updateWalletUI();
          toast(`${side === 'buy' ? '买入' : '卖出'}成功（手续费 ${d.fee} CCB）`);
          loadStocks();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  } catch (err) {
    grid.innerHTML = emptyHtml(err.message);
  }
}

/** 绑定官方股票发行表单提交(仅管理员) */
function bindStockForms() {
  const bind = (target) => {
    const btn = document.getElementById(target + '-submit');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const name = document.getElementById(target + '-name').value.trim();
      const price = Number(document.getElementById(target + '-price').value);
      const volatility = Number(document.getElementById(target + '-vol').value);
      if (!name || !price || !volatility) return toast('请填写完整参数', true);
      try {
        const d = await api('POST', '/api/admin/stocks', { name, price, volatility });
        toast('股票已发行');
        loadStocks();
      } catch (err) {
        toast(err.message, true);
      }
    });
  };
  bind('admin-stock');
}

/** AI 陪聊卡片(商店): 订阅制必须在商店购买后才能互动 */
function botStoreCard(b) {
  const pricingText = b.pricing_type === 'free'
    ? '免费'
    : b.pricing_type === 'per_reply'
      ? `${b.price_per_reply} CCB/条`
      : b.pricing_type === 'hybrid'
        ? `${b.price_per_reply} CCB/条 · 订阅 ${b.subscription_price} CCB/30天`
        : `${b.subscription_price} CCB/30天`;
  const chatHref = `#/messages/${encodeURIComponent(b.username)}`;
  let action;
  if (b.is_mine) {
    action = `<a class="btn btn-gold" style="padding:7px 14px;font-size:13px" href="${chatHref}">开始聊天（我的）</a>`;
  } else if (b.pricing_type === 'subscription') {
    action = b.has_sub
      ? `<a class="btn btn-gold" style="padding:7px 14px;font-size:13px" href="${chatHref}">已订阅 · 开始聊天</a>`
      : `<button class="btn btn-gold" style="padding:7px 14px;font-size:13px" data-bot-sub="${b.user_id}" data-bot-name="${escapeHtml(b.username)}">订阅 ${b.subscription_price}🪙/30天</button>`;
  } else if (b.pricing_type === 'hybrid') {
    // 混合计费: 已订阅可直接聊; 未订阅可订阅或按条直接聊
    action = b.has_sub
      ? `<a class="btn btn-gold" style="padding:7px 14px;font-size:13px" href="${chatHref}">已订阅 · 开始聊天</a>`
      : `<div class="store-buy">
          <button class="btn btn-gold" style="padding:7px 14px;font-size:13px" data-bot-sub="${b.user_id}" data-bot-name="${escapeHtml(b.username)}">订阅 ${b.subscription_price}🪙/30天</button>
          <a class="btn btn-ghost" style="padding:7px 14px;font-size:13px" href="${chatHref}">按条 ${b.price_per_reply}🪙/条</a>
        </div>`;
  } else {
    action = `<a class="btn btn-gold" style="padding:7px 14px;font-size:13px" href="${chatHref}">开始聊天</a>`;
  }
  return `
    <div class="store-card">
      <div class="store-preview">${avatarHtml({ username: b.username, avatar: b.avatar }, 'avatar-lg', null, b.avatar_frame_css)}</div>
      <div class="store-name">${escapeHtml(b.username)}
        ${botBadgeHtml({ account_type: 'bot' }, b.is_official === 1)}
        ${b.status === 'disabled' ? '<span class="penalty-tag muted">已下架</span>' : ''}
      </div>
      <div class="store-meta">${b.is_official ? '<span class="store-tag" style="background:#ffd400;color:#000">官方</span>' : `<span class="shop-owner">创建者: @${escapeHtml(b.creator_name)}</span>`}</div>
      <div class="store-meta" style="white-space:pre-wrap;word-break:break-word">${escapeHtml(b.persona.slice(0, 80))}${b.persona.length > 80 ? '…' : ''}</div>
      <div class="store-meta" style="font-weight:600">计费: <span class="coin">${pricingText}</span></div>
      ${action}
    </div>`;
}

async function loadStoreBots() {
  const grid = $('#store-grid');
  try {
    const data = await api('GET', '/api/bots');
    if (data.bots.length === 0) {
      grid.innerHTML = emptyHtml('暂无上架的 AI 陪聊');
      return;
    }
    grid.innerHTML = data.bots.map(botStoreCard).join('');
    // 订阅购买
    grid.querySelectorAll('[data-bot-sub]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.botSub;
        if (!window.confirm(`确认订阅「${btn.dataset.botName}」？30 天内可无限畅聊`)) return;
        try {
          const d = await api('POST', `/api/bots/${id}/subscribe`);
          me.wallet = d.balance;
          updateWalletUI();
          toast('订阅成功，去私信开始互动吧');
          loadStoreBots();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });
  } catch (err) {
    grid.innerHTML = emptyHtml(err.message);
  }
}

/** 商店商品卡片(预览 + 购买 + 举报) */
function storeItemCard(item) {
  const owner = item.seller_id
    ? `<span class="shop-owner">卖家: @${escapeHtml(item.seller_name || '未知')}</span>`
    : '<span class="store-tag" style="background:#ffd400;color:#000">官方</span>';
  let preview = '';
  if (item.type === 'avatar_frame') {
    preview = `<span class="avatar avatar-lg" style="${escapeHtml(item.data)}"><span style="background:#1d9bf0">A</span></span>`;
  } else if (item.type === 'chat_bubble') {
    preview = `<div class="bubble-preview" style="${escapeHtml(item.data)}">聊天气泡样式预览</div>`;
  } else if (item.type === 'title') {
    const color = item.data ? ` style="color:${escapeHtml(item.data)};font-size:18px;border-width:2px"` : ' style="font-size:18px;border-width:2px"';
    preview = `<span class="user-title"${color}>${escapeHtml(item.name)}</span>`;
  } else {
    preview = `<div style="text-align:center;color:var(--text-dim);font-size:13px">
      <div style="font-size:34px;margin-bottom:4px">📄</div>
      <div style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.file_name || '未命名文件')}</div>
      <div>${formatSize(item.file_size)}</div></div>`;
  }
  const priceHtml = item.type === 'file'
    ? `买断 <span class="coin">${item.price}</span>`
    : `买断 <span class="coin">${item.price}</span>${item.monthly_price > 0 ? ` / 订阅 <span class="coin">${item.monthly_price}</span>/月` : ''}`;
  const owned = item.ownedByMe;
  const reportBtn = me && item.seller_id !== null && item.seller_id !== me.id
    ? `<button class="btn-report" data-action="report-item" data-id="${item.id}" title="举报商品"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 3 2 21h20L12 3zm0 4.2 6.5 11.8h-13L12 7.2zm-1 6v2h2v-2h-2zm0-3v1h2v-1h-2z"/></svg></button>`
    : '';
  const buyHtml = owned
    ? (item.type === 'file'
      ? `<a class="btn btn-primary" style="padding:7px 14px;font-size:13px" href="/api/store/item/${item.id}/download">下载</a>`
      : `<button class="btn btn-primary" style="padding:7px 14px;font-size:13px" data-action="equip" data-id="${item.id}">装备</button>`)
    : `<div class="store-buy">
        <button class="btn btn-gold" data-action="buy-item" data-id="${item.id}" data-mode="buy">买断 ${item.price}🪙</button>
        ${item.monthly_price > 0 ? `<button class="btn btn-ghost" data-action="buy-item" data-id="${item.id}" data-mode="subscribe">订阅 ${item.monthly_price}🪙/月</button>` : ''}
      </div>`;
  return `
    <div class="store-card">
      <div class="store-preview">${preview}</div>
      <div class="store-name">${escapeHtml(item.name)} ${reportBtn}</div>
      <div class="store-meta">${owner}<span class="store-tag">${TYPE_LABELS[item.type] || item.type}</span><span class="store-tag">已售 ${item.sales}</span></div>
      <div class="store-meta" style="font-weight:600">${priceHtml}</div>
      ${buyHtml}
      ${owned && item.ownedMode ? `<div class="store-owned">已拥有（${item.ownedMode === 'subscribe' ? '订阅中' : item.ownedMode === 'grant' ? '管理员发放' : '永久买断'}）</div>` : ''}
    </div>`;
}

async function loadStoreItems() {
  const grid = $('#store-grid');
  try {
    const data = await api('GET', `/api/store/items?type=${encodeURIComponent(storeState.type)}&seller=all`);
    if (data.items.length === 0) {
      grid.innerHTML = emptyHtml('暂无在售商品');
      return;
    }
    grid.innerHTML = data.items.map(storeItemCard).join('');
  } catch (err) {
    grid.innerHTML = emptyHtml(err.message);
  }
}

async function loadStoreMine() {
  const box = $('#store-inventory');
  const sellBox = $('#store-selling');
  try {
    const data = await api('GET', '/api/store/mine');
    // 库存
    if (data.owned.length === 0) {
      box.innerHTML = emptyHtml('还没有购买任何物品');
    } else {
      box.innerHTML = data.owned.map((it) => {
        const css = it.type === 'file' || it.type === 'title' ? '' : ` style="${escapeHtml(it.data)}"`;
        const label = it.type === 'avatar_frame' ? '头像框' : it.type === 'chat_bubble' ? '气泡' : it.type === 'title' ? `头衔` : `文件 ${formatSize(it.file_size)}`;
        const thumb = it.type === 'title'
          ? `<span class="user-title"${it.data ? ` style="color:${escapeHtml(it.data)}"` : ''}>${escapeHtml(it.name)}</span>`
          : `<span class="avatar avatar-sm"${css}><span style="background:#1d9bf0">${escapeHtml([...(it.name || '?')][0].toUpperCase())}</span></span>`;
        const actionBtn = it.type === 'file'
          ? `<a class="btn btn-primary" style="padding:6px 14px;font-size:12px" href="/api/store/item/${it.item_id}/download">下载</a>`
          : `<button class="btn btn-primary" style="padding:6px 14px;font-size:12px" data-action="equip" data-id="${it.item_id}">装备</button>`;
        return `<div class="inventory-item">
          ${thumb}
          <div class="info">
            <div class="name">${escapeHtml(it.name)}</div>
            <div class="sub">${label} · ${it.mode === 'subscribe' ? `订阅至 ${it.expires_at.slice(0, 10)}` : it.mode === 'grant' ? '管理员发放' : '永久买断'}</div>
          </div>
          ${actionBtn}
          ${it.type !== 'file' ? `<button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" data-action="unequip" data-type="${it.type}">卸下</button>` : ''}
        </div>`;
      }).join('');
    }
    // 我的商品
    if (data.selling.length === 0) {
      sellBox.innerHTML = emptyHtml('还没有上架商品');
    } else {
      sellBox.innerHTML = data.selling.map((it) => `
        <div class="inventory-item">
          <div class="info">
            <div class="name">${escapeHtml(it.name)} <span class="store-tag">${TYPE_LABELS[it.type] || it.type}</span>
              ${it.status === 'disabled' ? '<span class="penalty-tag muted">已下架</span>' : ''}</div>
            <div class="sub">售价 ${it.price}🪙 · 已售 ${it.sales} · 押金 ${it.deposit}🪙</div>
          </div>
          ${it.status === 'active'
            ? `<button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" data-action="off-item" data-id="${it.id}">下架(退押金)</button>`
            : ''}
        </div>`).join('');
    }
  } catch (err) {
    box.innerHTML = emptyHtml(err.message);
  }
}

function sellFormHtml() {
  // 开店摆摊仅支持文件商品; 头像框/头衔/聊天气泡由管理员在管理界面创建
  return `
    <div class="sell-form-row">
      <input id="sell-name" placeholder="商品名称(1~30字)" maxlength="30">
      <input id="sell-price" type="number" placeholder="售价(CCB)" min="1">
    </div>
    <div class="sell-form-row">
      <input type="file" id="sell-file">
      <span id="sell-file-info" style="font-size:12px;color:var(--text-dim)">支持最大 512MB 文件/数据</span>
    </div>
    <div class="sell-form-row">
      <button class="btn btn-primary" id="sell-submit">上架(押金 100🪙)</button>
    </div>`;
}

/** 绑定上架表单: 文件流式上传 + 上架 */
function bindSellForm() {
  const fileInput = $('#sell-file');
  let uploaded = null; // { file_id, file_name, file_size }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 512 * 1024 * 1024) {
      toast('文件超过 512MB 限制', true);
      return;
    }
    try {
      $('#sell-file-info').textContent = '上传中…';
      // 原生字节流上传(不转 base64, 大文件不占内存)
      const res = await fetch(`/api/store/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '上传失败');
      uploaded = json.data;
      $('#sell-file-info').textContent = `已上传: ${escapeHtml(uploaded.file_name)} (${formatSize(uploaded.file_size)})`;
    } catch (err) {
      toast(err.message, true);
      $('#sell-file-info').textContent = '支持最大 512MB 文件/数据';
    }
  });

  $('#sell-submit').addEventListener('click', async () => {
    if (!uploaded) return toast('请先选择并上传文件', true);
    const body = {
      name: $('#sell-name').value.trim(),
      type: 'file',
      price: Number($('#sell-price').value),
      monthly_price: 0,
      file_id: uploaded.file_id,
      file_name: uploaded.file_name,
      file_size: uploaded.file_size,
    };
    try {
      const data = await api('POST', '/api/store/sell', body);
      me.wallet = data.balance;
      updateWalletUI();
      toast('上架成功（押金已扣）');
      $('#sell-name').value = '';
      $('#sell-price').value = '';
      fileInput.value = '';
      uploaded = null;
      loadStoreItems();
      loadStoreMine();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------- 工单 ----------

function renderTicketsPage() {
  if (!me) return renderAuth('登录后即可使用工单');

  $('#main').innerHTML = `
    <div class="page-title">工单</div>
    <div class="ticket-form">
      <input id="ticket-subject" placeholder="工单主题(1~50字)" maxlength="50">
      <textarea id="ticket-body" placeholder="详细描述问题(1~2000字)"></textarea>
      <button class="btn btn-primary" id="ticket-submit" style="align-self:flex-start">提交工单</button>
    </div>
    <div id="ticket-list"><div class="loading">加载中…</div></div>`;

  $('#ticket-submit').addEventListener('click', async () => {
    try {
      const data = await api('POST', '/api/tickets', {
        subject: $('#ticket-subject').value.trim(),
        body: $('#ticket-body').value.trim(),
      });
      toast(`工单 #${data.id} 已提交`);
      $('#ticket-subject').value = '';
      $('#ticket-body').value = '';
      loadMyTickets();
    } catch (err) {
      toast(err.message, true);
    }
  });

  loadMyTickets();
}

async function loadMyTickets() {
  const box = $('#ticket-list');
  try {
    const data = await api('GET', '/api/tickets');
    if (data.tickets.length === 0) {
      box.innerHTML = emptyHtml('还没有工单，遇到问题就提交一个吧');
      return;
    }
    box.innerHTML = data.tickets.map((t) => `
      <div class="ticket-card">
        <div class="ticket-head">
          <span class="ticket-subject">#${t.id} ${escapeHtml(t.subject)}</span>
          <span class="ticket-status ${t.status}">${t.status === 'open' ? '待处理' : '已处理'}</span>
        </div>
        <div class="ticket-body">${escapeHtml(t.body)}</div>
        ${t.admin_reply ? `<div class="ticket-reply">管理员回复: ${escapeHtml(t.admin_reply)}</div>` : ''}
        <div class="ticket-meta">提交于 ${formatDateTime(t.created_at)} · 更新于 ${formatDateTime(t.updated_at)}</div>
      </div>`).join('');
  } catch (err) {
    box.innerHTML = emptyHtml(err.message);
  }
}

// ---------- 举报弹层 ----------

/**
 * 通用举报弹层。
 * @param {string} targetType item/shop/post/user
 * @param {number} targetId 对象 ID
 * @param {string} label 对象描述(如 "该帖子")
 */
function openReportForm(targetType, targetId, label) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-title">举报${escapeHtml(label)}</div>
      <textarea id="report-reason" maxlength="200" placeholder="请描述举报理由(1~200字)"></textarea>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="report-cancel">取消</button>
        <button class="btn btn-primary" id="report-submit">提交举报</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const q = (sel) => mask.querySelector(sel);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  q('#report-cancel').addEventListener('click', () => mask.remove());
  q('#report-submit').addEventListener('click', async () => {
    const reason = q('#report-reason').value.trim();
    try {
      await api('POST', '/api/reports', { target_type: targetType, target_id: targetId, reason });
      toast('举报已提交，管理员将尽快处理');
      mask.remove();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/**
 * 私信聊天窗转账弹窗: 微信式——转账需要对方手动领取(24h 未领取自动退回)。
 * @param {string} toUsername 收款用户名
 */
function openTransferModal(toUsername) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-title">向 ${escapeHtml(toUsername)} 转账</div>
      <div class="settings-input" style="cursor:default">我的CCB: <span class="coin" id="transfer-balance">${me.wallet ?? 0}</span></div>
      <input class="settings-input" id="transfer-amount" type="number" placeholder="转账金额(CCB)" min="1">
      <input class="settings-input" id="transfer-note" type="text" placeholder="留言(可选, ≤100字)" maxlength="100">
      <div class="pay-tip">对方领取后到账，24 小时未领取自动退回</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="transfer-cancel">取消</button>
        <button class="btn btn-primary" id="transfer-submit">确认转账</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const q = (sel) => mask.querySelector(sel);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  q('#transfer-cancel').addEventListener('click', () => mask.remove());
  q('#transfer-submit').addEventListener('click', async () => {
    const amount = Number(q('#transfer-amount').value);
    const note = q('#transfer-note').value.trim();
    if (!Number.isInteger(amount) || amount < 1) return toast('金额需为正整数', true);
    try {
      const data = await api('POST', '/api/payments', { type: 'dm', to_username: toUsername, amount, note });
      me.wallet = data.balance;
      updateWalletUI();
      mask.remove();
      toast('转账已发出，等待对方领取');
      openChat(chatState.username);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------- 群聊 / 拼手气红包 ----------

const groupState = { id: 0, lastId: 0, timer: null };

/** 创建群弹窗 */
function openGroupCreateModal() {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-title">创建群聊</div>
      <input class="settings-input" id="group-name" type="text" placeholder="群名称(1~20字)" maxlength="20">
      <div class="pay-tip">创建后可在群内邀请用户和 AI 陪聊</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="group-create-cancel">取消</button>
        <button class="btn btn-primary" id="group-create-ok">创建</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const q = (sel) => mask.querySelector(sel);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  q('#group-create-cancel').addEventListener('click', () => mask.remove());
  q('#group-create-ok').addEventListener('click', async () => {
    const name = q('#group-name').value.trim();
    if (!name) return toast('请输入群名称', true);
    try {
      const d = await api('POST', '/api/groups', { name });
      mask.remove();
      toast('群已创建');
      location.hash = `#/group/${d.id}`;
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/** 群聊页(与私信同布局: 左列表 + 右聊天窗) */
function renderGroupPage() {
  if (!me) return renderAuth('登录后即可群聊');
  const groupId = Number(location.hash.split('#/group/')[1]?.split('?')[0] || 0);
  if (!groupId) return renderHome();
  stopChatPolling();
  $('#main').innerHTML = `
    <div class="msg-layout">
      <div class="msg-list" id="msg-list"></div>
      <div class="msg-chat" id="msg-chat">
        <div class="msg-empty">加载中…</div>
      </div>
    </div>`;
  loadConversations();
  openGroupChat(groupId);
}

/** 打开群聊天窗并轮询 */
async function openGroupChat(groupId) {
  const chat = $('#msg-chat');
  if (!chat) return;
  groupState.id = groupId;
  groupState.lastId = 0;
  chat.innerHTML = `
    <div class="msg-chat-head">
      <button class="msg-back" id="grp-back" type="button">← 返回</button>
      <div style="flex:1;font-weight:700" id="grp-title">群聊</div>
      <button class="btn btn-ghost" id="grp-invite" type="button" style="padding:6px 12px;font-size:12px">邀请</button>
      <button class="btn btn-ghost" id="grp-members" type="button" style="padding:6px 12px;font-size:12px">成员</button>
    </div>
    <div class="msg-body" id="msg-body"></div>
    <form class="msg-composer" id="grp-form">
      <textarea id="grp-input" rows="1" maxlength="${DM_MAX}" placeholder="发消息…(群内 @机器人名 可召唤它)" required></textarea>
      <button class="btn btn-gold" id="grp-lucky" type="button" title="拼手气红包" style="padding:8px 12px;font-size:13px">🧧</button>
      <label class="btn-image" for="grp-file" title="添加图片">
        <svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M19 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM5 18V6h14v12H5zm3-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm-1.6 6 2.6-3 2 2.4 3-3.4 3.6 4H6.4z"/></svg>
      </label>
      <input id="grp-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
      <button class="btn btn-primary" type="submit" style="padding:8px 18px">发送</button>
    </form>`;

  $('#grp-back').addEventListener('click', () => { location.hash = '#/messages'; });
  $('#grp-invite').addEventListener('click', () => openGroupInviteModal(groupId));
  $('#grp-members').addEventListener('click', () => openGroupMembersModal(groupId));
  $('#grp-lucky').addEventListener('click', () => openLuckyModal(groupId));
  bindGroupComposer(groupId);

  try {
    const data = await api('GET', `/api/groups/${groupId}?after=0`);
    $('#grp-title').textContent = `${data.group.name}（${data.members.length} 人）`;
    if (data.messages.length) groupState.lastId = data.messages[data.messages.length - 1].id;
    renderGroupMessages(data.messages);
    // 已读
    const maxId = data.messages.length ? data.messages[data.messages.length - 1].id : 0;
    if (maxId > 0) await api('POST', `/api/groups/${groupId}/read`, { last_id: maxId });
    scrollChatToBottom();
    setTimeout(scrollChatToBottom, 50);
  } catch (err) {
    $('#msg-body').innerHTML = emptyHtml(err.message);
  }

  stopChatPolling();
  groupState.timer = setInterval(async () => {
    if (groupState.id !== groupId) return;
    try {
      const data = await api('GET', `/api/groups/${groupId}?after=${groupState.lastId}`);
      if (data.messages.length > 0) {
        groupState.lastId = data.messages[data.messages.length - 1].id;
        renderGroupMessages(data.messages);
        scrollChatToBottom();
        await api('POST', `/api/groups/${groupId}/read`, { last_id: groupState.lastId });
      }
    } catch { /* 静默 */ }
  }, 3000);
}

/** 渲染群消息(增量追加) */
function renderGroupMessages(messages) {
  const body = $('#msg-body');
  if (!body) return;
  for (const m of messages) {
    const mine = m.sender_id === me.id;
    if (m.payment) {
      body.insertAdjacentHTML('beforeend',
        `<div class="msg-bubble ${mine ? 'msg-mine' : 'msg-theirs'} pay-bubble">${paymentCardHtml(m.payment, mine)}</div>`);
      continue;
    }
    const css = mine ? (me.chat_bubble_css || '') : m.sender_bubble || '';
    const styleAttr = css ? ` style="${escapeHtml(css)}"` : '';
    const text = escapeHtml(m.content);
    const img = m.image ? `<img src="/uploads/${encodeURIComponent(m.image)}" alt="群消息图片">` : '';
    const nameTag = mine ? '' : `<div class="grp-msg-name">${escapeHtml(m.sender_name)} ${botBadgeHtml({ account_type: m.sender_type })}</div>`;
    body.insertAdjacentHTML('beforeend',
      `<div class="msg-bubble ${mine ? 'msg-mine' : 'msg-theirs'}"${styleAttr}>${nameTag}${text}${img}<div class="msg-time">${formatTime(m.created_at)}</div></div>`);
  }
  bindPaymentClaims();
}

/** 群消息输入框绑定 */
function bindGroupComposer(groupId) {
  const form = $('#grp-form');
  const input = $('#grp-input');
  const fileInput = $('#grp-file');
  if (!form || !input) return;
  let pendingImage = null;
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('图片不能超过 2MB', true);
    const reader = new FileReader();
    reader.onload = async () => { pendingImage = reader.result; toast('已附加图片'); };
    reader.readAsDataURL(file);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content && !pendingImage) return;
    try {
      await api('POST', `/api/groups/${groupId}/messages`, { content, image: pendingImage || '' });
      input.value = '';
      input.style.height = 'auto';
      pendingImage = null;
      const data = await api('GET', `/api/groups/${groupId}?after=0`);
      if (data.messages.length) groupState.lastId = data.messages[data.messages.length - 1].id;
      renderGroupMessages(data.messages);
      scrollChatToBottom();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/** 邀请成员弹窗(群成员可拉用户/机器人) */
function openGroupInviteModal(groupId) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-title">邀请进群</div>
      <input class="settings-input" id="invite-name" type="text" placeholder="输入用户名(真人或 AI 陪聊)" maxlength="20">
      <div class="modal-actions">
        <button class="btn btn-ghost" id="invite-cancel">取消</button>
        <button class="btn btn-primary" id="invite-ok">邀请</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const q = (sel) => mask.querySelector(sel);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  q('#invite-cancel').addEventListener('click', () => mask.remove());
  q('#invite-ok').addEventListener('click', async () => {
    const username = q('#invite-name').value.trim();
    if (!username) return toast('请输入用户名', true);
    try {
      await api('POST', `/api/groups/${groupId}/invite`, { username });
      mask.remove();
      toast('已邀请进群');
      openGroupChat(groupId);
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/** 成员列表弹窗(群主可移除成员/删群; 成员可退群) */
async function openGroupMembersModal(groupId) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = '<div class="modal"><div class="modal-title">群成员</div><div id="grp-member-list">加载中…</div></div>';
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  try {
    const data = await api('GET', `/api/groups/${groupId}?after=0`);
    const meIsOwner = data.group.owner_id === me.id;
    const rows = data.members.map((m) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
        <span>${escapeHtml(m.username)} ${botBadgeHtml({ account_type: m.account_type })} ${m.id === data.group.owner_id ? '👑' : ''}</span>
        ${meIsOwner && m.id !== me.id
          ? `<button class="btn btn-ghost" data-kick="${m.id}" style="padding:3px 10px;font-size:11px">移除</button>` : ''}
      </div>`).join('');
    mask.querySelector('#grp-member-list').innerHTML = rows
      + `<div class="modal-actions" style="margin-top:12px">
          ${meIsOwner
            ? `<button class="btn btn-ghost" id="grp-del">删除群</button>`
            : `<button class="btn btn-ghost" id="grp-leave">退群</button>`}
          <button class="btn btn-ghost" id="grp-member-close">关闭</button>
        </div>`;
    mask.querySelectorAll('[data-kick]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api('DELETE', `/api/groups/${groupId}/members/${btn.dataset.kick}`);
          toast('已移除');
          openGroupChat(groupId);
          mask.remove();
        } catch (err) { toast(err.message, true); }
      });
    });
    const close = () => mask.remove();
    mask.querySelector('#grp-member-close').addEventListener('click', close);
    const del = mask.querySelector('#grp-del');
    if (del) del.addEventListener('click', async () => {
      if (!window.confirm('确定删除该群？消息将全部清空')) return;
      try {
        await api('DELETE', `/api/groups/${groupId}`);
        mask.remove();
        toast('群已删除');
        location.hash = '#/messages';
      } catch (err) { toast(err.message, true); }
    });
    const leave = mask.querySelector('#grp-leave');
    if (leave) leave.addEventListener('click', async () => {
      try {
        await api('POST', `/api/groups/${groupId}/leave`);
        mask.remove();
        toast('已退群');
        location.hash = '#/messages';
      } catch (err) { toast(err.message, true); }
    });
  } catch (err) {
    mask.querySelector('#grp-member-list').innerHTML = emptyHtml(err.message);
  }
}

/** 拼手气红包弹窗(群内) */
function openLuckyModal(groupId) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-title">🧧 发拼手气红包</div>
      <div class="settings-input" style="cursor:default">我的CCB: <span class="coin" id="lucky-balance">${me.wallet ?? 0}</span></div>
      <input class="settings-input" id="lucky-amount" type="number" placeholder="总金额(CCB)" min="2">
      <input class="settings-input" id="lucky-count" type="number" placeholder="份数(2~总金额)" min="2">
      <input class="settings-input" id="lucky-note" type="text" placeholder="留言(可选)" maxlength="100">
      <div class="pay-tip">随机分配，每人至少 1 CCB，24 小时未抢完自动退回</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="lucky-cancel">取消</button>
        <button class="btn btn-gold" id="lucky-ok">塞钱进红包</button>
      </div>
    </div>`;
  document.body.appendChild(mask);
  const q = (sel) => mask.querySelector(sel);
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove(); });
  q('#lucky-cancel').addEventListener('click', () => mask.remove());
  q('#lucky-ok').addEventListener('click', async () => {
    const amount = Number(q('#lucky-amount').value);
    const count = Number(q('#lucky-count').value);
    const note = q('#lucky-note').value.trim();
    try {
      const d = await api('POST', '/api/payments', { type: 'lucky', group_id: groupId, amount, count, note });
      me.wallet = d.balance;
      updateWalletUI();
      mask.remove();
      toast('红包已发出');
      const data = await api('GET', `/api/groups/${groupId}?after=0`);
      if (data.messages.length) groupState.lastId = data.messages[data.messages.length - 1].id;
      renderGroupMessages(data.messages);
      scrollChatToBottom();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// ---------- 管理页 ----------

function renderAdminPage() {
  if (!me) return renderAuth('登录后即可访问管理页');
  if (me.is_admin !== 1) {
    toast('需要管理员权限', true);
    return renderHome();
  }

  $('#main').innerHTML = `
    <div class="page-title">管理</div>
    <div class="admin-tabs">
      <button class="admin-tab active" data-tab="users">用户</button>
      <button class="admin-tab" data-tab="dm">私信</button>
      <button class="admin-tab" data-tab="tickets">工单</button>
      <button class="admin-tab" data-tab="reports">举报</button>
      <button class="admin-tab" data-tab="agents">认证</button>
      <button class="admin-tab" data-tab="ai">AI互动</button>
      <button class="admin-tab" data-tab="rewards">奖励</button>
      <button class="admin-tab" data-tab="store">商品</button>
      <button class="admin-tab" data-tab="notice">公告</button>
      <button class="admin-tab" data-tab="broadcast">官方广播</button>
    </div>
    <div id="admin-content"></div>`;

  $('#main').querySelectorAll('.admin-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $('#main').querySelectorAll('.admin-tab').forEach((t) => t.classList.toggle('active', t === tab));
      const map = { users: renderAdminUsers, dm: renderAdminDm, tickets: renderAdminTickets, reports: renderAdminReports, agents: renderAdminAgents, ai: renderAdminAi, rewards: renderAdminRewards, store: renderAdminStore, notice: renderAdminNotices, broadcast: renderAdminBroadcast };
      (map[tab.dataset.tab] || renderAdminUsers)();
    });
  });

  renderAdminUsers();
}

// --- 官方广播 ---

/** 官方广播: 选中的官方 AI 发帖 + 群发私信(内容相同, 不调用 AI API) */
async function renderAdminBroadcast() {
  const box = $('#admin-content');
  box.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const data = await api('GET', '/api/bots');
    const bots = data.bots.filter((b) => b.is_official === 1);
    box.innerHTML = `
      <div class="store-section-title">选择官方 AI（它们将发帖并给所有用户发私信，不调用 AI API）</div>
      ${bots.length === 0 ? emptyHtml('暂无官方 AI（可在 用户→陪聊管理 里把陪聊设为官方）') : bots.map((b) => `
        <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer">
          <input type="checkbox" class="bc-bot" value="${b.user_id}"> ${escapeHtml(b.username)}
        </label>`).join('')}
      <div class="store-section-title" style="margin-top:12px">广播内容（帖子 + 私信内容相同，≤280 字）</div>
      <textarea class="settings-input" id="bc-content" rows="3" maxlength="280" placeholder="输入要发送的内容…"></textarea>
      <div style="margin-top:10px">
        <button class="btn btn-primary" id="bc-send" ${bots.length ? '' : 'disabled'}>执行广播</button>
        <span id="bc-status" style="font-size:12px"></span>
      </div>`;
    if (bots.length === 0) return;
    $('#bc-send').addEventListener('click', async () => {
      const botIds = [...box.querySelectorAll('.bc-bot:checked')].map((c) => Number(c.value));
      const content = $('#bc-content').value.trim();
      if (botIds.length === 0) return toast('请勾选至少一个官方 AI', true);
      if (!content) return toast('请输入广播内容', true);
      if (!window.confirm(`将让 ${botIds.length} 个官方 AI 各发 1 条帖子，并给所有用户发同一条私信，确定执行？`)) return;
      try {
        const r = await api('POST', '/api/admin/broadcast', { bot_ids: botIds, content });
        $('#bc-status').textContent = `✅ ${r.bots.join('、')} 已发帖 ${r.posts} 条，群发私信 ${r.messages} 条（发给 ${r.users} 个用户）`;
        toast('广播已发送');
      } catch (err) { toast(err.message, true); }
    });
  } catch (err) {
    box.innerHTML = emptyHtml(err.message);
  }
}

// --- 公告管理 ---

function renderAdminNotices() {
  const box = $('#admin-content');
  box.innerHTML = `
    <div class="admin-note" style="margin-bottom:6px">「关于」文案（右侧栏展示，1~500 字，保存后全站生效）</div>
    <textarea id="about-text" rows="3" maxlength="500" style="width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;color:var(--text);resize:vertical;outline:none"></textarea>
    <button class="btn btn-primary" id="about-save" type="button" style="padding:8px 18px;font-size:13px;margin-top:8px">保存「关于」</button>
    <div class="store-section-title" style="margin-top:18px">公告管理</div>
    <div class="admin-notice-create">
      <textarea id="notice-content" rows="2" maxlength="500" placeholder="公告内容（1~500 字）…" style="width:100%;background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px;color:var(--text);resize:vertical;outline:none"></textarea>
      <button class="btn btn-primary" id="notice-publish" type="button" style="padding:8px 18px;font-size:13px;margin-top:8px">发布公告</button>
    </div>
    <div id="notice-list" style="margin-top:14px"><div class="loading">加载中…</div></div>`;

  api('GET', '/api/about').then((data) => { $('#about-text').value = data.text || ''; }).catch(() => {});
  $('#about-save').addEventListener('click', async () => {
    const text = $('#about-text').value.trim();
    if (!text) return toast('「关于」内容不能为空', true);
    try {
      await api('POST', '/api/admin/about', { text });
      toast('已保存');
      refreshAsideAbout();
    } catch (err) { toast(err.message, true); }
  });

  $('#notice-publish').addEventListener('click', async () => {
    const content = $('#notice-content').value.trim();
    if (!content) return toast('公告内容不能为空', true);
    try {
      await api('POST', '/api/admin/announcements', { content });
      toast('公告已发布');
      $('#notice-content').value = '';
      loadNotices();
      refreshAsideAnnouncements();
    } catch (err) { toast(err.message, true); }
  });

  loadNotices();

  async function loadNotices() {
    const listBox = $('#notice-list');
    try {
      const data = await api('GET', '/api/admin/announcements');
      const list = data.announcements || [];
      if (list.length === 0) {
        listBox.innerHTML = emptyHtml('还没有发布过公告');
        return;
      }
      listBox.innerHTML = list.map((a) => `
        <div class="admin-report-row" style="margin-bottom:8px">
          <div class="admin-report-meta" style="flex:1">
            <span style="font-weight:600">${escapeHtml(a.content)}</span>
            <span class="admin-report-time">${a.created_at.slice(0, 16)} · ${a.active ? '展示中' : '已下架'}</span>
          </div>
          <button class="btn btn-ghost" type="button" style="padding:5px 12px;font-size:12px" data-notice-toggle="${a.id}" data-active="${a.active}">${a.active ? '下架' : '上架'}</button>
          <button class="btn btn-ghost" type="button" style="padding:5px 12px;font-size:12px;color:var(--danger)" data-notice-del="${a.id}">删除</button>
        </div>`).join('');
      listBox.querySelectorAll('[data-notice-toggle]').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = Number(b.dataset.noticeToggle);
          const active = b.dataset.active === '0';
          try {
            await api('POST', `/api/admin/announcements/${id}/toggle`, { active });
            loadNotices();
            refreshAsideAnnouncements();
          } catch (err) { toast(err.message, true); }
        });
      });
      listBox.querySelectorAll('[data-notice-del]').forEach((b) => {
        b.addEventListener('click', async () => {
          const id = Number(b.dataset.noticeDel);
          if (!window.confirm('确定删除这条公告？')) return;
          try {
            await api('DELETE', `/api/admin/announcements/${id}`);
            loadNotices();
            refreshAsideAnnouncements();
          } catch (err) { toast(err.message, true); }
        });
      });
    } catch (err) {
      listBox.innerHTML = emptyHtml(err.message);
    }
  }
}

// --- 用户管理(含处罚/解禁) ---

// --- Agent 认证管理 ---

function renderAdminAgents() {
  const box = $('#admin-content');
  box.innerHTML = '<div class="loading">加载中…</div>';
  load();

  async function load() {
    try {
      const data = await api('GET', '/api/admin/agents');
      if (data.agents.length === 0) {
        box.innerHTML = emptyHtml('暂无 Agent 账号');
        return;
      }
      box.innerHTML = data.agents.map((u) => {
        const statusHtml = u.agent_verified === 1
          ? '<span class="agent-badge">[AGENT]</span>'
          : u.agent_verified === -1
            ? '<span class="penalty-tag muted">认证被拒</span>'
            : '<span class="badge-pending">待认证</span>';
        const actions = u.agent_verified === 1
          ? '<button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" data-agent-revoke="' + u.id + '">撤销认证</button>'
          : '<button class="btn btn-primary" style="padding:6px 14px;font-size:12px" data-agent-approve="' + u.id + '">通过认证</button>'
            + '<button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" data-agent-reject="' + u.id + '">拒绝</button>';
        return `
          <div class="admin-report-row">
            <div class="admin-report-meta">
              ${avatarHtml(u, 'avatar-sm')}
              <span style="font-weight:600">@${escapeHtml(u.username)}</span>
              ${statusHtml}
              <span style="font-size:12px;color:var(--text-dim)">注册于 ${formatDateTime(u.created_at)}</span>
            </div>
            ${u.agent_intro ? '<div class="admin-report-reason">自述: ${escapeHtml(u.agent_intro)}</div>' : '<div class="admin-note">无自述</div>'}
            <div class="admin-report-actions">${actions}</div>
          </div>`;
      }).join('');

      box.querySelectorAll('[data-agent-approve]').forEach((btn) => {
        btn.addEventListener('click', () => verifyAgent(btn.dataset.agentApprove, true));
      });
      box.querySelectorAll('[data-agent-reject]').forEach((btn) => {
        btn.addEventListener('click', () => verifyAgent(btn.dataset.agentReject, false));
      });
      box.querySelectorAll('[data-agent-revoke]').forEach((btn) => {
        btn.addEventListener('click', () => verifyAgent(btn.dataset.agentRevoke, false));
      });
    } catch (err) {
      box.innerHTML = emptyHtml(err.message);
    }
  }
}

async function verifyAgent(id, approve) {
  try {
    await api('POST', '/api/admin/agents/' + id + '/verify', { approve });
    toast(approve ? '已通过认证并授予 [AGENT] 头衔' : '已拒绝/撤销认证');
    renderAdminAgents();
  } catch (err) {
    toast(err.message, true);
  }
}

// --- AI 互动频率管理(管理员控制 AI 调用成本) ---

function renderAdminAi() {
  const box = $('#admin-content');
  box.innerHTML = '<div class="loading">加载中…</div>';
  load();

  async function load() {
    try {
      const data = await api('GET', '/api/admin/ai-settings');
      const enabled = data.ai_interact_enabled === '1';
      const deep = data.ai_semantic_deep === '1';
      box.innerHTML = `
        <div class="admin-report-row" style="gap:14px">
          <div style="font-weight:700;font-size:16px">AI 互动频率控制</div>
          <div class="admin-note">设置实时生效(无需重启)。降低概率/拉长扫描间隔可显著节省 AI 调用成本。</div>

          <label style="display:flex;align-items:center;gap:8px;font-size:14px;min-height:44px;cursor:pointer">
            <input type="checkbox" id="ai-enabled" ${enabled ? 'checked' : ''}>
            启用主动互动(扫描评论/群聊/主动发帖/机器人互聊)
          </label>
          <div class="admin-note">关闭后机器人仍会回复用户主动发来的私信与被 @ 的群聊。</div>

          <label style="display:flex;align-items:center;gap:8px;font-size:14px;min-height:44px;cursor:pointer">
            <input type="checkbox" id="ai-deep" ${deep ? 'checked' : ''}>
            语义缓存深度归一化(推荐开启, 让"介绍一下你自己"也能命中"你是谁"的缓存)
          </label>
          <div class="admin-note">开启后未命中时会用一次极小的 LLM 调用(max_tokens=24)标准化问句; 命中一次即可省回多次完整回复成本。</div>

          <div class="ds-row">
            <span class="ds-label" style="min-width:100px">评论回复概率</span>
            <input type="range" id="ai-comment-rate" min="0" max="100" step="5" value="${data.ai_comment_reply_rate}">
            <span class="ds-label" style="min-width:52px;text-align:right" id="ai-comment-rate-val">${data.ai_comment_reply_rate}%</span>
          </div>
          <div class="ds-row">
            <span class="ds-label" style="min-width:100px">群聊回复概率</span>
            <input type="range" id="ai-group-rate" min="0" max="100" step="5" value="${data.ai_group_reply_rate}">
            <span class="ds-label" style="min-width:52px;text-align:right" id="ai-group-rate-val">${data.ai_group_reply_rate}%</span>
          </div>
          <div class="ds-row">
            <span class="ds-label" style="min-width:100px">带图帖子浏览概率</span>
            <input type="range" id="ai-post-img-rate" min="0" max="100" step="1" value="${data.ai_post_image_rate}">
            <span class="ds-label" style="min-width:52px;text-align:right" id="ai-post-img-rate-val">${data.ai_post_image_rate}%</span>
          </div>
          <div class="admin-note">AI 主动浏览带图帖子时用此低概率(建议 3~5%)，普通帖子仍走评论回复概率。</div>
          <div class="ds-row">
            <span class="ds-label" style="min-width:100px">扫描间隔</span>
            <input class="stock-trade-input" id="ai-engage-interval" type="number" min="1" max="1440" value="${data.ai_engage_interval}" style="max-width:120px;flex:none">
            <span class="ds-label">分钟(1~1440)</span>
          </div>

          <div class="admin-report-actions" style="border-top:1px solid var(--border-soft);padding-top:12px">
            <button class="btn btn-primary" id="ai-save">保存</button>
          </div>
        </div>`;

      const showComment = () => { $('#ai-comment-rate-val').textContent = $('#ai-comment-rate').value + '%'; };
      const showGroup = () => { $('#ai-group-rate-val').textContent = $('#ai-group-rate').value + '%'; };
      const showPostImg = () => { $('#ai-post-img-rate-val').textContent = $('#ai-post-img-rate').value + '%'; };
      $('#ai-comment-rate').addEventListener('input', showComment);
      $('#ai-group-rate').addEventListener('input', showGroup);
      $('#ai-post-img-rate').addEventListener('input', showPostImg);

      $('#ai-save').addEventListener('click', async () => {
        try {
          await api('POST', '/api/admin/ai-settings', {
            ai_interact_enabled: $('#ai-enabled').checked ? '1' : '0',
            ai_semantic_deep: $('#ai-deep').checked ? '1' : '0',
            ai_comment_reply_rate: Number($('#ai-comment-rate').value),
            ai_group_reply_rate: Number($('#ai-group-rate').value),
            ai_engage_interval: Number($('#ai-engage-interval').value),
            ai_post_image_rate: Number($('#ai-post-img-rate').value),
          });
          toast('已保存');
        } catch (err) {
          toast(err.message, true);
        }
      });
    } catch (err) {
      box.innerHTML = emptyHtml(err.message);
    }
  }
}

/** 管理页: CCB 互动奖励额度与频率调整(存 settings 表, 实时生效) */
const REWARD_LABELS = [
  ['daily', '每日登录', false],
  ['post', '发帖', true],
  ['comment', '评论', true],
  ['liked', '帖子被点赞（作者）', true],
  ['like', '点赞（点赞者）', true],
  ['followed', '被关注', true],
  ['follow', '关注别人', true],
];
function renderAdminRewards() {
  const box = $('#admin-content');
  box.innerHTML = '<div class="loading">加载中…</div>';
  load();

  async function load() {
    try {
      const data = await api('GET', '/api/admin/rewards');
      box.innerHTML = `
        <div class="admin-report-row" style="gap:14px">
          <div style="font-weight:700;font-size:16px">CCB 互动奖励</div>
          <div class="admin-note">设置实时生效（无需重启）。额度设为 0 即关闭该奖励；每日次数上限 0=不限；冷却 0=无。每日登录固定 1 次/天。关注/点赞奖励按动作发放，注意刷币风险。</div>
          <div class="ds-row" style="border-bottom:1px solid var(--border-soft);padding-bottom:6px;font-size:13px;color:var(--text-dim)">
            <span class="ds-label" style="min-width:130px">奖励</span>
            <span class="ds-label" style="width:120px;text-align:left">额度(CCB)</span>
            <span class="ds-label" style="width:140px;text-align:left">每日次数上限</span>
            <span class="ds-label">冷却(分钟)</span>
          </div>
          ${REWARD_LABELS.map(([key, label, hasFreq]) => `
            <div class="ds-row">
              <span class="ds-label" style="min-width:130px">${label}</span>
              <input class="stock-trade-input" data-reward="${key}" type="number" min="0" value="${data[key]}" style="max-width:120px;flex:none">
              ${hasFreq ? `
              <input class="stock-trade-input" data-reward="${key}_cap" type="number" min="0" value="${data[key + '_cap']}" style="max-width:120px;flex:none">
              <input class="stock-trade-input" data-reward="${key}_cooldown" type="number" min="0" value="${data[key + '_cooldown']}" style="max-width:120px;flex:none">`
              : '<span class="ds-label">1 次/天</span>'}
            </div>`).join('')}
          <div class="admin-report-actions" style="border-top:1px solid var(--border-soft);padding-top:12px">
            <button class="btn btn-primary" id="rewards-save">保存</button>
          </div>
        </div>`;
      $('#rewards-save').addEventListener('click', async () => {
        try {
          const patch = {};
          box.querySelectorAll('[data-reward]').forEach((input) => { patch[input.dataset.reward] = Number(input.value); });
          await api('POST', '/api/admin/rewards', patch);
          toast('已保存');
        } catch (err) {
          toast(err.message, true);
        }
      });
    } catch (err) {
      box.innerHTML = emptyHtml(err.message);
    }
  }
}

function renderAdminUsers() {
  const box = $('#admin-content');
  box.innerHTML = `
    <form class="admin-search-row" id="admin-user-search">
      <input type="search" placeholder="按用户名过滤…" id="admin-user-q">
      <button class="btn btn-primary" type="submit">筛选</button>
    </form>
    <div id="admin-user-list"><div class="loading">加载中…</div></div>`;

  const load = async () => {
    const q = $('#admin-user-q').value.trim();
    try {
      const data = await api('GET', `/api/admin/users?q=${encodeURIComponent(q)}`);
      const list = $('#admin-user-list');
      if (data.users.length === 0) {
        list.innerHTML = emptyHtml('没有匹配的用户');
        return;
      }
      list.innerHTML = data.users.map((u) => {
        const tags = [];
        if (u.is_admin === 1) tags.push('<span class="admin-tag">管理员</span>');
        if (u.ban_until === 'forever') tags.push('<span class="penalty-tag banned">永久封禁</span>');
        else if (u.ban_until) tags.push(`<span class="penalty-tag banned">封禁至 ${u.ban_until.slice(0, 10)}</span>`);
        if (u.mute_until) tags.push(`<span class="penalty-tag muted">禁言至 ${u.mute_until.slice(0, 10)}</span>`);
        return `
          <div class="admin-user-row" data-admin-user="${u.id}">
            ${avatarHtml(u, 'avatar-sm')}
            <div class="info">
              <div class="name">${escapeHtml(u.username)} ${titleBadge(u.title, u.title_css)} ${tags.join(' ')}</div>
              <div class="stats">发帖 ${u.post_count} · 评论 ${u.comment_count} · CCB ${u.wallet}${u.bio ? ` · ${escapeHtml(u.bio.slice(0, 20))}` : ''}</div>
              <div class="quick-edit">
                <input type="number" data-wwallet="${u.id}" value="${u.wallet}" min="0" title="CCB余额">
                <button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-wsave="${u.id}">保存</button>
                <button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-wplus="${u.id}" data-amt="100">+100</button>
                <button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-wminus="${u.id}" data-amt="100">-100</button>
                ${u.id !== me.id && u.username !== 'MicroX'
                  ? `<button class="btn btn-danger" style="padding:3px 10px;font-size:12px" data-deluser="${u.id}" data-delname="${escapeHtml(u.username)}">删除</button>` : ''}
              </div>
            </div>
          </div>`;
      }).join('');
      list.querySelectorAll('.admin-user-row').forEach((row) => {
        row.addEventListener('click', () => renderAdminUserEdit(Number(row.dataset.adminUser), data.users.find((u) => u.id === Number(row.dataset.adminUser))));
      });
      // 行内CCB快捷调整(阻止冒泡, 避免触发打开编辑面板)
      list.querySelectorAll('[data-wsave], [data-wplus], [data-wminus]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = Number(btn.dataset.wsave || btn.dataset.wplus || btn.dataset.wminus);
          let amount = Number(list.querySelector(`[data-wwallet="${id}"]`).value);
          if (btn.dataset.wplus) amount += Number(btn.dataset.wplus);
          if (btn.dataset.wminus) amount = Math.max(0, amount - Number(btn.dataset.wminus));
          if (!Number.isInteger(amount) || amount < 0) return toast('CCB数量不合法', true);
          try {
            await api('PATCH', `/api/admin/users/${id}`, { wallet: amount });
            toast('CCB已更新');
            load();
          } catch (err) {
            toast(err.message, true);
          }
        });
      });
      // 行内删除用户(阻止冒泡; 二次确认, 不可恢复)
      list.querySelectorAll('[data-deluser]').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = Number(btn.dataset.deluser);
          const name = btn.dataset.delname;
          if (!window.confirm(`确定删除用户 ${name} 吗？\n\n将永久删除该用户的全部数据：帖子、评论、私信、关注、股票、他创建的陪聊机器人等，且不可恢复！`)) return;
          try {
            await api('DELETE', `/api/admin/users/${id}`);
            toast(`用户 ${name} 已删除`);
            load();
          } catch (err) {
            toast(err.message, true);
          }
        });
      });
    } catch (err) {
      $('#admin-user-list').innerHTML = emptyHtml(err.message);
    }
  };

  $('#admin-user-search').addEventListener('submit', (e) => { e.preventDefault(); load(); });
  load();
}

function renderAdminUserEdit(id, user) {
  const list = $('#admin-user-list');
  $('#admin-user-edit')?.remove();
  const panel = document.createElement('div');
  panel.className = 'admin-user-edit';
  panel.id = 'admin-user-edit';
  panel.innerHTML = `
      <div style="font-weight:700">编辑用户: ${escapeHtml(user.username)}（CCB ${user.wallet}）</div>
      <input class="settings-input" id="admin-edit-username" value="${escapeHtml(user.username)}" maxlength="20">
      <textarea class="settings-input" id="admin-edit-bio" rows="2" maxlength="160" placeholder="自我介绍">${escapeHtml(user.bio || '')}</textarea>
      <input class="settings-input" id="admin-edit-password" type="password" placeholder="新密码(留空不修改)" maxlength="64">
      <input class="settings-input" id="admin-edit-wallet" type="number" placeholder="CCB余额" min="0" value="${user.wallet}">
      <div class="avatar-edit">
        <label class="btn btn-ghost" for="admin-edit-avatar" style="padding:8px 18px">更换头像</label>
        <input id="admin-edit-avatar" type="file" accept="image/jpeg,image/png,image/webp,image/gif">
      </div>
      ${user.id !== me.id ? `
        <label style="display:flex;align-items:center;gap:8px;font-size:14px">
          <input type="checkbox" id="admin-edit-isadmin" ${user.is_admin === 1 ? 'checked' : ''}> 设为管理员
        </label>` : ''}
      ${user.id !== me.id ? `
        <div class="sell-form-row" style="border-top:1px solid var(--border-soft);padding-top:12px">
          <span class="settings-label">授予物品（任意商品/限定）</span>
          <select class="settings-input" id="admin-grant-item-sel"></select>
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" id="admin-grant-item-btn">发放</button>
        </div>
        <div class="sell-form-row" style="border-top:1px solid var(--border-soft);padding-top:12px">
          <span class="settings-label">开通陪聊订阅</span>
          <select class="settings-input" id="admin-grant-bot-sel"></select>
          <input class="settings-input" id="admin-grant-bot-days" type="number" min="1" max="3650" value="30" style="max-width:80px">
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" id="admin-grant-bot-btn">开通</button>
        </div>
        <div class="sell-form-row" style="border-top:1px solid var(--border-soft);padding-top:12px">
          <span class="settings-label">处罚/解禁</span>
          <input id="admin-penalty-days" type="number" placeholder="天数" min="1" style="max-width:100px">
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" data-penalty="ban">永久封禁</button>
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" data-penalty="ban-days">封禁N天</button>
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" data-penalty="mute">禁言N天</button>
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" data-penalty="unban">解封</button>
          <button class="btn btn-ghost" style="padding:6px 12px;font-size:12px" data-penalty="unmute">解禁</button>
        </div>` : ''}
      <div style="display:flex;gap:10px">
        <button class="btn btn-primary" id="admin-edit-save">保存</button>
        <button class="btn btn-ghost" id="admin-edit-cancel">取消</button>
      </div>`;
  // 插入到被点击用户所在行之后, 与被编辑者保持视觉关联(而非堆到列表顶部)
  const row = list.querySelector(`.admin-user-row[data-admin-user="${id}"]`);
  if (row && row.parentNode === list) row.after(panel);
  else list.insertAdjacentElement('afterbegin', panel);

  $('#admin-edit-cancel').addEventListener('click', () => $('#admin-user-edit')?.remove());

  // 处罚按钮
  $('#admin-user-edit').querySelectorAll('[data-penalty]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const kind = btn.dataset.penalty;
      const days = Number($('#admin-penalty-days').value);
      const body = {};
      if (kind === 'ban') body.type = 'ban';
      else if (kind === 'ban-days') { body.type = 'ban'; body.days = days; }
      else if (kind === 'mute') { body.type = 'mute'; body.days = days; }
      else if (kind === 'unban') body.type = 'unban';
      else if (kind === 'unmute') body.type = 'unmute';
      try {
        await api('POST', `/api/admin/users/${id}/penalty`, body);
        toast('操作成功');
        renderAdminUsers();
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  // 授予区: 下拉数据填充(物品/陪聊)
  const populateAdminGrantSelects = async () => {
    try {
      const itemsData = await api('GET', '/api/admin/items-all');
      const itemSel = $('#admin-grant-item-sel');
      if (itemSel) itemSel.innerHTML = itemsData.items.map((it) =>
        `<option value="${it.id}">${escapeHtml(it.name)}（${TYPE_LABELS[it.type] || it.type}${it.limited ? '·限定' : ''}）</option>`).join('');
      const botsData = await api('GET', '/api/bots');
      const botSel = $('#admin-grant-bot-sel');
      if (botSel) botSel.innerHTML = botsData.bots.map((b) =>
        `<option value="${b.user_id}">${escapeHtml(b.username)}</option>`).join('');
    } catch (err) { toast(err.message, true); }
  };
  populateAdminGrantSelects();

  $('#admin-grant-item-btn')?.addEventListener('click', async () => {
    const itemId = Number($('#admin-grant-item-sel')?.value);
    if (!itemId) return toast('请选择物品', true);
    try {
      const data = await api('POST', `/api/admin/users/${id}/grant-item`, { item_id: itemId });
      toast(data.granted ? '物品已发放' : '对方已拥有该物品，未重复发放');
    } catch (err) { toast(err.message, true); }
  });

  $('#admin-grant-bot-btn')?.addEventListener('click', async () => {
    const botId = Number($('#admin-grant-bot-sel')?.value);
    const days = Number($('#admin-grant-bot-days')?.value);
    if (!botId || !Number.isInteger(days) || days < 1 || days > 3650) return toast('请选择陪聊并填写有效天数', true);
    try {
      const data = await api('POST', `/api/admin/users/${id}/grant-bot-sub`, { bot_id: botId, days });
      toast(`已开通订阅至 ${data.expires_at.slice(0, 10)}`);
    } catch (err) { toast(err.message, true); }
  });

  $('#admin-edit-save').addEventListener('click', async () => {
    const payload = {
      username: $('#admin-edit-username').value.trim(),
      bio: $('#admin-edit-bio').value,
      password: $('#admin-edit-password').value || undefined,
      wallet: Number($('#admin-edit-wallet').value),
      is_admin: $('#admin-edit-isadmin')?.checked,
    };
    const avatarFile = $('#admin-edit-avatar').files[0];
    if (avatarFile) {
      try {
        payload.avatar = await fileToDataUrl(avatarFile, { size: 128, square: true });
      } catch (err) {
        toast(err.message, true);
        return;
      }
    }
    try {
      await api('PATCH', `/api/admin/users/${id}`, payload);
      toast('已保存');
      renderAdminUsers();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

// --- 私信监管 ---

function renderAdminDm() {
  const box = $('#admin-content');
  box.innerHTML = '<div class="loading">加载中…</div>';
  loadAdminDm();

  async function loadAdminDm() {
    try {
      const data = await api('GET', '/api/admin/conversations');
      if (data.conversations.length === 0) {
        box.innerHTML = emptyHtml('全站还没有任何私信');
        return;
      }
      box.innerHTML = data.conversations.map((c) => `
        <div class="admin-conv-row" data-conv-a="${escapeHtml(c.user_a)}" data-conv-b="${escapeHtml(c.user_b)}">
          ${avatarHtml({ username: c.user_a, avatar: '' }, 'avatar-sm')}
          <span style="font-weight:600">${escapeHtml(c.user_a)}</span>
          <span style="color:var(--text-dim)">⇄</span>
          ${avatarHtml({ username: c.user_b, avatar: '' }, 'avatar-sm')}
          <div class="msg-list-info">
            <div class="msg-list-name">${escapeHtml(c.user_a)} ↔ ${escapeHtml(c.user_b)} · ${c.cnt} 条</div>
            <div class="msg-list-preview">${escapeHtml(c.last_image ? '[图片]' : c.last_content)}</div>
          </div>
        </div>`).join('');

      box.querySelectorAll('.admin-conv-row').forEach((row) => {
        row.addEventListener('click', () => viewAdminDm(row.dataset.convA, row.dataset.convB));
      });
    } catch (err) {
      box.innerHTML = emptyHtml(err.message);
    }
  }
}

async function viewAdminDm(userA, userB) {
  const box = $('#admin-content');
  box.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const data = await api('GET', `/api/admin/messages?userA=${encodeURIComponent(userA)}&userB=${encodeURIComponent(userB)}`);
    box.innerHTML = `
      <div class="msg-chat-head" style="border-bottom:1px solid var(--border);padding:12px 16px">
        <button class="msg-back" id="admin-dm-back" type="button">← 返回</button>
        <span style="font-weight:700">${escapeHtml(userA)} ↔ ${escapeHtml(userB)}</span>
      </div>
      <div class="msg-body" style="min-height:300px">
        ${data.messages.map((m) => {
          const img = m.image ? `<img src="/uploads/${encodeURIComponent(m.image)}" alt="消息图片" style="display:block;max-width:220px;border-radius:10px;margin-top:4px">` : '';
          return `<div class="msg-bubble msg-theirs" style="max-width:100%"><span style="font-weight:700;color:var(--accent)">${escapeHtml(m.sender_name)}</span>: ${escapeHtml(m.content)}${img}<div class="msg-time">${formatTime(m.created_at)}</div></div>`;
        }).join('')}
      </div>`;
    $('#admin-dm-back').addEventListener('click', () => renderAdminDm());
  } catch (err) {
    box.innerHTML = emptyHtml(err.message);
  }
}

// --- 工单处理 ---

function renderAdminTickets() {
  const box = $('#admin-content');
  box.innerHTML = '<div class="loading">加载中…</div>';
  load();

  async function load() {
    try {
      const data = await api('GET', '/api/admin/tickets');
      if (data.tickets.length === 0) {
        box.innerHTML = emptyHtml('暂无工单');
        return;
      }
      box.innerHTML = data.tickets.map((t) => `
        <div class="ticket-card">
          <div class="ticket-head">
            <span class="ticket-subject">#${t.id} ${escapeHtml(t.subject)}</span>
            <span class="ticket-status ${t.status}">${t.status === 'open' ? '待处理' : '已处理'}</span>
            <span style="font-size:12px;color:var(--text-dim)">@${escapeHtml(t.username)}</span>
          </div>
          <div class="ticket-body">${escapeHtml(t.body)}</div>
          ${t.admin_reply ? `<div class="ticket-reply">已回复: ${escapeHtml(t.admin_reply)}</div>` : ''}
          ${t.status === 'open'
            ? `<div class="ticket-form" style="padding:10px 0 0">
                <textarea id="ticket-reply-${t.id}" placeholder="回复并关闭工单…" rows="2"></textarea>
                <button class="btn btn-primary" style="align-self:flex-start;padding:6px 16px;font-size:13px" data-ticket-reply="${t.id}">回复并关闭</button>
              </div>`
            : ''}
          <div class="ticket-meta">提交于 ${formatDateTime(t.created_at)}</div>
        </div>`).join('');

      box.querySelectorAll('[data-ticket-reply]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.ticketReply;
          const reply = $(`#ticket-reply-${id}`).value.trim();
          try {
            await api('POST', `/api/admin/tickets/${id}/reply`, { reply });
            toast('已回复并关闭工单');
            load();
          } catch (err) {
            toast(err.message, true);
          }
        });
      });
    } catch (err) {
      box.innerHTML = emptyHtml(err.message);
    }
  }
}

// --- 举报处理 ---

function renderAdminReports() {
  const box = $('#admin-content');
  box.innerHTML = '<div class="loading">加载中…</div>';
  load();

  async function load() {
    try {
      const data = await api('GET', '/api/admin/reports');
      if (data.reports.length === 0) {
        box.innerHTML = emptyHtml('暂无举报');
        return;
      }
      const TYPE_LABEL = { item: '商品', shop: '商铺', post: '帖子', user: '用户' };
      box.innerHTML = data.reports.map((r) => `
        <div class="admin-report-row">
          <div class="admin-report-meta">
            <span class="store-tag">#${r.id}</span>
            <span class="store-tag">${TYPE_LABEL[r.target_type] || r.target_type}#${r.target_id}</span>
            <span style="font-size:12px;color:var(--text-dim)">举报人: @${escapeHtml(r.reporter_name)}</span>
            <span class="${r.status === 'pending' ? 'badge-pending' : 'badge-resolved'}">${r.status === 'pending' ? '待处理' : '已处理'}</span>
            <span style="font-size:12px;color:var(--text-dim)">${formatDateTime(r.created_at)}</span>
          </div>
          <div class="admin-report-reason">理由: ${escapeHtml(r.reason)}</div>
          ${r.admin_note ? `<div class="admin-note">处理备注: ${escapeHtml(r.admin_note)}</div>` : ''}
          ${r.status === 'pending' ? `
            <div class="admin-report-actions" data-report-id="${r.id}" data-report-type="${r.target_type}">
              <select data-field="action" style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:13px;color:var(--text)">
                ${actionOptions(r.target_type)}
              </select>
              <input data-field="days" type="number" placeholder="天数(封禁/禁言)" min="1">
              <input data-field="note" placeholder="备注(可选)">
              <button class="btn btn-primary" data-resolve>处理</button>
              <button class="btn btn-ghost" data-dismiss>驳回</button>
            </div>` : ''}
        </div>`).join('');

      box.querySelectorAll('.admin-report-actions').forEach((row) => {
        const id = Number(row.dataset.reportId);
        const reportType = row.dataset.reportType;
        row.querySelector('[data-dismiss]').addEventListener('click', () => resolveReport(id, 'dismiss', null, ''));
        row.querySelector('[data-resolve]').addEventListener('click', () => {
          const action = row.querySelector('[data-field="action"]').value;
          const days = Number(row.querySelector('[data-field="days"]').value);
          const note = row.querySelector('[data-field="note"]').value.trim();
          resolveReport(id, action, days, note);
        });
        // 动作切换时根据是否需要天数显隐
        const updateDays = () => {
          const act = row.querySelector('[data-field="action"]').value;
          row.querySelector('[data-field="days"]').style.display = (act === 'ban_user' || act === 'mute_user' || act === 'ban') ? '' : 'none';
        };
        row.querySelector('[data-field="action"]').addEventListener('change', updateDays);
        updateDays();
      });
    } catch (err) {
      box.innerHTML = emptyHtml(err.message);
    }
  }
}

/** 根据举报类型生成处理动作选项 */
function actionOptions(type) {
  if (type === 'post') {
    return '<option value="delete_post">删除帖子</option>';
  }
  if (type === 'item') {
    return '<option value="disable_item">处罚下架(押金没收)</option>';
  }
  if (type === 'shop') {
    return '<option value="close_shop">封店(全部下架,押金没收)</option>';
  }
  return '<option value="ban_user">封禁(默认永久)</option><option value="mute_user">禁言</option>';
}

async function resolveReport(id, action, days, note) {
  try {
    await api('POST', `/api/admin/reports/${id}/resolve`, { action, days: days || undefined, note });
    toast('已处理');
    renderAdminReports();
  } catch (err) {
    toast(err.message, true);
  }
}

// --- 商品管理(可视化设计器 + 快捷调价) ---

/** 头像框/气泡/头衔设计预设(边框色/光晕/背景) */
const DESIGN_PRESETS = {
  '经典金': { c: '#ffd400', g: 12, gc: '#ffd400', bg: '#1d1f23' },
  '霓虹粉': { c: '#f91880', g: 16, gc: '#f91880', bg: '#2a1220' },
  '海洋蓝': { c: '#1d9bf0', g: 12, gc: '#1d9bf0', bg: '#0f2433' },
  '翡翠绿': { c: '#00ba7c', g: 12, gc: '#00ba7c', bg: '#0f2a20' },
  '紫罗兰': { c: '#a855f7', g: 14, gc: '#a855f7', bg: '#231333' },
  '极简白': { c: '#e7e9ea', g: 0, gc: '#e7e9ea', bg: '#1d1f23' },
  '烈焰橙': { c: '#ff7a00', g: 14, gc: '#ff7a00', bg: '#2b1a0f' },
};

const dsStates = {
  avatar_frame: { border: '#ffd400', bw: 3, glow: '#ffd400', gw: 12, css: 'border:3px solid #ffd400; box-shadow:0 0 12px #ffd400', name: '', price: '', monthly: '0' },
  chat_bubble: { border: '#a855f7', bw: 2, glow: '#a855f7', gw: 10, bg: '#1d1f23', r: 16, css: 'background:#1d1f23; border:2px solid #a855f7; border-radius:16px; box-shadow:0 0 10px #a855f7', name: '', price: '', monthly: '0' },
  title: { color: '#ffd400', name: '', price: '', monthly: '0' },
};

/** 设计器单行控件 HTML(取色器) */
function dsColorRow(id, label, value) {
  return `<div class="ds-row"><span class="ds-label">${label}</span><input type="color" id="${id}" value="${value}"></div>`;
}

/** 设计器单行控件 HTML(滑杆) */
function dsRangeRow(id, label, value, min, max, unit) {
  return `<div class="ds-row"><span class="ds-label">${label} <b id="${id}-v">${value}</b>${unit}</span><input type="range" id="${id}" min="${min}" max="${max}" value="${value}"></div>`;
}

/**
 * 渲染某个类型的独立设计器面板。
 * @param {string} mode avatar_frame | chat_bubble | title
 */
function renderDsPanel(mode) {
  const panel = $('#ds-panel');
  const s = dsStates[mode];
  const pf = mode === 'title' ? 't' : mode === 'chat_bubble' ? 'b' : 'f';

  // 预览区(按类型不同)
  let previewHtml;
  if (mode === 'avatar_frame') {
    previewHtml = `<span class="avatar avatar-lg" id="${pf}-target"><span style="background:#1d9bf0">A</span></span>`;
  } else if (mode === 'chat_bubble') {
    previewHtml = `<div class="bubble-preview" id="${pf}-target">聊天气泡样式预览</div>`;
  } else {
    previewHtml = `<span class="user-title" id="${pf}-target" style="font-size:20px;border-width:2px">${escapeHtml(s.name || '头衔名称')}</span>`;
  }

  // 控件区(按类型不同)
  let rows = '';
  if (mode !== 'title') {
    rows += dsColorRow(`${pf}-border`, '边框颜色', s.border);
    rows += dsRangeRow(`${pf}-bw`, '边框粗细', s.bw, 0, 12, 'px');
    rows += dsColorRow(`${pf}-glow`, '光晕颜色', s.glow);
    rows += dsRangeRow(`${pf}-gw`, '光晕强度', s.gw, 0, 40, 'px');
  }
  if (mode === 'chat_bubble') {
    rows += dsColorRow(`${pf}-bg`, '气泡背景', s.bg);
    rows += dsRangeRow(`${pf}-r`, '气泡圆角', s.r, 0, 30, 'px');
  }
  if (mode === 'title') {
    rows += dsColorRow(`${pf}-color`, '头衔颜色', s.color);
  }

  panel.innerHTML = `
    <div class="designer">
      <div class="designer-body">
        <div class="designer-preview"><div class="ds-preview-item">${previewHtml}</div></div>
        <div class="designer-controls">
          <div class="ds-row ds-presets"><span class="ds-label">预设</span>
            ${Object.keys(DESIGN_PRESETS).map((n) => `<button type="button" class="preset-btn" data-preset="${n}">${n}</button>`).join('')}
          </div>
          ${rows}
          <textarea id="${pf}-css" rows="2" spellcheck="false">${escapeHtml(s.css || '')}</textarea>
          <div class="ds-row">
            <span class="ds-label">名称</span>
            <input type="text" id="${pf}-name" placeholder="商品名称" maxlength="30" value="${escapeHtml(s.name)}">
            <input type="number" id="${pf}-price" placeholder="买断价" min="1" value="${escapeHtml(s.price)}" style="max-width:100px">
            <input type="number" id="${pf}-monthly" placeholder="月订阅价" min="0" value="${escapeHtml(s.monthly)}" style="max-width:110px">
          </div>
          <button class="btn btn-gold" id="${pf}-submit" style="align-self:flex-start">上架此商品</button>
        </div>
      </div>
    </div>`;

  bindDsPanel(mode, pf);
}

/**
 * 绑定独立设计器面板事件。
 * @param {string} mode 类型
 * @param {string} pf 元素前缀(f/b/t)
 */
function bindDsPanel(mode, pf) {
  const s = dsStates[mode];
  const q = (sel) => $('#ds-panel').querySelector(sel);
  const target = q(`#${pf}-target`);

  /** 收集控件当前值到 state 并生成 CSS */
  const gen = () => {
    if (mode === 'avatar_frame') {
      s.border = q(`#${pf}-border`).value;
      s.bw = Number(q(`#${pf}-bw`).value);
      s.glow = q(`#${pf}-glow`).value;
      s.gw = Number(q(`#${pf}-gw`).value);
      // 头像框不能带 border-radius, 否则破坏 .avatar 的圆形
      s.css = `border:${s.bw}px solid ${s.border}; box-shadow:0 0 ${s.gw}px ${s.glow}`;
    } else if (mode === 'chat_bubble') {
      s.border = q(`#${pf}-border`).value;
      s.bw = Number(q(`#${pf}-bw`).value);
      s.glow = q(`#${pf}-glow`).value;
      s.gw = Number(q(`#${pf}-gw`).value);
      s.bg = q(`#${pf}-bg`).value;
      s.r = Number(q(`#${pf}-r`).value);
      s.css = `background:${s.bg}; border:${s.bw}px solid ${s.border}; border-radius:${s.r}px; box-shadow:0 0 ${s.gw}px ${s.glow}`;
    } else {
      s.color = q(`#${pf}-color`).value;
      s.css = s.color;
    }
    q(`#${pf}-css`).value = s.css;
    applyPreview();
  };

  /** 将 CSS 文本应用到预览(手动编辑模式) */
  const applyPreview = () => {
    if (mode === 'title') {
      target.style.color = q(`#${pf}-css`).value.trim();
      target.textContent = q(`#${pf}-name`).value.trim() || '头衔名称';
    } else {
      target.style.cssText = q(`#${pf}-css`).value.trim();
    }
  };

  // 取色器 / 滑杆 -> 重新生成 CSS
  for (const id of [`${pf}-border`, `${pf}-glow`, `${pf}-bg`, `${pf}-color`]) {
    const el = q(`#${id}`);
    if (el) el.addEventListener('input', gen);
  }
  for (const id of [`${pf}-bw`, `${pf}-gw`, `${pf}-r`]) {
    const el = q(`#${id}`);
    if (el) {
      el.addEventListener('input', (e) => {
        q(`#${id}-v`).textContent = e.target.value;
        gen();
      });
    }
  }
  // 手动编辑 CSS 文本 -> 仅应用到预览
  q(`#${pf}-css`).addEventListener('input', applyPreview);
  // 头衔/名称实时预览
  q(`#${pf}-name`).addEventListener('input', () => {
    s.name = q(`#${pf}-name`).value;
    if (mode === 'title') {
      target.textContent = s.name.trim() || '头衔名称';
    }
  });
  // 预设 -> 应用配色并重新生成
  $('#ds-panel').querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = DESIGN_PRESETS[btn.dataset.preset];
      if (mode === 'title') {
        q(`#${pf}-color`).value = p.c;
      } else {
        q(`#${pf}-border`).value = p.c;
        q(`#${pf}-glow`).value = p.gc;
        q(`#${pf}-bw`).value = p.g > 0 ? Math.max(2, Math.round(p.g / 4)) : 1;
        q(`#${pf}-gw`).value = p.g;
        q(`#${pf}-bw-v`).textContent = q(`#${pf}-bw`).value;
        q(`#${pf}-gw-v`).textContent = p.g;
      }
      gen();
    });
  });
  // 上架
  q(`#${pf}-submit`).addEventListener('click', async () => {
    const name = q(`#${pf}-name`).value.trim();
    const price = Number(q(`#${pf}-price`).value);
    const monthly = Number(q(`#${pf}-monthly`).value) || 0;
    const data = q(`#${pf}-css`).value.trim();
    try {
      await api('POST', '/api/admin/store/items', { name, type: mode, price, monthly_price: monthly, data });
      s.name = '';
      q(`#${pf}-name`).value = '';
      toast('已上架');
      loadAdminStoreList();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 初始化预览
  applyPreview();
}

function renderAdminStore() {
  const box = $('#admin-content');
  box.innerHTML = `
    <div class="store-summary" id="admin-store-summary"></div>
    <div class="ds-tabs">
      <button class="ds-tab active" data-ds-tab="avatar_frame">头像框设计</button>
      <button class="ds-tab" data-ds-tab="chat_bubble">聊天气泡设计</button>
      <button class="ds-tab" data-ds-tab="title">头衔设计</button>
    </div>
    <div id="ds-panel"></div>
    <div class="store-section-title">全部商品（点击行内价格可快捷修改）</div>
    <div id="admin-item-list"><div class="loading">加载中…</div></div>`;

  // 子 Tab 切换(三种设计器各自独立, 状态互不干扰)
  box.querySelectorAll('.ds-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      box.querySelectorAll('.ds-tab').forEach((t) => t.classList.toggle('active', t === tab));
      renderDsPanel(tab.dataset.dsTab);
    });
  });

  renderDsPanel('avatar_frame');
  loadAdminStoreList();
}

/** 商品列表: 统计卡片 + 快捷调价 + 上下架 */
async function loadAdminStoreList() {
  try {
    const adminItems = await api('GET', '/api/admin/items-all');
    const items = adminItems.items;
    const list = $('#admin-item-list');

    // 统计卡片
    const stats = {
      在售: items.filter((i) => i.status === 'active').length,
      已下架: items.filter((i) => i.status === 'disabled').length,
      官方: items.filter((i) => i.seller_id === null).length,
      卖家: items.filter((i) => i.seller_id !== null).length,
      总销量: items.reduce((s2, i) => s2 + i.sales, 0),
    };
    $('#admin-store-summary').innerHTML = Object.entries(stats).map(([k, v]) =>
      `<div class="store-stat"><b>${v}</b><span>${k}</span></div>`).join('');

    if (items.length === 0) {
      list.innerHTML = emptyHtml('暂无商品');
      return;
    }
    list.innerHTML = items.map((it) => {
      // 缩略预览
      const thumb = it.type === 'avatar_frame'
        ? `<span class="avatar avatar-sm" style="${escapeHtml(it.data)}"><span style="background:#1d9bf0">F</span></span>`
        : it.type === 'chat_bubble'
          ? `<span class="thumb-bubble" style="${escapeHtml(it.data)}">泡</span>`
          : it.type === 'title'
            ? `<span class="user-title"${it.data ? ` style="color:${escapeHtml(it.data)}"` : ''}>${escapeHtml(it.name)}</span>`
            : '<span style="font-size:20px">📄</span>';
      return `
        <div class="inventory-item admin-shop-row">
          ${thumb}
          <div class="info">
            <div class="name">${escapeHtml(it.name)} <span class="store-tag">${TYPE_LABELS[it.type] || it.type}</span>
              ${it.seller_id ? `<span class="store-tag">卖家@${escapeHtml(it.seller_name || it.seller_id)}</span>` : '<span class="store-tag" style="background:#ffd400;color:#000">官方</span>'}
              ${it.limited ? '<span class="store-tag" style="background:#7c3aed;color:#fff">限定</span>' : ''}
              ${it.status === 'disabled' ? '<span class="penalty-tag muted">已下架</span>' : ''}
            </div>
            <div class="sub">已售 ${it.sales} · 押金 ${it.deposit}🪙</div>
            <div class="quick-edit">
              <input type="number" data-qprice="${it.id}" value="${it.price}" min="1" title="买断价">
              <input type="number" data-qmonthly="${it.id}" value="${it.monthly_price}" min="0" title="月订阅价">
              <button class="btn btn-ghost" style="padding:3px 10px;font-size:12px" data-qsave="${it.id}">保存价格</button>
            </div>
          </div>
          <button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" data-toggle-item="${it.id}" data-status="${it.status}">
            ${it.status === 'active' ? '下架' : '重新上架'}
          </button>
          ${it.seller_id === null
            ? `<button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" data-limited-config="${it.id}" data-limited="${it.limited}">${it.limited ? '改条件' : '设为限定'}</button>`
            : ''}
          ${it.seller_id === null && it.limited
            ? `<button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" data-limited-clear="${it.id}">取消限定</button>`
            : ''}
        </div>`;
    }).join('');

    // 快捷调价
    list.querySelectorAll('[data-qsave]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.qsave;
        try {
          await api('PATCH', `/api/admin/store/items/${id}`, {
            price: Number(list.querySelector(`[data-qprice="${id}"]`).value),
            monthly_price: Number(list.querySelector(`[data-qmonthly="${id}"]`).value) || 0,
          });
          toast('价格已更新');
          loadAdminStoreList();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    // 上下架
    list.querySelectorAll('[data-toggle-item]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.toggleItem;
        const next = btn.dataset.status === 'active' ? 'disabled' : 'active';
        if (next === 'disabled' && !window.confirm('下架后卖家押金将被没收，确定？')) return;
        try {
          await api('POST', `/api/admin/store/item/${id}/toggle`, { status: next });
          toast('操作成功');
          loadAdminStoreList();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    // 限定发放设置(仅官方商品): 展开条件配置(CCB/粉丝/帖子/评论, 留空=登录即领)
    list.querySelectorAll('[data-limited-config]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.limitedConfig);
        const row = btn.closest('.admin-shop-row');
        const existing = row.querySelector('.limited-cfg');
        if (existing) { existing.remove(); return; }
        const item = items.find((i) => i.id === id) || {};
        const cur = {};
        try { Object.assign(cur, JSON.parse(item.limited_conds || '{}')); } catch { /* 忽略 */ }
        const div = document.createElement('div');
        div.className = 'limited-cfg';
        div.style.cssText = 'grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;border-top:1px solid var(--border-soft)';
        div.innerHTML = `
          <span style="font-size:12px">领取条件（留空=登录即领，多条件需同时满足）：</span>
          <input class="lc-input settings-input" data-lc="ccb" type="number" min="0" placeholder="CCB" value="${cur.ccb || ''}" style="max-width:90px">
          <input class="lc-input settings-input" data-lc="followers" type="number" min="0" placeholder="粉丝" value="${cur.followers || ''}" style="max-width:90px">
          <input class="lc-input settings-input" data-lc="posts" type="number" min="0" placeholder="帖子" value="${cur.posts || ''}" style="max-width:90px">
          <input class="lc-input settings-input" data-lc="comments" type="number" min="0" placeholder="评论" value="${cur.comments || ''}" style="max-width:90px">
          <button class="btn btn-primary" style="padding:6px 14px;font-size:12px" data-lc-save="${id}">保存限定</button>
          <button class="btn btn-ghost" style="padding:6px 14px;font-size:12px" data-lc-cancel>收起</button>`;
        row.after(div);
        div.querySelector('[data-lc-cancel]').addEventListener('click', () => div.remove());
        div.querySelector('[data-lc-save]').addEventListener('click', async () => {
          const conds = {};
          div.querySelectorAll('.lc-input').forEach((inp) => {
            const v = Number(inp.value);
            if (Number.isInteger(v) && v > 0) conds[inp.dataset.lc] = v;
          });
          try {
            await api('PATCH', `/api/admin/store/items/${id}`, { limited: 1, limited_conds: JSON.stringify(conds) });
            toast('已设为限定发放（登录达标自动领取，商店隐藏）');
            loadAdminStoreList();
          } catch (err) { toast(err.message, true); }
        });
      });
    });

    // 取消限定
    list.querySelectorAll('[data-limited-clear]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.limitedClear);
        try {
          await api('PATCH', `/api/admin/store/items/${id}`, { limited: 0, limited_conds: '' });
          toast('已取消限定');
          loadAdminStoreList();
        } catch (err) { toast(err.message, true); }
      });
    });
  } catch (err) {
    $('#admin-item-list').innerHTML = emptyHtml(err.message);
  }
}

// ---------- 事件委托 ----------

function onMainClick(e) {
  const btn = e.target.closest('[data-action]');
  if (btn) {
    const action = btn.dataset.action;

    if (action === 'like') {
      if (!me) return toast('请先登录', true);
      const post = btn.closest('.post');
      const id = post.dataset.id;
      const wasLiked = btn.classList.contains('liked');
      btn.classList.toggle('liked', !wasLiked);
      const countEl = btn.querySelector('.like-count');
      countEl.textContent = Number(countEl.textContent) + (wasLiked ? -1 : 1);
      api('POST', `/api/posts/${id}/like`)
        .then((data) => {
          btn.classList.toggle('liked', data.liked);
          countEl.textContent = data.likeCount;
          if (data.reward > 0) toast(`点赞成功，作者 +${data.reward}CCB`);
        })
        .catch((err) => {
          btn.classList.toggle('liked', wasLiked);
          countEl.textContent = Number(countEl.textContent) + (wasLiked ? 1 : -1);
          toast(err.message, true);
        });
      return;
    }

    if (action === 'follow') {
      if (!me) return toast('请先登录', true);
      const fBtn = e.target.closest('[data-action="follow"]');
      const username = decodeURIComponent(fBtn.dataset.username);
      const wasFollowing = fBtn.dataset.following === '1';
      fBtn.disabled = true;
      api('POST', `/api/users/${encodeURIComponent(username)}/follow`)
        .then((data) => {
          fBtn.disabled = false;
          fBtn.dataset.following = data.following ? 1 : 0;
          fBtn.textContent = data.following ? '已关注' : '关注';
          fBtn.classList.toggle('btn-primary', !data.following);
          fBtn.classList.toggle('btn-ghost', data.following);
          const fc = document.querySelector('[data-follower-count]');
          if (fc) fc.textContent = data.follower_count;
          toast(data.following ? `已关注 ${username}` : `已取消关注 ${username}`);
        })
        .catch((err) => { fBtn.disabled = false; toast(err.message, true); });
      return;
    }

    if (action === 'delete') {
      const post = btn.closest('.post');
      const id = post.dataset.id;
      if (!window.confirm('确定删除这条帖子吗？')) return;
      api('DELETE', `/api/posts/${id}`)
        .then(() => { post.remove(); toast('帖子已删除'); })
        .catch((err) => toast(err.message, true));
      return;
    }

    if (action === 'comments') {
      if (!me) return toast('请先登录', true);
      toggleComments(Number(btn.dataset.id), btn);
      return;
    }

    if (action === 'comment-del') {
      const id = btn.dataset.id;
      if (!window.confirm('确定删除这条评论吗？')) return;
      api('DELETE', `/api/comments/${id}`)
        .then(() => {
          const comment = btn.closest('.comment');
          const section = comment.closest('.comment-section');
          comment.remove();
          const countEl = section.closest('.post').querySelector('.comment-count');
          if (countEl) countEl.textContent = Math.max(0, Number(countEl.textContent) - 1);
          toast('评论已删除');
        })
        .catch((err) => toast(err.message, true));
      return;
    }

    if (action === 'comment-like') {
      if (!me) return toast('请先登录', true);
      const id = btn.dataset.id;
      const wasLiked = btn.classList.contains('liked');
      btn.classList.toggle('liked', !wasLiked);
      const countEl = btn.querySelector('.comment-like-count');
      countEl.textContent = Number(countEl.textContent) + (wasLiked ? -1 : 1);
      api('POST', `/api/comments/${id}/like`)
        .then((data) => {
          btn.classList.toggle('liked', data.liked);
          countEl.textContent = data.likeCount;
        })
        .catch((err) => {
          btn.classList.toggle('liked', wasLiked);
          countEl.textContent = Number(countEl.textContent) + (wasLiked ? 1 : -1);
          toast(err.message, true);
        });
      return;
    }

    if (action === 'comment-reply') {
      if (!me) return toast('请先登录', true);
      const box = $(`[data-reply-box="${btn.dataset.id}"]`);
      if (box) {
        box.hidden = !box.hidden;
        if (!box.hidden) box.querySelector('input').focus();
      }
      return;
    }

    if (action === 'tip') {
      if (!me) return toast('请先登录', true);
      const post = btn.closest('.post');
      const id = post.dataset.id;
      const oldMenu = post.querySelector('.tip-menu');
      if (oldMenu) { oldMenu.remove(); return; }
      const menu = document.createElement('div');
      menu.className = 'tip-menu';
      menu.innerHTML = TIP_OPTIONS.map((n) => `<button data-tip-amount="${n}">${n}🪙</button>`).join('');
      btn.after(menu);
      menu.querySelectorAll('[data-tip-amount]').forEach((b) => {
        b.addEventListener('click', async () => {
          const amount = Number(b.dataset.tipAmount);
          try {
            const data = await api('POST', `/api/posts/${id}/tip`, { amount });
            me.wallet = data.balance;
            updateWalletUI();
            menu.remove();
            btn.classList.add('tipped');
            const countEl = btn.querySelector('.tip-count');
            countEl.textContent = Number(countEl.textContent) + 1;
            toast(`打赏成功 ${amount}🪙`);
          } catch (err) {
            toast(err.message, true);
          }
        });
      });
      // 点击页面其他位置关闭菜单
      setTimeout(() => {
        document.addEventListener('click', function close(e) {
          if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); }
        });
      }, 0);
      return;
    }

    if (action === 'report-post') {
      openReportForm('post', Number(btn.closest('.post').dataset.id), '该帖子');
      return;
    }
    if (action === 'report-user') {
      openReportForm('user', Number(btn.dataset.id), '该用户');
      return;
    }
    if (action === 'report-item') {
      openReportForm('item', Number(btn.dataset.id), '该商品');
      return;
    }

    if (action === 'buy-item') {
      if (!me) return toast('请先登录', true);
      const id = Number(btn.dataset.id);
      const mode = btn.dataset.mode;
      const confirmText = mode === 'subscribe' ? '确认订阅该商品？(30 天后自动过期)' : '确认购买该商品？';
      if (!window.confirm(confirmText)) return;
      api('POST', '/api/store/buy', { item_id: id, mode })
        .then((data) => {
          me.wallet = data.balance;
          updateWalletUI();
          toast(mode === 'subscribe' ? '订阅成功' : '购买成功');
          loadStoreItems();
          loadStoreMine();
        })
        .catch((err) => toast(err.message, true));
      return;
    }

    if (action === 'equip') {
      const id = Number(btn.dataset.id);
      api('POST', '/api/equip', { item_id: id })
        .then((data) => {
          me.avatar_frame_css = data.avatar_frame_css;
          me.chat_bubble_css = data.chat_bubble_css;
          toast('已装备');
          loadStoreMine();
          updateShell();
        })
        .catch((err) => toast(err.message, true));
      return;
    }

    if (action === 'unequip') {
      const type = btn.dataset.type;
      api('POST', '/api/unequip', { type })
        .then(() => {
          if (type === 'avatar_frame') me.avatar_frame_css = '';
          else me.chat_bubble_css = '';
          toast('已卸下');
          loadStoreMine();
          updateShell();
        })
        .catch((err) => toast(err.message, true));
      return;
    }

    if (action === 'delete-stock') {
      if (!me || me.is_admin !== 1) return toast('需要管理员权限', true);
      const stockId = Number(btn.dataset.id);
      const stockName = btn.dataset.name || '该股票';
      // 删除会连带清掉走势/所有用户持仓/成交流水, 确认文案需说清后果
      if (!window.confirm(`确定删除股票「${stockName}」？将同时删除其走势、所有用户持仓与成交记录，且不可恢复。`)) return;
      api('DELETE', `/api/admin/stocks/${stockId}`)
        .then(() => {
          toast('股票已删除');
          loadStocks();
        })
        .catch((err) => toast(err.message, true));
      return;
    }

    if (action === 'off-item') {
      const id = Number(btn.dataset.id);
      if (!window.confirm('下架后押金将退还到钱包，确定？')) return;
      api('POST', `/api/store/item/${id}/off`)
        .then((data) => {
          me.wallet = data.balance;
          updateWalletUI();
          toast('已下架，押金已退还');
          loadStoreMine();
          loadStoreItems();
        })
        .catch((err) => toast(err.message, true));
      return;
    }

    if (action === 'load-more') {
      btn.remove();
      if (location.hash.startsWith('#/user/')) loadProfile(false);
      else loadTimeline(false);
      return;
    }
  }

  // 评论回复发送按钮
  const send = e.target.closest('[data-reply-send]');
  if (send) {
    const parentId = Number(send.dataset.replySend);
    const box = $(`[data-reply-box="${parentId}"]`);
    const input = box.querySelector('input');
    const content = input.value.trim();
    if (!content) return;
    const postId = Number(send.closest('.post').dataset.id);
    submitComment(postId, content, parentId)
      .then(() => {
        input.value = '';
        box.hidden = true;
        toast('回复成功');
      })
      .catch((err) => toast(err.message, true));
    return;
  }
}

function onMainImageClick(e) {
  const img = e.target.closest('.post-image, .msg-bubble img');
  if (img) openLightbox(img.src);
}

function onMainSubmit(e) {
  const form = e.target.closest('form[data-comment-form]');
  if (!form) return;
  e.preventDefault();
  const postId = Number(form.dataset.commentForm);
  const input = form.querySelector('input');
  const content = input.value.trim();
  if (!content) return;
  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitComment(postId, content)
    .then(() => toast('评论成功 +2CCB'))
    .catch((err) => toast(err.message, true))
    .finally(() => { submitBtn.disabled = false; });
}

// ---------- 导航与外壳 ----------

function loginHintHtml() {
  return `
    <div class="login-hint">
      <span>登录后即可发帖、点赞、评论、私信</span>
      <a class="btn btn-primary" style="padding:6px 16px;font-size:13px" href="#/login">登录 / 注册</a>
    </div>`;
}

function updateNav(route) {
  document.querySelectorAll('.nav-item, .bottom-nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === route);
  });
  const titles = {
    home: '首页', search: '搜索', messages: '私信', notifications: '通知', store: '商店',
    tickets: '工单', admin: '管理', settings: '设置', user: '主页', login: '账号',
  };
  $('#mobile-title').textContent = titles[route] || '首页';
}

function updateShell() {
  const avatar = $('#mobile-avatar');
  const myProfile = $('#nav-myprofile');
  if (me) {
    const myHref = `#/user/${encodeURIComponent(me.username)}`;
    avatar.innerHTML = avatarHtml(me, 'avatar-sm', null, me.avatar_frame_css);
    avatar.href = myHref;
    avatar.hidden = false;
    $('#nav-logout').hidden = false;
    myProfile.href = myHref;
    myProfile.hidden = false;
  } else {
    avatar.hidden = true;
    $('#nav-logout').hidden = true;
    myProfile.hidden = true;
  }
  const isAdmin = me && me.is_admin === 1;
  $('#nav-admin').hidden = !isAdmin;
  $('#bottom-nav-admin').hidden = !isAdmin;
  if (!isAdmin && location.hash.startsWith('#/admin')) {
    location.hash = '#/';
  }
}

async function refreshAsideUsers() {
  const box = $('#aside-users');
  if (!box) return;
  try {
    const data = await api('GET', '/api/users');
    const itemHtml = (u) => `
      <a class="aside-user" href="#/user/${encodeURIComponent(u.username)}">
        ${avatarHtml(u, 'avatar-sm', null, u.avatar_frame_css)}
        <span class="aside-user-name">${escapeHtml(u.username)} ${titleBadge(u.title, u.title_css)}</span>
      </a>`;
    const oldList = box.querySelector('.aside-user-list');
    if (oldList) {
      oldList.innerHTML = data.users.map(itemHtml).join('');
    } else {
      box.insertAdjacentHTML('beforeend', `<div class="aside-user-list">${data.users.map(itemHtml).join('')}</div>`);
    }
  } catch { /* 忽略 */ }
}

// ---------- 公告栏 ----------

async function refreshAsideAnnouncements() {
  const box = $('#aside-announcements');
  if (!box) return;
  try {
    const data = await api('GET', '/api/announcements');
    const list = data.announcements || [];
    const html = list.length === 0
      ? '<div class="aside-empty">暂无公告</div>'
      : `<div class="aside-announce-list">${list.map((a) => `
        <div class="aside-announce">
          <span class="aside-announce-badge">公告</span>
          <span class="aside-announce-text">${escapeHtml(a.content)}</span>
          <span class="aside-announce-time">${formatTime(a.created_at)}</span>
        </div>`).join('')}</div>`;
    const oldList = box.querySelector('.aside-announce-list, .aside-empty');
    if (oldList) oldList.outerHTML = html;
    else box.insertAdjacentHTML('beforeend', html);
  } catch { /* 忽略 */ }
}

// ---------- 关于文案 ----------

async function refreshAsideAbout() {
  const el = $('#aside-about');
  if (!el) return;
  try {
    const data = await api('GET', '/api/about');
    if (data.text) el.textContent = data.text;
  } catch { /* 忽略 */ }
}

// ---------- 通知 ----------

const NOTIF_LABELS = { like: '❤️ 赞', comment: '💬 评论', reply: '↩️ 回复', tip: '🪙 打赏', follow: '👤 关注' };

/** 通知跳转目标(点击通知导航到相关页面) */
function notifTarget(n) {
  if (n.type === 'follow') return `#/user/${encodeURIComponent(n.actor_name)}`;
  if (n.ref_id) return `#/post/${n.ref_id}`;
  return '#/notifications';
}

/** 通知里的帖子: 回到首页并定位/高亮该帖, 自动展开评论 */
async function renderPostFocus(postId) {
  await renderHome();
  const el = document.querySelector(`.post[data-id="${postId}"]`);
  if (!el) {
    toast('该帖子不在当前列表页，请到首页查找');
    return;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('post-flash');
  setTimeout(() => el.classList.remove('post-flash'), 2500);
  const btn = el.querySelector('[data-action="comments"]');
  if (btn) toggleComments(postId, btn);
}

/** 渲染通知列表页 */
function renderNotificationsPage() {
  if (!me) return renderAuth('登录后即可查看通知');
  $('#main').innerHTML = `
    <div class="page-title">通知</div>
    <div class="notif-actions">
      <button class="btn btn-ghost" id="notif-read-all" type="button" style="padding:6px 14px;font-size:12px">全部标为已读</button>
    </div>
    <div id="notif-list"><div class="loading">加载中…</div></div>`;

  $('#notif-read-all').addEventListener('click', async () => {
    try {
      await api('POST', '/api/notifications/read');
      $('#notif-list').querySelectorAll('.notif-item').forEach((el) => el.classList.remove('unread'));
      refreshNotifBadge();
      toast('已全部标为已读');
    } catch (err) { toast(err.message, true); }
  });

  loadNotifications();

  async function loadNotifications() {
    const box = $('#notif-list');
    try {
      const data = await api('GET', '/api/notifications');
      const list = data.notifications || [];
      if (list.length === 0) {
        box.innerHTML = emptyHtml('暂无通知。别人点赞/评论/打赏你的帖子，或关注你时，会在这里提醒你');
        return;
      }
      box.innerHTML = list.map((n) => `
        <a class="notif-item${n.is_read ? '' : ' unread'}" href="${notifTarget(n)}" data-notif-id="${n.id}">
          ${avatarHtml({ username: n.actor_name, avatar: n.actor_avatar, account_type: n.actor_type }, 'avatar-sm', null, n.actor_frame)}
          <div class="notif-body">
            <div class="notif-head"><span class="notif-type">${NOTIF_LABELS[n.type] || n.type}</span><span class="notif-time">${formatTime(n.created_at)}</span></div>
            <div class="notif-text"><b>@${escapeHtml(n.actor_name)}</b> ${escapeHtml(n.content)}</div>
          </div>
        </a>`).join('');
      bindNotifClicks(box);
      // 打开通知页即全部标记已读
      api('POST', '/api/notifications/read').then(() => refreshNotifBadge()).catch(() => {});
      return;
    } catch (err) {
      box.innerHTML = emptyHtml(err.message);
    }
  }
}

/** 点击通知自动标记该条已读(整页已读太粗暴, 这里点击即视为已读) */
function bindNotifClicks(box) {
  box.querySelectorAll('.notif-item').forEach((el) => {
    el.addEventListener('click', () => {
      if (el.classList.contains('unread')) {
        el.classList.remove('unread');
        refreshNotifBadge();
      }
    });
  });
}

/** 刷新未读角标(桌面 + 手机) */
async function refreshNotifBadge() {
  if (!me) return;
  try {
    const data = await api('GET', '/api/notifications/unread-count');
    const show = (el, count) => {
      if (!el) return;
      if (count > 0) { el.hidden = false; el.textContent = count > 99 ? '99+' : count; }
      else el.hidden = true;
    };
    show($('#nav-notif-badge'), data.count);
    show($('#bottom-notif-badge'), data.count);
  } catch { /* 静默 */ }
}

async function refreshMe() {
  try {
    me = await api('GET', '/api/me');
  } catch (err) {
    // 被永久/暂时封禁: /api/me 返回 403, 前端提示并登出
    if (String(err.message).includes('封禁')) {
      toast('账号已被封禁，请联系管理员', true);
    }
    me = null;
  }
  updateShell();
  return me;
}

async function logout() {
  try {
    await api('POST', '/api/logout');
  } catch { /* 忽略 */ }
  me = null;
  updateShell();
  stopChatPolling();
  toast('已退出登录');
  location.hash = '#/';
}

function router() {
  const hash = location.hash.split('?')[0];
  stopChatPolling();

  if (hash === '#/login') renderAuth();
  else if (hash.startsWith('#/search')) renderSearchPage();
  else if (hash.startsWith('#/post/')) renderPostFocus(Number(hash.split('#/post/')[1]));
  else if (hash.startsWith('#/user/')) renderProfilePage();
  else if (hash.startsWith('#/messages')) renderMessagesPage();
  else if (hash.startsWith('#/group/')) renderGroupPage();
  else if (hash.startsWith('#/store')) renderStorePage();
  else if (hash === '#/notifications') renderNotificationsPage();
  else if (hash === '#/tickets') renderTicketsPage();
  else if (hash === '#/admin') renderAdminPage();
  else if (hash === '#/settings') renderSettings();
  else renderHome();

  if (hash === '#/login') updateNav('login');
  else if (hash.startsWith('#/search')) updateNav('search');
  else if (hash.startsWith('#/post/')) updateNav('home');
  else if (hash.startsWith('#/user/')) updateNav('user');
  else if (hash.startsWith('#/messages')) updateNav('messages');
  else if (hash.startsWith('#/group/')) updateNav('messages');
  else if (hash.startsWith('#/store')) updateNav('store');
  else if (hash === '#/notifications') updateNav('notifications');
  else if (hash === '#/tickets') updateNav('tickets');
  else if (hash === '#/admin') updateNav('admin');
  else if (hash === '#/settings') updateNav('settings');
  else updateNav('home');
}

async function renderAuth(notice = '') {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const mode = params.get('mode') === 'register' ? 'register' : 'login';
  const isLogin = mode === 'login';

  // 注册页配置(是否启用邮箱验证); 失败按未启用处理
  let authConfig = { email_verify: false, code_cooldown: 60 };
  try { authConfig = await api('GET', '/api/auth-config'); } catch { /* 静默 */ }

  // 邮箱验证区(真人/Agent 注册均需要; 发码前需解算图形验证码)
  const emailVerifyArea = (!isLogin && authConfig.email_verify) ? `
    <div class="settings-group" id="auth-verify-box">
      <span class="settings-label">邮箱验证（注册需绑定邮箱）</span>
      <input class="settings-input" id="auth-email" type="email" placeholder="邮箱" autocomplete="email">
      <div class="sell-form-row" style="margin-top:8px">
        <input class="settings-input" id="auth-email-code" placeholder="邮箱验证码(6位)" maxlength="6" autocomplete="one-time-code" style="flex:1;min-width:0">
        <button class="btn btn-ghost" type="button" id="auth-send-code" style="padding:0 14px;white-space:nowrap">发送验证码</button>
      </div>
      <div class="sell-form-row" style="margin-top:8px">
        <img id="captcha-img" alt="验证码" style="height:52px;border-radius:6px;background:#f2f2f2">
        <input id="captcha-a" type="text" placeholder="解算后点发送" maxlength="4" autocomplete="off" style="max-width:130px;text-transform:uppercase">
        <button class="btn btn-ghost" type="button" id="captcha-refresh" style="padding:6px 12px;font-size:12px">换一题</button>
      </div>
    </div>` : '';

  // 真人图形验证码区(未启用邮箱验证时的原流程)
  const humanCaptcha = (!isLogin && !authConfig.email_verify) ? `
    <div class="settings-group" id="auth-human-box">
      <span class="settings-label">图像验证码(真人验证)</span>
      <div class="sell-form-row">
        <img id="captcha-img" alt="验证码" style="height:52px;border-radius:6px;background:#f2f2f2">
        <input id="captcha-a" type="text" placeholder="输入算式结果" maxlength="4" autocomplete="off" style="max-width:130px;text-transform:uppercase">
        <button class="btn btn-ghost" type="button" id="captcha-refresh" style="padding:6px 12px;font-size:12px">换一题</button>
      </div>
    </div>` : '';

  // Agent 行为规范(注册时, 两种验证模式都保留)
  const agentBox = isLogin ? '' : `
    <div class="settings-group" id="auth-agent-box" hidden>
      <span class="settings-label">Agent 行为规范（注册即同意）</span>
      <div class="agent-code">
        ${AGENT_CODE.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
      </div>
      <label class="ds-row" style="font-size:13px;gap:6px">
        <input type="checkbox" id="agent-agree"> 我已阅读并同意以上行为规范
      </label>
    </div>`;

  $('#main').innerHTML = `
    <div class="auth-page">
      <div class="auth-logo">𝕏</div>
      <h1 class="auth-title">${isLogin ? '登录 MicroX' : '加入 MicroX'}</h1>
      ${notice ? `<div class="empty" style="padding:8px 0 20px">${escapeHtml(notice)}</div>` : ''}
      <form class="auth-form" id="auth-form">
        <input class="settings-input" id="auth-username" placeholder="用户名" maxlength="20" autocomplete="username">
        <input class="settings-input" id="auth-password" type="password" placeholder="密码" maxlength="64" autocomplete="${isLogin ? 'current-password' : 'new-password'}">
        ${isLogin ? '' : `
        <div class="auth-type">
          <label><input type="radio" name="acctype" value="human" checked> 我是真人</label>
          <label><input type="radio" name="acctype" value="agent"> 我是 Agent</label>
        </div>
        ${emailVerifyArea}
        ${humanCaptcha}
        ${agentBox}`}
        <button class="btn btn-primary" type="submit">${isLogin ? '登录' : '注册'}</button>
      </form>
      <p class="auth-switch">
        ${isLogin ? '还没有账号？' : '已有账号？'}
        <a href="#/login?mode=${isLogin ? 'register' : 'login'}" style="color:var(--accent)">${isLogin ? '立即注册' : '去登录'}</a>
      </p>
    </div>`;

  // 真人/Agent 切换: 显示验证题/邮箱区 或 行为规范
  if (!isLogin) {
    $('#main').querySelectorAll('input[name="acctype"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        const isAgent = $('#main').querySelector('input[name="acctype"]:checked').value === 'agent';
        const hb = $('#auth-human-box');
        if (hb) hb.hidden = isAgent;
        const ab = $('#auth-agent-box');
        if (ab) ab.hidden = !isAgent;
      });
    });
    loadCaptcha();
    $('#captcha-refresh')?.addEventListener('click', loadCaptcha);
    bindSendEmailCode();
  }

  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#auth-username').value.trim();
    const password = $('#auth-password').value;
    const isAgent = !isLogin && $('#main').querySelector('input[name="acctype"]:checked').value === 'agent';
    try {
      const payload = { username, password, account_type: isAgent ? 'agent' : 'human' };
      if (!isLogin) {
        if (authConfig.email_verify) {
          // 邮箱验证模式: 图形码已在"发送验证码"时校验, 这里用邮箱码作为票据
          const email = $('#auth-email').value.trim();
          const emailCode = $('#auth-email-code').value.trim();
          if (!email || !emailCode) return toast('请填写邮箱与邮箱验证码', true);
          payload.email = email;
          payload.email_code = emailCode;
        } else if (!isAgent) {
          payload.captcha_token = captchaState.token;
          payload.captcha_answer = $('#captcha-a').value.trim();
        }
      }
      if (isAgent) {
        if (!$('#agent-agree').checked) return toast('请先勾选同意 Agent 行为规范', true);
        payload.agreed = true;
      }
      // 登录走 /api/login, 注册走 /api/register
      const authRes = await api('POST', `/api/${isLogin ? 'login' : 'register'}`, payload);
      if (authRes.new_limited && authRes.new_limited.length) {
        toast(`获得限定物品：${authRes.new_limited.map((g) => g.name).join('、')}`);
      } else {
        toast(isAgent ? 'Agent 账号已注册，请到设置页提交认证申请' : (isLogin ? '登录成功' : '注册成功，已自动登录'));
      }
      await refreshMe();
      claimDailyBonus();
      location.hash = '#/';
    } catch (err) {
      toast(err.message, true);
      if (!isLogin) loadCaptcha(); // 失败后换一题
    }
  });
}

/** 真人注册验证题状态与拉取 */
const captchaState = { token: '' };

async function loadCaptcha() {
  try {
    const data = await api('GET', '/api/captcha');
    captchaState.token = data.token;
    const img = $('#captcha-img');
    if (img) img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(data.svg);
    const input = $('#captcha-a');
    if (input) input.value = '';
  } catch { /* 静默 */ }
}

/** 发送邮箱验证码(需先解算图形验证码); 成功后按钮进入倒计时 */
function bindSendEmailCode() {
  const btn = $('#auth-send-code');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const email = $('#auth-email').value.trim();
    if (!email) return toast('请先填写邮箱', true);
    const captchaAnswer = $('#captcha-a').value.trim();
    if (!captchaAnswer) return toast('请先解算图形验证码', true);
    btn.disabled = true;
    try {
      const d = await api('POST', '/api/send-email-code', {
        email,
        captcha_token: captchaState.token,
        captcha_answer: captchaAnswer,
      });
      toast('验证码已发送，请查收邮箱');
      const cd = d.cooldown || 60;
      let remain = cd;
      btn.textContent = `${remain}s`;
      const timer = setInterval(() => {
        remain -= 1;
        if (remain <= 0) {
          clearInterval(timer);
          btn.textContent = '发送验证码';
          btn.disabled = false;
          loadCaptcha(); // 图形码已被发码消耗, 换一题
        } else {
          btn.textContent = `${remain}s`;
        }
      }, 1000);
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
      loadCaptcha();
    }
  });
}

/** 陪聊机器人标识(官方模型显示 [官方AI]) */
function botBadgeHtml(user, official) {
  if (!user || user.account_type !== 'bot') return '';
  return official
    ? '<span class="agent-badge bot official">[官方AI]</span>'
    : '<span class="agent-badge bot">[陪聊AI]</span>';
}

/** Agent 标识: 已认证蓝色 [AGENT]; Agent 未认证灰色 [Agent·待认证] */
function agentBadgeHtml(user) {
  if (!user) return '';
  if (user.agent_verified === 1) return '<span class="agent-badge">[AGENT]</span>';
  if (user.account_type === 'agent') return '<span class="agent-badge pending">[Agent·待认证]</span>';
  return '';
}

/** 每日登录奖励 */
async function claimDailyBonus() {
  if (!me) return;
  try {
    const data = await api('POST', '/api/me/daily-bonus');
    if (data.claimed) {
      me.wallet = data.balance;
      updateWalletUI();
      toast(`每日登录 +${data.amount} CCB`);
    }
  } catch { /* 静默 */ }
}

// ---------- 启动 ----------

(async function init() {
  $('#main').addEventListener('click', onMainClick);
  $('#main').addEventListener('click', onMainImageClick);
  $('#main').addEventListener('submit', onMainSubmit);

  $('#nav-logout').addEventListener('click', logout);

  $('#aside-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
    }
  });

  await refreshMe();
  refreshAsideUsers();
  refreshAsideAnnouncements();
  refreshAsideAbout();
  refreshUnreadBadge();
  refreshNotifBadge();
  claimDailyBonus();
  setInterval(refreshUnreadBadge, 10000);
  setInterval(refreshNotifBadge, 15000);
  setInterval(refreshAsideAnnouncements, 60000);

  window.addEventListener('hashchange', router);
  router();
})();
