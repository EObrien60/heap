'use strict';

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const searchEl = $('#search');
const composerEl = $('#composer');
const countEl = $('#count');
const toastEl = $('#toast');
const pasteHint = $('#pasteHint');
const spaceChip = $('#spaceChip');
const spaceNameEl = $('#spaceName');
const paletteEl = $('#palette');
const paletteInput = $('#paletteInput');
const paletteList = $('#paletteList');
const resumeText = $('#resumeText');
const scopeToggle = $('#scopeToggle');
const modalEl = $('#modal');
const modalMsg = $('#modalMsg');
const modalInput = $('#modalInput');
const modalOk = $('#modalOk');
const modalCancel = $('#modalCancel');

let spaces = [];
let activeSpaceId = null;
let searchAll = false;     // search scope toggle (Task 7 uses it)
let palSel = 0;            // palette selection index
let palRows = [];          // current palette rows

let items = [];
let selected = -1;     // index into items
let editingId = null;
let suggestion = null; // { itemId, spaceId, spaceName }

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

async function loadSpaces() {
  spaces = (await api('GET', '/api/spaces')).spaces;
  const st = await api('GET', '/api/state');
  activeSpaceId = st.activeSpaceId;
  renderChip();
}
function activeSpace() { return spaces.find((s) => s.id === activeSpaceId) || spaces[0]; }
function renderChip() {
  const sp = activeSpace();
  if (!sp) return;
  spaceNameEl.textContent = sp.name;
  spaceChip.querySelector('.dot').style.background = sp.color;
  renderResume();
}
let resumeEditingSpaceId = null;
function renderResume() {
  const sp = activeSpace();
  resumeText.textContent = sp ? (sp.resumeNote || '') : '';
}
resumeText.addEventListener('focus', () => { resumeEditingSpaceId = activeSpaceId; resumeText.classList.add('editing'); });
resumeText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); resumeText.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); renderResume(); resumeText.blur(); }
});
resumeText.addEventListener('blur', async () => {
  resumeText.classList.remove('editing');
  const sp = spaces.find((s) => s.id === resumeEditingSpaceId);
  resumeEditingSpaceId = null;
  if (!sp) return;
  const val = resumeText.textContent.trim();
  if (val !== (sp.resumeNote || '')) {
    await api('PATCH', '/api/spaces/' + sp.id, { resumeNote: val });
    sp.resumeNote = val;
  }
});
async function switchSpace(id) {
  if (id === activeSpaceId) return;
  suggestion = null;
  activeSpaceId = id;
  await api('PATCH', '/api/state', { activeSpaceId: id });
  renderChip();
  searchEl.value = '';
  selected = -1;
  await load();
}

function openPalette() {
  paletteEl.hidden = false;
  paletteInput.value = '';
  buildPalette('');
  paletteInput.focus();
}
function closePalette() { paletteEl.hidden = true; paletteInput.blur(); }

function fuzzy(q, text) {
  q = q.toLowerCase(); text = text.toLowerCase();
  if (!q) return true;
  let i = 0;
  for (const ch of text) { if (ch === q[i]) i++; if (i === q.length) return true; }
  return false;
}

function buildPalette(q) {
  const matchSpaces = spaces.filter((s) => fuzzy(q, s.name));
  const active = activeSpace();
  const cmds = [
    { type: 'cmd', id: 'new', label: '＋ New space…' },
    ...(active ? [
      { type: 'cmd', id: 'rename', label: `✎ Rename "${active.name}"…` },
      { type: 'cmd', id: 'delete', label: `🗑 Delete "${active.name}"…` },
    ] : []),
  ].filter((c) => fuzzy(q, c.label));
  palRows = [
    ...matchSpaces.map((s) => ({ type: 'space', id: s.id, label: s.name, color: s.color })),
    ...cmds,
  ];
  // assign 1-9 nums by the space's position in the full ordered list
  palRows.forEach((r) => { if (r.type === 'space') { const idx = spaces.findIndex((s) => s.id === r.id); r.num = idx < 9 ? idx + 1 : null; } });
  palSel = 0;
  paletteList.innerHTML = palRows.map((r, i) => {
    if (r.type === 'space') {
      return `<div class="palette-row ${i === palSel ? 'active' : ''}" data-i="${i}">
        <span class="dot" style="background:${r.color}"></span><span>${escapeHtml(r.label)}</span>
        ${r.num ? `<span class="num">${r.num}</span>` : ''}${r.id === activeSpaceId ? '<span class="num">active</span>' : ''}
      </div>`;
    }
    return `<div class="palette-row cmd ${i === palSel ? 'active' : ''}" data-i="${i}">${escapeHtml(r.label)}</div>`;
  }).join('');
}

