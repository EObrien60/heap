'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SPACE_COLORS = ['#5b9dff', '#c792ea', '#7fdbca', '#f78c6c', '#ffcb6b', '#82aaff', '#c3e88d', '#ff6b9d', '#a0e070'];

function newId() { return crypto.randomBytes(9).toString('base64url'); }

function nameToHints(name) {
  return [...new Set(String(name).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
}

function createStore({ dbFile, imagesDir }) {
  let state = load();

  function load() {
    let raw = null;
    try {
      if (fs.existsSync(dbFile)) raw = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    } catch (err) {
      raw = null; // corrupt file → start fresh rather than crash
    }
    let st;
    if (Array.isArray(raw)) {
      st = migrateV1(raw);
    } else if (raw && raw.version === 2 && Array.isArray(raw.spaces) && Array.isArray(raw.items)) {
      st = raw;
    } else {
      st = freshState();
    }
    if (st.spaces.length === 0) {
      const g = makeSpace('General');
      st.spaces.push(g);
    }
    if (!st.spaces.some((sp) => sp.id === st.activeSpaceId)) {
      st.activeSpaceId = st.spaces[0].id;
    }
    return st;
  }

  function makeSpace(name, color) {
    return {
      id: newId(),
      name,
      color: color || SPACE_COLORS[0],
      hints: nameToHints(name),
      resumeNote: '',
      order: 0,
      createdAt: Date.now(),
    };
  }

  function freshState() {
    const g = makeSpace('General');
    return { version: 2, activeSpaceId: g.id, spaces: [g], items: [] };
  }

  function migrateV1(arr) {
    const g = makeSpace('General');
    const items = arr.map((it) => ({ ...it, spaceId: g.id }));
    return { version: 2, activeSpaceId: g.id, spaces: [g], items };
  }

  let saveTimer = null, savePending = false;
  function persist() {
    savePending = true;
    if (saveTimer) return;
    saveTimer = setTimeout(flush, 50);
  }
  function flush() {
    saveTimer = null;
    if (!savePending) return;
    savePending = false;
    const tmp = dbFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, dbFile);
    } catch (err) {
      console.error('Failed to persist heap.json:', err.message);
    }
  }
  function flushSync() {
    const tmp = dbFile + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, dbFile);
    } catch (err) {
      console.error('Failed to persist heap.json:', err.message);
    }
  }
  function safeRead() {
    try { return fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : null; }
    catch (_) { return null; }
  }

  function listSpaces() {
    return state.spaces.slice().sort((a, b) => (a.order - b.order) || (a.createdAt - b.createdAt));
  }
  function getState() { return { activeSpaceId: state.activeSpaceId }; }
  function setActiveSpace(id) {
    if (!state.spaces.some((s) => s.id === id)) throw new Error('unknown space');
    state.activeSpaceId = id;
    persist();
    return { activeSpaceId: id };
  }
  const SQL_RE = /^\s*(WITH|SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW|DATABASE|SCHEMA)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX|VIEW)|TRUNCATE|EXPLAIN|BEGIN|COMMIT)\b/i;
  const URL_RE = /^https?:\/\/\S+$/i;
  const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };

  function detectType(text) {
    const t = (text || '').trim();
    if (!t) return 'text';
    if (URL_RE.test(t)) return 'url';
    if (SQL_RE.test(t)) return 'sql';
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try { JSON.parse(t); return 'json'; } catch (_) {}
    }
    const codeHints = /[;{}]|\b(function|const|let|var|def|class|import|export|return|public|private|async|await|=>)\b|^\s{2,}\S/m;
    if (codeHints.test(t) && /\n/.test(t)) return 'code';
    if (codeHints.test(t) && t.length < 200 && /[;{}()=]/.test(t)) return 'code';
    return 'text';
  }
  function titleFor(text) {
    const first = (text || '').trim().split('\n')[0].trim();
    return first.length <= 80 ? first : first.slice(0, 77) + '…';
  }

  function suggestSpace(text, activeId) {
    const hay = String(text || '').toLowerCase();
    let best = null, bestCount = 0;
    for (const sp of state.spaces) {
      if (sp.id === activeId) continue;
      let count = 0;
      for (const hint of sp.hints) {
        const re = new RegExp('\\b' + hint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (re.test(hay)) count++;
      }
      if (count > bestCount) { best = sp; bestCount = count; }
    }
    return best ? { id: best.id, name: best.name } : null;
  }

  function createTextItem({ content, title, type, spaceId }) {
    const sid = spaceId && state.spaces.some((s) => s.id === spaceId) ? spaceId : state.activeSpaceId;
    const now = Date.now();
    const detected = type || detectType(content);
    const item = {
      id: newId(), kind: 'text', type: detected,
      title: (title && title.trim()) || titleFor(content),
      content: content || '', tags: [], pinned: false, spaceId: sid,
      createdAt: now, updatedAt: now,
    };
    state.items.unshift(item);
    persist();
    return { item, suggestedSpace: suggestSpace((item.title + ' ' + item.content), sid) };
  }

  function createImageItem({ dataUrl, title, spaceId }) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
    if (!m) throw new Error('Invalid image data URL');
    const mime = m[1];
    const ext = MIME_EXT[mime] || 'bin';
    const buf = Buffer.from(m[2], 'base64');
    const id = newId();
    const file = `${id}.${ext}`;
    fs.writeFileSync(path.join(imagesDir, file), buf);
    const sid = spaceId && state.spaces.some((s) => s.id === spaceId) ? spaceId : state.activeSpaceId;
    const now = Date.now();
    const item = {
      id, kind: 'image', type: 'image', title: (title && title.trim()) || 'Image',
      imageFile: file, mime, bytes: buf.length, tags: [], pinned: false, spaceId: sid,
      createdAt: now, updatedAt: now,
    };
    state.items.unshift(item);
    persist();
    return { item };
  }

  function updateItem(id, patch) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return null;
    if (typeof patch.title === 'string') item.title = patch.title;
    if (typeof patch.content === 'string' && item.kind === 'text') {
      item.content = patch.content;
      item.type = detectType(patch.content);
      if (!patch.title) item.title = titleFor(patch.content);
    }
    if (typeof patch.pinned === 'boolean') item.pinned = patch.pinned;
    if (Array.isArray(patch.tags)) item.tags = patch.tags;
    if (typeof patch.spaceId === 'string' && state.spaces.some((s) => s.id === patch.spaceId)) item.spaceId = patch.spaceId;
    item.updatedAt = Date.now();
    persist();
    return item;
  }

  function deleteItem(id) {
    const idx = state.items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    const [removed] = state.items.splice(idx, 1);
    if (removed.kind === 'image' && removed.imageFile) {
      fs.unlink(path.join(imagesDir, removed.imageFile), () => {});
    }
    persist();
    return true;
  }

  function getItem(id) { return state.items.find((i) => i.id === id) || null; }

  function spaceName(id) { const sp = state.spaces.find((s) => s.id === id); return sp ? sp.name : null; }

  function listView(i) {
    const base = { ...i, spaceName: spaceName(i.spaceId) };
    if (i.kind === 'image') return { ...base, src: `/api/images/${i.imageFile}` };
    const preview = (i.content || '').slice(0, 600);
    return { ...base, content: preview, truncated: (i.content || '').length > 600 };
  }

  function searchItems({ spaceId, all, q }) {
    let result = state.items;
    if (!all) result = result.filter((i) => i.spaceId === (spaceId || state.activeSpaceId));
    if (q && q.trim()) {
      const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
      result = result.filter((i) => {
        const hay = (i.title + ' ' + (i.content || '') + ' ' + i.type + ' ' + (i.tags || []).join(' ')).toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
    }
    return result.slice().sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt)).map(listView);
  }

  function createSpace({ name, color }) {
    const nm = String(name || '').trim() || 'Untitled';
    const maxOrder = state.spaces.reduce((m, s) => Math.max(m, s.order), -1);
    const usedColors = new Set(state.spaces.map((s) => s.color));
    const pick = color || SPACE_COLORS.find((c) => !usedColors.has(c)) || SPACE_COLORS[state.spaces.length % SPACE_COLORS.length];
    const sp = { ...makeSpace(nm, pick), order: maxOrder + 1 };
    state.spaces.push(sp);
    persist();
    return sp;
  }

  function updateSpace(id, patch) {
    const sp = state.spaces.find((s) => s.id === id);
    if (!sp) throw new Error('unknown space');
    if (typeof patch.name === 'string' && patch.name.trim()) sp.name = patch.name.trim();
    if (typeof patch.color === 'string') sp.color = patch.color;
    if (Array.isArray(patch.hints)) sp.hints = patch.hints.map((h) => String(h).toLowerCase().trim()).filter(Boolean);
    if (typeof patch.resumeNote === 'string') sp.resumeNote = patch.resumeNote;
    if (typeof patch.order === 'number') sp.order = patch.order;
    persist();
    return sp;
  }

  function deleteSpace(id) {
    if (state.spaces.length <= 1) throw new Error('cannot delete the last space');
    const idx = state.spaces.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error('unknown space');
    const ordered = listSpaces().filter((s) => s.id !== id);
    const target = ordered[0].id;
    state.items.forEach((it) => { if (it.spaceId === id) it.spaceId = target; });
    state.spaces.splice(idx, 1);
    if (state.activeSpaceId === id) state.activeSpaceId = target;
    persist();
    return { reassignedTo: target };
  }

  // If the on-disk file was v1 (bare array), persist the migrated v2 shape immediately
  // so the file is upgraded even before any mutation.
  if (Array.isArray(safeRead())) { flushSync(); }

  return {
    listSpaces, getState, setActiveSpace, searchItems,
    createSpace, updateSpace, deleteSpace,
    createTextItem, createImageItem, updateItem, deleteItem, getItem, detectType,
    _state: () => state,
    _persist: persist,
    _flush: flush,
    _makeSpace: makeSpace,
    _nameToHints: nameToHints,
    _newId: newId,
    _colors: SPACE_COLORS,
    _imagesDir: imagesDir,
  };
}

module.exports = { createStore, nameToHints };
