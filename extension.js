const vscode = require('vscode');

const UA = 'Mozilla/5.0 (rss-grid VS Code extension)';
const FETCH_TIMEOUT_MS = 15000;
const OG_CONCURRENCY = 6;
const OG_CACHE_MAX = 3000;

let panel = null;
let timer = null;
let lastData = null; // { fetchedAt, feeds: [{label, url, category, ok, items}] }
let refreshing = false;

function activate(context) {
  lastData = context.globalState.get('rssGrid.cache', null);

  context.subscriptions.push(
    vscode.commands.registerCommand('rssGrid.open', () => openPanel(context)),
    vscode.commands.registerCommand('rssGrid.refresh', () => refresh(context)),
    vscode.commands.registerCommand('rssGrid.addFeed', () => addFeed(context)),
    vscode.commands.registerCommand('rssGrid.editFeeds', () =>
      vscode.commands.executeCommand('workbench.action.openSettingsJson', { revealSetting: { key: 'rssGrid.feeds' } })),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('rssGrid.autoRefreshMinutes')) setupTimer(context);
      if (e.affectsConfiguration('rssGrid.feeds') && panel) refresh(context);
    }),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(rss) RSS';
  status.tooltip = 'RSS Grid を開く';
  status.command = 'rssGrid.open';
  status.show();
  context.subscriptions.push(status);

  setupTimer(context);
}

function deactivate() {
  if (timer) clearInterval(timer);
}

function cfg() {
  return vscode.workspace.getConfiguration('rssGrid');
}

function setupTimer(context) {
  if (timer) clearInterval(timer);
  timer = null;
  const min = cfg().get('autoRefreshMinutes', 15);
  // パネルが開いてる時だけ取りに行く(閉じてる間は無駄に叩かない)
  if (min > 0) timer = setInterval(() => { if (panel) refresh(context); }, min * 60 * 1000);
}

// ---------- パネル ----------

function openPanel(context) {
  if (panel) { panel.reveal(); return; }
  panel = vscode.window.createWebviewPanel('rssGrid', 'RSS Grid', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.iconPath = new vscode.ThemeIcon('rss');
  panel.webview.html = getHtml(panel.webview);
  panel.onDidDispose(() => { panel = null; });
  panel.webview.onDidReceiveMessage(msg => {
    if (msg.type === 'ready') {
      if (lastData) post({ type: 'data', data: lastData });
      // キャッシュが古ければ即更新
      const min = cfg().get('autoRefreshMinutes', 15) || 15;
      if (!lastData || Date.now() - lastData.fetchedAt > min * 60 * 1000) refresh(context);
    } else if (msg.type === 'refresh') refresh(context);
    else if (msg.type === 'open' && /^https?:\/\//.test(msg.url)) vscode.env.openExternal(vscode.Uri.parse(msg.url));
    else if (msg.type === 'addFeed') addFeed(context);
    else if (msg.type === 'editFeeds') vscode.commands.executeCommand('rssGrid.editFeeds');
  });
}

function post(msg) {
  if (panel) panel.webview.postMessage(msg);
}

async function addFeed(context) {
  const url = await vscode.window.showInputBox({ prompt: 'RSS/AtomフィードのURL', placeHolder: 'https://example.com/feed' });
  if (!url) return;
  const label = await vscode.window.showInputBox({ prompt: '表示名', value: new URL(url).hostname }) ?? '';
  const cats = [...new Set(cfg().get('feeds', []).map(f => f.category || 'その他'))];
  const pick = await vscode.window.showQuickPick([...cats, '＋ 新しいカテゴリ…'], { placeHolder: 'カテゴリ' });
  if (!pick) return;
  let category = pick;
  if (pick.startsWith('＋')) {
    category = await vscode.window.showInputBox({ prompt: '新しいカテゴリ名' });
    if (!category) return;
  }
  const feeds = [...cfg().get('feeds', []), { label: label || url, url, category }];
  await cfg().update('feeds', feeds, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`「${label || url}」を追加したわ`);
  openPanel(context);
}

// ---------- 取得 ----------

async function refresh(context) {
  if (refreshing) return;
  refreshing = true;
  post({ type: 'loading', value: true });
  try {
    const feeds = cfg().get('feeds', []);
    const max = cfg().get('itemsPerFeed', 20);
    const results = await Promise.all(feeds.map(f => fetchFeed(f, max)));
    lastData = { fetchedAt: Date.now(), feeds: results };
    post({ type: 'data', data: lastData });

    if (cfg().get('fetchOgImage', true)) {
      await fillOgImages(context, results);
      post({ type: 'data', data: lastData });
    }
    await context.globalState.update('rssGrid.cache', lastData);
  } catch (e) {
    console.error('[rss-grid] refresh failed', e);
  } finally {
    refreshing = false;
    post({ type: 'loading', value: false });
  }
}

async function httpGet(url, maxBytes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let buf = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buf.length > maxBytes) buf = buf.subarray(0, maxBytes);
    return decode(buf, res.headers.get('content-type') || '');
  } finally {
    clearTimeout(t);
  }
}