let modalResolve = null;
function closeModal(value) {
  if (!modalResolve) return;
  const r = modalResolve; modalResolve = null;
  modalEl.hidden = true;
  r(value);
}
function askText(label, initial = '') {
  return new Promise((resolve) => {
    modalResolve = resolve;
    modalMsg.textContent = label;
    modalInput.hidden = false;
    modalInput.value = initial;
    modalEl.hidden = false;
    modalInput.focus();
    modalInput.select();
  });
}
function askConfirm(message) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    modalMsg.textContent = message;
    modalInput.hidden = true;
    modalEl.hidden = false;
    modalOk.focus();
  });
}
// OK resolves with the input text (askText) or true (askConfirm); Cancel/Esc/backdrop resolve null/false.
modalOk.addEventListener('click', () => closeModal(modalInput.hidden ? true : modalInput.value));
modalCancel.addEventListener('click', () => closeModal(modalInput.hidden ? false : null));
modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(modalInput.hidden ? false : null); });
modalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); closeModal(modalInput.value); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeModal(null); }
});
document.addEventListener('keydown', (e) => {
  if (modalEl.hidden) return;
  if (modalInput.hidden && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeModal(false); }
  if (modalInput.hidden && e.key === 'Enter') { e.preventDefault(); e.stopImmediatePropagation(); closeModal(true); }
}, true); // capture so it runs before the app's other global keydown handlers

async function runPaletteRow(row) {
  if (!row) return;
  if (row.type === 'space') { closePalette(); await switchSpace(row.id); }
  else if (row.id === 'new') {
    closePalette();
    const name = await askText('New space name:');
    if (name && name.trim()) {
      const sp = (await api('POST', '/api/spaces', { name: name.trim() })).space;
      await loadSpaces();
      await switchSpace(sp.id);
    }
  }
  else if (row.id === 'rename') {
    const sp = activeSpace();
    closePalette();
    const name = await askText('Rename space:', sp ? sp.name : '');
    if (sp && name && name.trim() && name.trim() !== sp.name) {
      await api('PATCH', '/api/spaces/' + sp.id, { name: name.trim() });
      await loadSpaces();
      renderResume();
      await load();
    }
  }
  else if (row.id === 'delete') {
    const sp = activeSpace();
    closePalette();
    if (!sp) return;
    if (spaces.length <= 1) { toast("Can't delete your only space"); return; }
    const ok = await askConfirm(`Delete "${sp.name}"? Its items move to another space.`);
    if (!ok) return;
    try {
      const { reassignedTo } = await api('DELETE', '/api/spaces/' + sp.id);
      await loadSpaces();
      activeSpaceId = reassignedTo;
      renderChip();
      searchEl.value = '';
      selected = -1;
      await load();
      toast('Space deleted');
    } catch (err) {
      toast('Delete failed: ' + err.message);
    }
  }
}

paletteInput.addEventListener('input', () => buildPalette(paletteInput.value));
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palRows.length - 1, palSel + 1); reSelect(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); reSelect(); }
  else if (e.key === 'Enter') { e.preventDefault(); runPaletteRow(palRows[palSel]); }
});
function reSelect() {
  [...paletteList.children].forEach((el, i) => el.classList.toggle('active', i === palSel));
}
paletteList.addEventListener('click', (e) => {
  const row = e.target.closest('.palette-row');
  if (row) runPaletteRow(palRows[Number(row.dataset.i)]);
});
paletteEl.addEventListener('click', (e) => { if (e.target === paletteEl) closePalette(); });
spaceChip.addEventListener('click', openPalette);

