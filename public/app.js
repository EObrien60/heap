'use strict';

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const searchEl = $('#search');
const composerEl = $('#composer');
const countEl = $('#count');
const toastEl = $('#toast');
const pasteHint = $('#pasteHint');

let items = [];
let selected = -1;     // index into items
let editingId = null;

// ---------- api ----------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.status === 200 || res.status === 201 ? res.json() : null;
}

let searchDebounce = null;
async function load() {
  const q = searchEl.value.trim();
  const data = await api('GET', '/api/items' + (q ? '?q=' + encodeURIComponent(q) : ''));
  items = data.items;
  countEl.textContent = q ? `${items.length} / ${data.total}` : `${data.total}`;
  if (selected >= items.length) selected = items.length - 1;
  render();
}

// ---------- helpers ----------
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 604800) return Math.floor(s / 86400) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// minimal, safe-ish token coloring for sql/json/code previews
const SQL_KW = /\b(SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|GROUP|ORDER|BY|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|AND|OR|NOT|NULL|AS|DISTINCT|COUNT|SUM|AVG|MIN|MAX|HAVING|UNION|WITH|CASE|WHEN|THEN|ELSE|END|IN|LIKE|BETWEEN|IS|ASC|DESC)\b/gi;

function highlight(text, type) {
  let html = escapeHtml(text);
  if (type === 'sql') {
    html = html.replace(SQL_KW, '<span class="tok-key">$1</span>');
    html = html.replace(/('[^']*')/g, '<span class="tok-str">$1</span>');
    html = html.replace(/\b(\d+)\b/g, '<span class="tok-num">$1</span>');
  } else if (type === 'json') {
    html = html
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2')
      .replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="tok-str">$1</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="tok-num">$1</span>')
      .replace(/(-?\d+\.?\d*)/g, '<span class="tok-num">$1</span>');
  }
  return html;
}

// ---------- render ----------
function render() {
  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty"><div class="big">📥</div>${
      searchEl.value.trim() ? 'Nothing matches that.' : 'Heap is empty. Paste something (⌘V) to get started.'
    }</div>`;
    return;
  }
  listEl.innerHTML = items.map((it, i) => card(it, i)).join('');
  // ensure selected visible
  if (selected >= 0) {
    const el = listEl.children[selected];
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
}

function card(it, i) {
  const sel = i === selected ? ' selected' : '';
  const pinned = it.pinned ? ' pinned' : '';
  let body;
  if (it.kind === 'image') {
    body = `<div class="card-body"><img src="${it.src}" alt="${escapeHtml(it.title)}" loading="lazy" /></div>`;
  } else if (editingId === it.id) {
    body = `<textarea class="card-edit" data-edit="${it.id}">${escapeHtml(it.content)}</textarea>`;
  } else {
    const fade = it.truncated ? '<div class="fade"></div>' : '';
    body = `<pre class="card-body">${highlight(it.content || '', it.type)}${fade}</pre>`;
  }
  const meta = it.kind === 'image'
    ? `${(it.bytes / 1024).toFixed(0)} KB`
    : `${(it.content || '').length} ch`;
  return `
    <div class="card${sel}${pinned}" data-id="${it.id}" data-i="${i}">
      <div class="card-head">
        <span class="badge ${it.type}">${it.type}</span>
        <span class="card-title">${escapeHtml(it.title)}</span>
        <span class="card-time" title="${meta}">${timeAgo(it.updatedAt)}</span>
        <div class="card-actions">
          <button class="icon-btn copy" data-act="copy" title="Copy (↵)">⧉</button>
          <button class="icon-btn pin ${it.pinned ? 'on' : ''}" data-act="pin" title="Pin (p)">${it.pinned ? '★' : '☆'}</button>
          ${it.kind === 'text' ? '<button class="icon-btn edit" data-act="edit" title="Edit (e)">✎</button>' : ''}
          <button class="icon-btn del" data-act="del" title="Delete (⌫)">✕</button>
        </div>
      </div>
      ${body}
    </div>`;
}

// ---------- actions ----------
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 1100);
}

async function copyItem(it, cardEl) {
  try {
    if (it.kind === 'image') {
      const blob = await (await fetch(it.src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      toast('Image copied');
    } else {
      // list payload may be truncated; fetch full content if needed
      let content = it.content;
      if (it.truncated) {
        const full = await api('GET', '/api/items/' + it.id);
        content = full.item.content;
      }
      await navigator.clipboard.writeText(content);
      toast('Copied');
    }
    if (cardEl) { cardEl.classList.remove('copied'); void cardEl.offsetWidth; cardEl.classList.add('copied'); }
  } catch (err) {
    toast('Copy failed: ' + err.message);
  }
}

async function togglePin(it) {
  await api('PATCH', '/api/items/' + it.id, { pinned: !it.pinned });
  await load();
}

async function del(it) {
  await api('DELETE', '/api/items/' + it.id);
  if (selected >= 0 && items[selected] && items[selected].id === it.id) {
    // keep selection roughly in place
  }
  await load();
}

function startEdit(it) {
  if (it.kind !== 'text') return;
  editingId = it.id;
  render();
  const ta = listEl.querySelector(`[data-edit="${it.id}"]`);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

async function commitEdit(save) {
  const ta = listEl.querySelector(`[data-edit="${editingId}"]`);
  const id = editingId;
  editingId = null;
  if (save && ta) {
    await api('PATCH', '/api/items/' + id, { content: ta.value });
    await load();
  } else {
    render();
  }
}

async function addText() {
  const content = composerEl.value;
  if (!content.trim()) return;
  await api('POST', '/api/items', { content });
  composerEl.value = '';
  composerEl.style.height = '';
  searchEl.value = '';
  selected = 0;
  await load();
  toast('Added');
}

async function addImage(blob, title) {
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
  await api('POST', '/api/items', { kind: 'image', dataUrl, title });
  searchEl.value = '';
  selected = 0;
  await load();
  toast('Image added');
}

// ---------- list click handling ----------
listEl.addEventListener('click', (e) => {
  const cardEl = e.target.closest('.card');
  if (!cardEl) return;
  const id = cardEl.dataset.id;
  const it = items.find((x) => x.id === id);
  if (!it) return;
  selected = Number(cardEl.dataset.i);

  const actBtn = e.target.closest('[data-act]');
  if (actBtn) {
    e.stopPropagation();
    const act = actBtn.dataset.act;
    if (act === 'copy') copyItem(it, cardEl);
    else if (act === 'pin') togglePin(it);
    else if (act === 'edit') startEdit(it);
    else if (act === 'del') del(it);
    return;
  }
  if (editingId === id) return; // don't copy while editing
  copyItem(it, cardEl);
});

// edit textarea key handling (Esc cancel / ⌘↵ save)
listEl.addEventListener('keydown', (e) => {
  if (!editingId) return;
  if (e.key === 'Escape') { e.preventDefault(); commitEdit(false); }
  else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(true); }
});

// ---------- global paste capture ----------
window.addEventListener('paste', async (e) => {
  if (document.activeElement === composerEl || document.activeElement === searchEl) {
    // composer: let image paste still get captured, but text goes to the field
    const imgItem = [...(e.clipboardData?.items || [])].find((it) => it.type.startsWith('image/'));
    if (!imgItem) return; // normal text paste into the field
  }
  const cd = e.clipboardData;
  if (!cd) return;
  const imgItem = [...cd.items].find((it) => it.type.startsWith('image/'));
  if (imgItem) {
    e.preventDefault();
    const blob = imgItem.getAsFile();
    flashHint();
    await addImage(blob);
    return;
  }
  const text = cd.getData('text/plain');
  if (text && text.trim() && document.activeElement !== composerEl && document.activeElement !== searchEl) {
    e.preventDefault();
    flashHint();
    await api('POST', '/api/items', { content: text });
    searchEl.value = '';
    selected = 0;
    await load();
    toast('Pasted in');
  }
});

function flashHint() {
  pasteHint.classList.add('flash');
  setTimeout(() => pasteHint.classList.remove('flash'), 400);
}

// drag & drop images
window.addEventListener('dragover', (e) => { e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = [...(e.dataTransfer?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) { flashHint(); await addImage(file, file.name); }
});

// ---------- keyboard ----------
searchEl.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(load, 90);
});

document.addEventListener('keydown', (e) => {
  const inField = document.activeElement === searchEl || document.activeElement === composerEl
    || (document.activeElement && document.activeElement.classList.contains('card-edit'));

  // global: focus search
  if (e.key === '/' && !inField) { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }

  // composer save
  if (document.activeElement === composerEl && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault(); addText(); return;
  }

  // from search: arrow down jumps into list
  if (document.activeElement === searchEl) {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = 0; searchEl.blur(); listEl.focus(); render(); }
    else if (e.key === 'Enter' && items.length) { e.preventDefault(); selected = 0; copyItem(items[0], listEl.children[0]); }
    return;
  }

  if (inField) return; // don't hijack while typing/editing

  // list navigation
  if (e.key === 'ArrowDown' || e.key === 'j') {
    e.preventDefault(); selected = Math.min(items.length - 1, selected + 1); render();
  } else if (e.key === 'ArrowUp' || e.key === 'k') {
    e.preventDefault();
    if (selected <= 0) { selected = -1; searchEl.focus(); render(); }
    else { selected -= 1; render(); }
  } else if (e.key === 'Enter') {
    if (items[selected]) { e.preventDefault(); copyItem(items[selected], listEl.children[selected]); }
  } else if (e.key === 'p') {
    if (items[selected]) { e.preventDefault(); togglePin(items[selected]); }
  } else if (e.key === 'e') {
    if (items[selected]) { e.preventDefault(); startEdit(items[selected]); }
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    if (items[selected]) { e.preventDefault(); del(items[selected]); }
  } else if (e.key === 'Escape') {
    selected = -1; render();
  }
});

// auto-grow composer
composerEl.addEventListener('input', () => {
  composerEl.style.height = 'auto';
  composerEl.style.height = Math.min(composerEl.scrollHeight, 240) + 'px';
});
$('#addBtn').addEventListener('click', addText);

// refresh times periodically
setInterval(() => { if (!editingId) render(); }, 30000);

// ---------- boot ----------
load();
