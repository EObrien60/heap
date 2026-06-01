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
  function searchItems({ spaceId, all, q }) {
    let result = state.items;
    if (!all) result = result.filter((i) => i.spaceId === (spaceId || state.activeSpaceId));
    return result.slice();
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