let searchDebounce = null;
async function load() {
  const q = searchEl.value.trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (searchAll) params.set('all', '1'); else params.set('space', activeSpaceId);
  const data = await api('GET', '/api/items?' + params.toString());
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
function cardEl(i) { return listEl.querySelector('.card[data-i="' + i + '"]'); }
function render() {
  if (items.length === 0) {
    listEl.innerHTML = `<div class="empty"><div class="big">📥</div>${
      searchEl.value.trim() ? 'Nothing matches that.' : 'Heap is empty. Paste something (⌘V) to get started.'
    }</div>`;
    return;
  }
  const pinned = items.filter((i) => i.pinned);
  const rest = items.filter((i) => !i.pinned);
  let html = '';
  if (pinned.length && rest.length) {
    html += `<div class="list-section">Anchors</div>` + pinned.map((it, i) => card(it, i)).join('');
    html += `<div class="list-section">Recent</div>` + rest.map((it, i) => card(it, pinned.length + i)).join('');
  } else {
    html = items.map((it, i) => card(it, i)).join('');
  }
  listEl.innerHTML = html;
  // ensure selected visible
  if (selected >= 0) {
    const el = cardEl(selected);
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
        ${searchAll && it.spaceName ? `<span class="space-tag"><span class="dot" style="background:${(spaces.find(s=>s.id===it.spaceId)||{}).color||'#888'}"></span>${escapeHtml(it.spaceName)}</span>` : ''}
        <span class="card-title">${escapeHtml(it.title)}</span>
        <span class="card-time" title="${meta}">${timeAgo(it.updatedAt)}</span>
        <div class="card-actions">
          ${it.type === 'url' ? `<button class="icon-btn open" data-act="open" title="Open ↗">↗</button>` : ''}
          <button class="icon-btn copy" data-act="copy" title="Copy (↵)">⧉</button>
          <button class="icon-btn pin ${it.pinned ? 'on' : ''}" data-act="pin" title="Pin (p)">${it.pinned ? '★' : '☆'}</button>
          ${it.kind === 'text' ? '<button class="icon-btn edit" data-act="edit" title="Edit (e)">✎</button>' : ''}
          <button class="icon-btn del" data-act="del" title="Delete (⌫)">✕</button>
        </div>
      </div>
      ${body}
      ${suggestion && suggestion.itemId === it.id ? `<div class="nudge" data-act="move" data-space="${suggestion.spaceId}">↪ ${escapeHtml(suggestion.spaceName)}? move<span class="x" data-act="dismiss">✕</span></div>` : ''}
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
  const r = await api('POST', '/api/items', { content });
  suggestion = r.suggestedSpace ? { itemId: r.item.id, spaceId: r.suggestedSpace.id, spaceName: r.suggestedSpace.name } : null;
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
    else if (act === 'open') window.open(it.content, '_blank');
    else if (act === 'dismiss') { suggestion = null; render(); }
    else if (act === 'move') { api('PATCH', '/api/items/' + it.id, { spaceId: actBtn.dataset.space }).then(() => { suggestion = null; load(); }); }
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
    const r = await api('POST', '/api/items', { content: text });
    suggestion = r.suggestedSpace ? { itemId: r.item.id, spaceId: r.suggestedSpace.id, spaceName: r.suggestedSpace.name } : null;
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
  suggestion = null;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(load, 90);
});

document.addEventListener('keydown', (e) => {
  const inField = document.activeElement === searchEl || document.activeElement === composerEl
    || (document.activeElement && document.activeElement.classList.contains('card-edit'));

  // command palette
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (!paletteEl.hidden) return; // palette handles its own keys
  // 1–9 jump to space (only when not typing)
  if (/^[1-9]$/.test(e.key) && !inField) {
    const idx = Number(e.key) - 1;
    if (spaces[idx]) { e.preventDefault(); switchSpace(spaces[idx].id); return; }
  }

  // global: focus search
  if (e.key === '/' && !inField) { e.preventDefault(); searchEl.focus(); searchEl.select(); return; }

  // composer save
  if (document.activeElement === composerEl && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault(); addText(); return;
  }

  // from search: arrow down jumps into list
  if (document.activeElement === searchEl) {
    if (e.key === 'ArrowDown') { e.preventDefault(); selected = 0; searchEl.blur(); listEl.focus(); render(); }
    else if (e.key === 'Enter' && items.length) { e.preventDefault(); selected = 0; copyItem(items[0], cardEl(0)); }
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
    if (items[selected]) { e.preventDefault(); copyItem(items[selected], cardEl(selected)); }
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

function renderScope() { scopeToggle.classList.toggle('on', searchAll); }
scopeToggle.addEventListener('click', () => { searchAll = !searchAll; renderScope(); load(); });
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); searchAll = !searchAll; renderScope(); load(); }
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
(async () => { await loadSpaces(); renderScope(); await load(); })();