function decode(buf, contentType) {
  const head = buf.subarray(0, 1024).toString('latin1');
  const m = /charset=["']?([\w-]+)/i.exec(contentType) || /encoding=["']([\w-]+)/i.exec(head) || /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  const enc = (m ? m[1] : 'utf-8').toLowerCase();
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

// 1フィードの失敗は握りつぶして空で返す(全体を巻き込まない)
async function fetchFeed(feed, max) {
  const base = { label: feed.label || feed.url, url: feed.url, category: feed.category || 'その他' };
  try {
    const xml = await httpGet(feed.url);
    const items = parseFeed(xml, feed.url).slice(0, max);
    return { ...base, ok: true, items };
  } catch (e) {
    console.warn(`[rss-grid] ${feed.url}: ${e.message}`);
    return { ...base, ok: false, error: String(e.message || e), items: [] };
  }
}

// ---------- パース (RSS 2.0 / RSS 1.0(RDF) / Atom) ----------

function parseFeed(xml, feedUrl) {
  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const blockRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const blocks = xml.match(blockRe) || [];
  return blocks.map(b => parseItem(b, isAtom, feedUrl)).filter(it => it.title && it.link);
}

function tag(block, names) {
  for (const n of names) {
    const re = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${n}>`, 'i');
    const m = re.exec(block);
    if (m) return unCdata(m[1]).trim();
  }
  return '';
}

function attr(block, tagName, attrName, filter) {
  const re = new RegExp(`<${tagName}\\b[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(block))) {
    if (filter && !filter(m[0])) continue;
    const a = new RegExp(`\\s${attrName}=["']([^"']+)["']`, 'i').exec(m[0]);
    if (a) return decodeEntities(a[1]);
  }
  return '';
}

function unCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s) {
  return decodeEntities(s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absUrl(u, base) {
  if (!u) return '';
  try { return new URL(u, base).href; } catch { return ''; }
}

function parseItem(b, isAtom, feedUrl) {
  const title = stripHtml(decodeEntities(tag(b, ['title'])));
  let link = isAtom
    ? attr(b, 'link', 'href', t => !/rel=["'](?!alternate)/i.test(t))
    : decodeEntities(tag(b, ['link'])) || attr(b, 'item', 'rdf:about');
  link = absUrl(link.trim(), feedUrl);

  const dateStr = tag(b, ['pubDate', 'dc:date', 'published', 'updated']);
  const ts = Date.parse(dateStr);

  const bodyRaw = tag(b, ['content:encoded', 'content', 'description', 'summary']);
  const body = decodeEntities(bodyRaw); // エスケープされたHTMLを戻す
  const summaryRaw = tag(b, ['description', 'summary']) || bodyRaw;
  const summary = stripHtml(decodeEntities(summaryRaw)).slice(0, 200);

  const image =
    attr(b, 'media:thumbnail', 'url') ||
    attr(b, 'media:content', 'url', t => !/medium=["'](?!image)/i.test(t)) ||
    attr(b, 'enclosure', 'url', t => /type=["']image/i.test(t) || /\.(jpe?g|png|gif|webp)/i.test(t)) ||
    (/<img[^>]+src=["']([^"']+)["']/i.exec(body) || [])[1] ||
    stripHtml(tag(b, ['image', 'hatena:imageurl'])) ||
    '';

  return {
    title,
    link,
    summary,
    date: isNaN(ts) ? 0 : ts,
    image: absUrl(decodeEntities(image), link || feedUrl),
  };
}

// ---------- og:image 補完 ----------

async function fillOgImages(context, feeds) {
  const cache = context.globalState.get('rssGrid.ogCache', {});
  const targets = [];
  for (const f of feeds) for (const it of f.items) {
    if (it.image) continue;
    if (it.link in cache) it.image = cache[it.link];
    else targets.push(it);
  }

  let i = 0;
  const worker = async () => {
    while (i < targets.length) {
      const it = targets[i++];
      try {
        const html = await httpGet(it.link, 200 * 1024);
        const m = /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i.exec(html);
        const c = m && /content=["']([^"']+)["']/i.exec(m[0]);
        it.image = c ? absUrl(decodeEntities(c[1]), it.link) : '';
      } catch {
        it.image = '';
      }
      cache[it.link] = it.image;
    }
  };
  await Promise.all(Array.from({ length: OG_CONCURRENCY }, worker));

  // キャッシュが膨らみすぎないよう古いものから捨てる
  const keys = Object.keys(cache);
  if (keys.length > OG_CACHE_MAX) for (const k of keys.slice(0, keys.length - OG_CACHE_MAX)) delete cache[k];
  await context.globalState.update('rssGrid.ogCache', cache);
}

// ---------- Webview ----------

function getHtml(webview) {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { --gap: 14px; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  header { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 16px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border); }
  header h1 { font-size: 15px; letter-spacing: .15em; margin: 0 12px 0 0; font-weight: 600; }
  .tabs { display: flex; gap: 4px; flex-wrap: wrap; flex: 1; }
  .tab { border: 1px solid transparent; background: none; color: var(--vscode-foreground); padding: 4px 10px; cursor: pointer; border-radius: 3px; font-size: 12px; opacity: .75; }
  .tab:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .tab.active { opacity: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tools { display: flex; gap: 6px; align-items: center; }
  .tools input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; width: 150px; }
  .btn { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; cursor: pointer; border-radius: 2px; font-size: 12px; }
  .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .meta { font-size: 11px; opacity: .6; padding: 6px 16px; }
  .spin { display: none; width: 12px; height: 12px; border: 2px solid var(--vscode-foreground); border-top-color: transparent; border-radius: 50%; animation: s 0.8s linear infinite; }
  .loading .spin { display: inline-block; }
  @keyframes s { to { transform: rotate(360deg); } }
  .errors { font-size: 11px; color: var(--vscode-errorForeground); padding: 0 16px 6px; }

  .grid { column-width: 260px; column-gap: var(--gap); padding: 4px 16px 24px; }
  .card { break-inside: avoid; margin-bottom: var(--gap); background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border: 1px solid var(--vscode-panel-border); cursor: pointer; display: block; overflow: hidden; transition: transform .12s, box-shadow .12s; }
  .card:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .card .img { width: 100%; aspect-ratio: 16/10; object-fit: cover; display: block; background: var(--vscode-editor-inactiveSelectionBackground); opacity: 0; transition: opacity .25s; }
  .card .img.ok { opacity: 1; }
  .card.feature .img { aspect-ratio: 4/3; }
  .card .body { padding: 10px 12px 0; }
  .card h2 { font-size: 13px; line-height: 1.45; margin: 0 0 6px; font-weight: 600; }
  .card.feature h2 { font-size: 15px; }
  .card p { font-size: 11.5px; line-height: 1.55; opacity: .7; margin: 0 0 8px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card .foot { display: flex; justify-content: space-between; align-items: stretch; font-size: 10.5px; border-top: 1px solid var(--vscode-panel-border); }
  .card .src { padding: 6px 12px; opacity: .6; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .card .more { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 6px 12px; white-space: nowrap; }
  .card .new { color: var(--vscode-charts-orange, orange); font-weight: bold; margin-right: 4px; }
  .empty { padding: 40px; text-align: center; opacity: .6; }
</style>
</head>
<body>
<header id="hdr">
  <h1>RSS GRID</h1>
  <nav class="tabs" id="tabs"></nav>
  <div class="tools">
    <input id="q" type="search" placeholder="絞り込み…">
    <span class="spin"></span>
    <button class="btn" id="refresh" title="今すぐ更新">⟳ 更新</button>
    <button class="btn" id="add" title="フィードを追加">＋</button>
    <button class="btn" id="edit" title="settings.jsonでフィード編集">⚙</button>
  </div>
</header>
<div class="meta" id="meta"></div>
<div class="errors" id="errors"></div>
<main class="grid" id="grid"><div class="empty">読み込み中…</div></main>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { tab: 'すべて', q: '' };
  let data = null;
  const $ = id => document.getElementById(id);
  $('q').value = state.q;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = ts => {
    if (!ts) return '';
    const diff = (Date.now() - ts) / 60000;
    if (diff < 60) return Math.max(1, Math.round(diff)) + '分前';
    if (diff < 60 * 24) return Math.round(diff / 60) + '時間前';
    const d = new Date(ts);
    return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  };
  const save = () => vscode.setState(state);

  function render() {
    if (!data) return;
    const cats = ['すべて', ...new Set(data.feeds.map(f => f.category))];
    if (!cats.includes(state.tab)) state.tab = 'すべて';
    $('tabs').innerHTML = cats.map(c => '<button class="tab' + (c === state.tab ? ' active' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>').join('');

    const feeds = data.feeds.filter(f => state.tab === 'すべて' || f.category === state.tab);
    const q = state.q.trim().toLowerCase();
    const seen = new Set();
    const items = [];
    for (const f of feeds) for (const it of f.items) {
      if (seen.has(it.link)) continue;
      seen.add(it.link);
      if (q && !(it.title + ' ' + it.summary + ' ' + f.label).toLowerCase().includes(q)) continue;
      items.push({ ...it, source: f.label });
    }
    items.sort((a, b) => b.date - a.date);

    const errs = feeds.filter(f => !f.ok);
    $('errors').textContent = errs.length ? '取得できませんでした: ' + errs.map(f => f.label).join(', ') : '';
    $('meta').textContent = items.length + '件 ・ 最終更新 ' + new Date(data.fetchedAt).toLocaleString('ja-JP');

    if (!items.length) { $('grid').innerHTML = '<div class="empty">記事がありません</div>'; return; }
    const now = Date.now();
    $('grid').innerHTML = items.map((it, i) => {
      const feature = it.image && i % 7 === 0;
      const isNew = it.date && now - it.date < 3 * 3600 * 1000;
      return '<article class="card' + (feature ? ' feature' : '') + '" data-url="' + esc(it.link) + '" title="' + esc(it.title) + '">' +
        (it.image ? '<img class="img" decoding="async" referrerpolicy="no-referrer" data-orig="' + esc(it.image) + '" src="' + esc(it.image.replace(/^http:/, 'https:')) + '" alt="">' : '') +
        '<div class="body"><h2>' + (isNew ? '<span class="new">NEW</span>' : '') + esc(it.title) + '</h2>' +
        (it.summary ? '<p>' + esc(it.summary) + '</p>' : '') + '</div>' +
        '<div class="foot"><span class="src">' + esc(it.source) + (it.date ? ' ・ ' + fmt(it.date) : '') + '</span><span class="more">Read More</span></div>' +
        '</article>';
    }).join('');
    // 画像の読み込みに失敗したら画像枠ごと消す
    // 読めたらフェードイン。httpsで失敗したら元URLで1回だけ再試行、それもダメなら画像枠ごと消す
    $('grid').querySelectorAll('img').forEach(img => {
      const onLoad = () => (img.naturalWidth < 40 ? img.remove() : img.classList.add('ok'));
      img.addEventListener('load', onLoad);
      img.addEventListener('error', () => {
        if (img.dataset.orig && img.src !== img.dataset.orig) img.src = img.dataset.orig;
        else img.remove();
      });
      if (img.complete && img.naturalWidth) onLoad();
    });
  }

  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('.tab'); if (!b) return;
    state.tab = b.dataset.cat; save(); render(); window.scrollTo(0, 0);
  });
  $('grid').addEventListener('click', e => {
    const c = e.target.closest('.card'); if (c) vscode.postMessage({ type: 'open', url: c.dataset.url });
  });
  $('q').addEventListener('input', () => { state.q = $('q').value; save(); render(); });
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('add').addEventListener('click', () => vscode.postMessage({ type: 'addFeed' }));
  $('edit').addEventListener('click', () => vscode.postMessage({ type: 'editFeeds' }));

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'data') { data = m.data; render(); }
    else if (m.type === 'loading') $('hdr').classList.toggle('loading', m.value);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { activate, deactivate };
