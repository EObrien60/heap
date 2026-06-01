# heap v2 — Spaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-project "Spaces" to heap so a multi-project dev can switch their entire scratch working-set in one keystroke, with a per-Space resume line, anchors, a "move?" nudge, and scoped/global search — without the tool feeling heavier than v1.

**Architecture:** Extract all domain logic out of `server.js` into a pure, file-backed `lib/store.js` that is unit-testable with `node:test` (no port, no HTTP). `server.js` becomes thin HTTP wiring over the store. The frontend (`public/`) gains a command palette, active-Space chip, resume bar, anchors/recent grouping, and search-scope toggle. Storage migrates v1 bare-array → v2 `{version, activeSpaceId, spaces, items}` on load.

**Tech Stack:** Node 20 (`node:test`, `node:assert`, built-in `http`/`fs`/`crypto`), vanilla HTML/CSS/JS. Zero npm dependencies. Playwright MCP for browser smoke tests.

---

## File Structure

- **Create `lib/store.js`** — pure domain logic: load/migrate/persist, Space CRUD, item CRUD, search, space suggestion. One responsibility: own the data. No HTTP.
- **Create `test/store.test.js`** — `node:test` unit tests for `lib/store.js`.
- **Create `test/server.test.js`** — `node:test` integration tests that boot the HTTP server on an ephemeral port and hit the API.
- **Modify `server.js`** — strip domain logic; import `createStore`; map routes to store methods. HTTP only.
- **Modify `public/index.html`** — palette overlay, active-Space chip, resume bar, search-scope toggle markup.
- **Modify `public/app.js`** — spaces state, palette + fuzzy match + `1`–`9`, resume bar, anchors/recent grouping, move-nudge chip, search-scope toggle + space chips, url ↗ open.
- **Modify `public/styles.css`** — palette, chip, resume bar, anchors header, nudge chip, open button.
- **Modify `README.md`** — document Spaces.
- **Modify `package.json`** — add `"test": "node --test"`.

Each task commits independently. Run from repo root `/Users/ethanobrien/dev/misc/heap`.

---

### Task 1: Extract store + v1→v2 migration

**Files:**
- Create: `lib/store.js`
- Create: `test/store.test.js`
- Modify: `package.json` (add test script)

- [ ] **Step 1: Write failing tests for migration + state defaults**

Create `test/store.test.js`:

```js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'heap-'));
}
function freshStore(seed) {
  const dir = tmpdir();
  const dbFile = path.join(dir, 'heap.json');
  const imagesDir = path.join(dir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  if (seed !== undefined) fs.writeFileSync(dbFile, JSON.stringify(seed));
  return createStore({ dbFile, imagesDir });
}

test('empty start creates a default General space and makes it active', () => {
  const s = freshStore();
  const spaces = s.listSpaces();
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].name, 'General');
  assert.equal(s.getState().activeSpaceId, spaces[0].id);
});

test('v1 bare-array file migrates: all items get a spaceId into General', () => {
  const v1 = [
    { id: 'a', kind: 'text', type: 'text', title: 'one', content: 'one', tags: [], pinned: false, createdAt: 1, updatedAt: 1 },
    { id: 'b', kind: 'text', type: 'sql', title: 'two', content: 'SELECT 1', tags: [], pinned: false, createdAt: 2, updatedAt: 2 },
  ];
  const s = freshStore(v1);
  const spaces = s.listSpaces();
  assert.equal(spaces.length, 1);
  const gid = spaces[0].id;
  const items = s.searchItems({ spaceId: gid, all: false, q: '' });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.spaceId === gid));
  assert.equal(s.getState().activeSpaceId, gid);
});

test('migration persists as v2 and reloads unchanged', () => {
  const dir = tmpdir();
  const dbFile = path.join(dir, 'heap.json');
  const imagesDir = path.join(dir, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.writeFileSync(dbFile, JSON.stringify([{ id: 'a', kind: 'text', type: 'text', title: 't', content: 't', tags: [], pinned: false, createdAt: 1, updatedAt: 1 }]));
  const s1 = createStore({ dbFile, imagesDir });
  const gid = s1.listSpaces()[0].id;
  const onDisk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  assert.equal(onDisk.version, 2);
  assert.equal(onDisk.activeSpaceId, gid);
  // reload
  const s2 = createStore({ dbFile, imagesDir });
  assert.equal(s2.listSpaces().length, 1);
  assert.equal(s2.searchItems({ spaceId: gid, all: false, q: '' }).length, 1);
});

test('setActiveSpace updates state and rejects unknown id', () => {
  const s = freshStore();
  const gid = s.listSpaces()[0].id;
  assert.equal(s.setActiveSpace(gid).activeSpaceId, gid);
  assert.throws(() => s.setActiveSpace('nope'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/store.test.js`
Expected: FAIL — `Cannot find module '../lib/store'`.

- [ ] **Step 3: Implement `lib/store.js` (load/migrate/persist + spaces/state basics)**

Create `lib/store.js`:

```js
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
    // guarantee at least one space + a valid active id
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
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, dbFile);
  }

  // sort spaces by order then createdAt for stable 1-9 mapping
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

  // persist synchronously on first migration so on-disk shape is v2 immediately
  if (Array.isArray(safeRead())) { flushSync(); }
  function safeRead() {
    try { return fs.existsSync(dbFile) ? JSON.parse(fs.readFileSync(dbFile, 'utf8')) : null; }
    catch (_) { return null; }
  }
  function flushSync() {
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, dbFile);
  }

  return {
    listSpaces, getState, setActiveSpace,
    // exposed for later tasks / tests
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/store.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Add test script to package.json**

Modify `package.json` `"scripts"` to:

```json
  "scripts": {
    "start": "node server.js",
    "test": "node --test"
  },
```

- [ ] **Step 6: Commit**

```bash
git add lib/store.js test/store.test.js package.json
git commit -m "feat(store): extract file-backed store with v1->v2 migration"
```

---

### Task 2: Space CRUD + hints + delete-reassign

**Files:**
- Modify: `lib/store.js`
- Modify: `test/store.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/store.test.js`:

```js
test('createSpace seeds hints from name and assigns next order', () => {
  const s = freshStore();
  const sp = s.createSpace({ name: 'Billing API' });
  assert.deepEqual(sp.hints.sort(), ['api', 'billing']);
  assert.ok(sp.color);
  assert.ok(s.listSpaces().some((x) => x.id === sp.id));
});

test('updateSpace patches name/hints/resumeNote/color/order', () => {
  const s = freshStore();
  const sp = s.createSpace({ name: 'Acme' });
  const up = s.updateSpace(sp.id, { resumeNote: 'fixing auth bug', hints: ['acme', 'auth'], color: '#fff' });
  assert.equal(up.resumeNote, 'fixing auth bug');
  assert.deepEqual(up.hints, ['acme', 'auth']);
  assert.equal(up.color, '#fff');
});

test('deleteSpace reassigns its items to next remaining space', () => {
  const s = freshStore();
  const gid = s.listSpaces()[0].id;
  const sp = s.createSpace({ name: 'Temp' });
  const it = s.createTextItem({ content: 'hello', spaceId: sp.id }).item;
  const res = s.deleteSpace(sp.id);
  assert.ok(res.reassignedTo);
  assert.notEqual(res.reassignedTo, sp.id);
  const moved = s.searchItems({ all: true, q: '' }).find((i) => i.id === it.id);
  assert.equal(moved.spaceId, res.reassignedTo);
});

test('deleting the active space moves active to reassignment target', () => {
  const s = freshStore();
  const sp = s.createSpace({ name: 'Temp' });
  s.setActiveSpace(sp.id);
  const res = s.deleteSpace(sp.id);
  assert.equal(s.getState().activeSpaceId, res.reassignedTo);
});

test('cannot delete the last remaining space', () => {
  const s = freshStore();
  const gid = s.listSpaces()[0].id;
  assert.throws(() => s.deleteSpace(gid), /last/i);
});
```

(These reference `createTextItem`, implemented in Task 3. Run only the Task-2 tests by name in Step 2 to keep this task isolated, or proceed — they will pass once Task 3 lands. To stay strictly TDD, run the three CRUD tests that don't need items first.)

- [ ] **Step 2: Run the space-only tests to verify they fail**

Run: `node --test --test-name-pattern="createSpace|updateSpace|cannot delete" test/store.test.js`
Expected: FAIL — `s.createSpace is not a function`.

- [ ] **Step 3: Implement Space CRUD in `lib/store.js`**

Inside `createStore`, before the `return {...}`, add:

```js
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
```

Add `createSpace, updateSpace, deleteSpace,` to the returned object.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test --test-name-pattern="createSpace|updateSpace|cannot delete" test/store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat(store): space CRUD with hint seeding and delete-reassign"
```

---

### Task 3: Items with spaceId, suggestion, search scope

**Files:**
- Modify: `lib/store.js`
- Modify: `test/store.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/store.test.js`:

```js
test('createTextItem lands in active space when no spaceId given', () => {
  const s = freshStore();
  const gid = s.getState().activeSpaceId;
  const { item } = s.createTextItem({ content: 'SELECT * FROM t' });
  assert.equal(item.spaceId, gid);
  assert.equal(item.type, 'sql');
});

test('createTextItem suggests another space when content matches its hints', () => {
  const s = freshStore();
  const billing = s.createSpace({ name: 'Billing' });
  // active is still General
  const { suggestedSpace } = s.createTextItem({ content: 'the billing webhook is failing' });
  assert.ok(suggestedSpace);
  assert.equal(suggestedSpace.id, billing.id);
});

test('no suggestion when content matches only the active space', () => {
  const s = freshStore();
  const gid = s.getState().activeSpaceId;
  s.updateSpace(gid, { hints: ['general', 'core'] });
  const { suggestedSpace } = s.createTextItem({ content: 'core stuff here' });
  assert.equal(suggestedSpace, null);
});

test('image items never produce a suggestion', () => {
  const s = freshStore();
  s.createSpace({ name: 'Billing' });
  const r = s.createImageItem({ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' });
  assert.equal(r.suggestedSpace, undefined);
  assert.equal(r.item.kind, 'image');
});

test('searchItems scoped to a space excludes other spaces; all=true includes them', () => {
  const s = freshStore();
  const gid = s.getState().activeSpaceId;
  const other = s.createSpace({ name: 'Other' });
  s.createTextItem({ content: 'alpha in general' });
  s.createTextItem({ content: 'beta in other', spaceId: other.id });
  const scoped = s.searchItems({ spaceId: gid, all: false, q: '' });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].content, 'alpha in general');
  const global = s.searchItems({ all: true, q: 'beta' });
  assert.equal(global.length, 1);
  assert.equal(global[0].spaceId, other.id);
  assert.equal(global[0].spaceName, 'Other');
});

test('updateItem can move an item to another space', () => {
  const s = freshStore();
  const other = s.createSpace({ name: 'Other' });
  const { item } = s.createTextItem({ content: 'move me' });
  const moved = s.updateItem(item.id, { spaceId: other.id });
  assert.equal(moved.spaceId, other.id);
});

test('pinned items sort before unpinned within scope', () => {
  const s = freshStore();
  const a = s.createTextItem({ content: 'aaa' }).item;
  const b = s.createTextItem({ content: 'bbb' }).item;
  s.updateItem(a.id, { pinned: true });
  const list = s.searchItems({ spaceId: s.getState().activeSpaceId, all: false, q: '' });
  assert.equal(list[0].id, a.id);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/store.test.js`
Expected: FAIL — `s.createTextItem is not a function` (and the Task-2 item tests now also run).

- [ ] **Step 3: Implement items in `lib/store.js`**

Add these helpers + methods inside `createStore` (before `return`):

```js
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
```

Add `createTextItem, createImageItem, updateItem, deleteItem, getItem, searchItems, detectType,` to the returned object.

- [ ] **Step 4: Run tests to verify pass**

Run: `node --test test/store.test.js`
Expected: PASS (all store tests, ~16).

- [ ] **Step 5: Commit**

```bash
git add lib/store.js test/store.test.js
git commit -m "feat(store): items with spaceId, space suggestion, scoped/global search"
```

---

### Task 4: Rewire server.js over the store + integration tests

**Files:**
- Modify: `server.js`
- Create: `test/server.test.js`

- [ ] **Step 1: Write failing integration tests**

Create `test/server.test.js`:

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-srv-'));
process.env.HEAP_DATA_DIR = dir;
process.env.PORT = '0';
process.env.NO_OPEN = '1';

const { startServer } = require('../server');
let server, base;

before(async () => {
  server = await startServer();
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function req(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('GET /api/spaces returns the default space', async () => {
  const r = await req('GET', '/api/spaces');
  assert.equal(r.status, 200);
  assert.equal(r.json.spaces.length, 1);
});

test('create space, set active, paste lands there', async () => {
  const sp = (await req('POST', '/api/spaces', { name: 'Proj' })).json.space;
  await req('PATCH', '/api/state', { activeSpaceId: sp.id });
  const created = (await req('POST', '/api/items', { content: 'hello world' })).json;
  assert.equal(created.item.spaceId, sp.id);
});

test('paste matching another space hints returns suggestedSpace', async () => {
  const billing = (await req('POST', '/api/spaces', { name: 'Billing' })).json.space;
  // active is 'Proj' from prior test
  const created = (await req('POST', '/api/items', { content: 'billing is broken' })).json;
  assert.ok(created.suggestedSpace);
  assert.equal(created.suggestedSpace.id, billing.id);
});

test('search all vs scoped', async () => {
  const all = (await req('GET', '/api/items?all=1&q=billing')).json;
  assert.ok(all.items.length >= 1);
});

test('delete space reassigns; cannot delete last', async () => {
  const spaces = (await req('GET', '/api/spaces')).json.spaces;
  const del = await req('DELETE', '/api/spaces/' + spaces[spaces.length - 1].id);
  assert.equal(del.status, 200);
  assert.ok(del.json.reassignedTo);
});
```

- [ ] **Step 2: Run to verify fail**

Run: `node --test test/server.test.js`
Expected: FAIL — `startServer is not a function` (server.js doesn't export it yet).

- [ ] **Step 3: Rewrite `server.js` as thin HTTP over the store**

Replace the entire contents of `server.js` with:

```js
#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { createStore } = require('./lib/store');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.HEAP_DATA_DIR || path.join(ROOT, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DB_FILE = path.join(DATA_DIR, 'heap.json');
const PORT = Number(process.env.PORT) || 4321;
const MAX_BODY = 64 * 1024 * 1024;

fs.mkdirSync(IMAGES_DIR, { recursive: true });
const store = createStore({ dbFile: DB_FILE, imagesDir: IMAGES_DIR });

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}
function serveImage(res, file) {
  const safe = path.basename(file);
  fs.readFile(path.join(IMAGES_DIR, safe), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const item = store.getItem ? null : null; // mime resolved below
    const found = store._state().items.find((i) => i.imageFile === safe);
    res.writeHead(200, { 'Content-Type': (found && found.mime) || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (p === '/api/spaces' && method === 'GET') return sendJSON(res, 200, { spaces: store.listSpaces() });
    if (p === '/api/spaces' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      return sendJSON(res, 201, { space: store.createSpace({ name: body.name, color: body.color }) });
    }
    if (p.startsWith('/api/spaces/') && method === 'PATCH') {
      const id = p.slice('/api/spaces/'.length);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      try { return sendJSON(res, 200, { space: store.updateSpace(id, body) }); }
      catch (e) { return sendJSON(res, 404, { error: e.message }); }
    }
    if (p.startsWith('/api/spaces/') && method === 'DELETE') {
      const id = p.slice('/api/spaces/'.length);
      try { return sendJSON(res, 200, store.deleteSpace(id)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/state' && method === 'GET') return sendJSON(res, 200, store.getState());
    if (p === '/api/state' && method === 'PATCH') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      try { return sendJSON(res, 200, store.setActiveSpace(body.activeSpaceId)); }
      catch (e) { return sendJSON(res, 400, { error: e.message }); }
    }
    if (p === '/api/items' && method === 'GET') {
      const all = url.searchParams.get('all') === '1';
      const spaceId = url.searchParams.get('space') || store.getState().activeSpaceId;
      const q = url.searchParams.get('q') || '';
      const items = store.searchItems({ spaceId, all, q });
      return sendJSON(res, 200, { items, total: store._state().items.length });
    }
    if (p.startsWith('/api/items/') && method === 'GET') {
      const item = store.getItem(p.slice('/api/items/'.length));
      if (!item) return sendJSON(res, 404, { error: 'not found' });
      const view = item.kind === 'image' ? { ...item, src: `/api/images/${item.imageFile}` } : item;
      return sendJSON(res, 200, { item: view });
    }
    if (p === '/api/items' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.kind === 'image' || (typeof body.dataUrl === 'string' && body.dataUrl.startsWith('data:'))) {
        const { item } = store.createImageItem({ dataUrl: body.dataUrl, title: body.title, spaceId: body.spaceId });
        return sendJSON(res, 201, { item: { ...item, src: `/api/images/${item.imageFile}`, spaceName: store._state().spaces.find((s)=>s.id===item.spaceId)?.name } });
      }
      if (!body.content || !String(body.content).trim()) return sendJSON(res, 400, { error: 'empty content' });
      const { item, suggestedSpace } = store.createTextItem({ content: String(body.content), title: body.title, type: body.type, spaceId: body.spaceId });
      return sendJSON(res, 201, { item: { ...item, spaceName: store._state().spaces.find((s)=>s.id===item.spaceId)?.name }, suggestedSpace });
    }
    if (p.startsWith('/api/items/') && method === 'PATCH') {
      const id = p.slice('/api/items/'.length);
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const item = store.updateItem(id, body);
      return item ? sendJSON(res, 200, { item }) : sendJSON(res, 404, { error: 'not found' });
    }
    if (p.startsWith('/api/items/') && method === 'DELETE') {
      const id = p.slice('/api/items/'.length);
      return sendJSON(res, store.deleteItem(id) ? 200 : 404, { ok: true });
    }
    if (p.startsWith('/api/images/') && method === 'GET') return serveImage(res, p.slice('/api/images/'.length));
    if (method === 'GET') return serveStatic(res, p);
    res.writeHead(405); res.end('Method not allowed');
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});

function startServer() {
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      const port = server.address().port;
      if (process.env.NODE_ENV !== 'test') {
        const urlStr = `http://localhost:${port}`;
        console.log(`\n  heap is live → ${urlStr}\n  (${store._state().items.length} items, ${store.listSpaces().length} spaces)\n`);
        if (process.env.NO_OPEN !== '1' && process.platform === 'darwin') execFile('open', [urlStr], () => {});
      }
      resolve(server);
    });
  });
}

if (require.main === module) startServer();
module.exports = { startServer, server };
```

- [ ] **Step 4: Run integration tests to verify pass**

Run: `node --test test/server.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (all store + server tests).

- [ ] **Step 6: Commit**

```bash
git add server.js test/server.test.js
git commit -m "refactor(server): thin HTTP layer over store; add spaces/state endpoints"
```

---

### Task 5: Frontend — spaces fetch, active chip, palette + 1–9 switching

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Add palette + active-chip markup to `index.html`**

In `index.html`, change the `.brand` line and add the chip + palette. Replace:

```html
    <div class="brand">heap</div>
```
with:
```html
    <div class="brand">heap</div>
    <button id="spaceChip" class="space-chip" title="Switch space (⌘K)"><span class="dot"></span><span id="spaceName">…</span></button>
```

Before the closing `</body>` (after `<div id="toast">`), add the palette overlay:

```html
  <div id="palette" class="palette-overlay" hidden>
    <div class="palette">
      <input id="paletteInput" type="text" placeholder="Jump to space, or type a command…" autocomplete="off" spellcheck="false" />
      <div id="paletteList" class="palette-list"></div>
    </div>
  </div>
```

Add to the help footer (inside `<footer class="help">`):

```html
    <span><kbd>⌘K</kbd> spaces</span>
    <span><kbd>1</kbd>–<kbd>9</kbd> jump</span>
```

- [ ] **Step 2: Add styles to `styles.css`**

Append:

```css
/* space chip */
.space-chip {
  display: flex; align-items: center; gap: 7px;
  background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 11px; color: var(--text);
  font-size: 13px; font-weight: 600; cursor: pointer; flex-shrink: 0;
}
.space-chip:hover { border-color: var(--border-strong); }
.space-chip .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex-shrink: 0; }

/* command palette */
.palette-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100; display: flex; justify-content: center; align-items: flex-start; padding-top: 14vh; }
.palette-overlay[hidden] { display: none; }
.palette { width: min(560px, 92vw); background: var(--bg-elev); border: 1px solid var(--border-strong); border-radius: 13px; overflow: hidden; box-shadow: 0 24px 70px rgba(0,0,0,0.55); }
#paletteInput { width: 100%; background: transparent; border: none; border-bottom: 1px solid var(--border); color: var(--text); font-size: 16px; padding: 16px 18px; outline: none; font-family: var(--sans); }
.palette-list { max-height: 50vh; overflow-y: auto; padding: 6px; }
.palette-row { display: flex; align-items: center; gap: 11px; padding: 10px 12px; border-radius: 8px; cursor: pointer; color: var(--text); }
.palette-row .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.palette-row .num { margin-left: auto; color: var(--text-faint); font-family: var(--mono); font-size: 11px; }
.palette-row .sub { color: var(--text-faint); font-size: 12px; }
.palette-row.active { background: var(--sel); box-shadow: inset 0 0 0 1px var(--accent); }
.palette-row.cmd { color: var(--accent); }
```

- [ ] **Step 3: Add spaces state + switching logic to `app.js`**

At the top of `app.js` after the existing `const ... = $(...)` lines, add element refs and state:

```js
const spaceChip = $('#spaceChip');
const spaceNameEl = $('#spaceName');
const paletteEl = $('#palette');
const paletteInput = $('#paletteInput');
const paletteList = $('#paletteList');

let spaces = [];
let activeSpaceId = null;
let searchAll = false;     // search scope toggle (Task 7 uses it)
let palSel = 0;            // palette selection index
let palRows = [];          // current palette rows [{type, id, label, ...}]
```

Add space-loading + chip rendering functions:

```js
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
}
async function switchSpace(id) {
  if (id === activeSpaceId) return;
  activeSpaceId = id;
  await api('PATCH', '/api/state', { activeSpaceId: id });
  renderChip();
  searchEl.value = '';
  selected = -1;
  await load();
}
```

- [ ] **Step 4: Implement the palette in `app.js`**

Add:

```js
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
  const cmds = [
    { type: 'cmd', id: 'new', label: '＋ New space…' },
  ].filter((c) => fuzzy(q, c.label));
  palRows = [
    ...matchSpaces.map((s, i) => ({ type: 'space', id: s.id, label: s.name, color: s.color, num: i < 9 ? i + 1 : null })),
    ...cmds,
  ];
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

async function runPaletteRow(row) {
  if (!row) return;
  if (row.type === 'space') { closePalette(); await switchSpace(row.id); }
  else if (row.id === 'new') {
    const name = prompt('New space name:');
    closePalette();
    if (name && name.trim()) {
      const sp = (await api('POST', '/api/spaces', { name: name.trim() })).space;
      await loadSpaces();
      await switchSpace(sp.id);
    }
  }
}

paletteInput.addEventListener('input', () => buildPalette(paletteInput.value));
paletteInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palRows.length - 1, palSel + 1); buildPalette(paletteInput.value); reSelect(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); buildPalette(paletteInput.value); reSelect(); }
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
```

- [ ] **Step 5: Wire global keys (⌘K, 1–9) into the existing document keydown handler**

In `app.js`, inside the top of the `document.addEventListener('keydown', (e) => {...})` handler (before the `/` handler), add:

```js
  // command palette
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (!paletteEl.hidden) return; // palette handles its own keys
  // 1–9 jump to space (only when not typing)
  if (/^[1-9]$/.test(e.key) && !inField) {
    const ordered = spaces;
    const idx = Number(e.key) - 1;
    if (ordered[idx]) { e.preventDefault(); switchSpace(ordered[idx].id); return; }
  }
```

(`inField` is computed at the top of that handler in v1 — keep that line above this block.)

- [ ] **Step 6: Boot spaces before items**

At the bottom of `app.js`, replace `load();` with:

```js
(async () => { await loadSpaces(); await load(); })();
```

And change `load()` so the items request is space-scoped. Replace the v1 `load` body's fetch line:

```js
  const data = await api('GET', '/api/items' + (q ? '?q=' + encodeURIComponent(q) : ''));
```
with:
```js
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (searchAll) params.set('all', '1'); else params.set('space', activeSpaceId);
  const data = await api('GET', '/api/items?' + params.toString());
```

- [ ] **Step 7: Browser smoke test**

Run: `NO_OPEN=1 PORT=4399 node server.js &` then drive with Playwright MCP:
- Navigate `http://localhost:4399`.
- Assert the space chip shows "General".
- Press `⌘K` (Meta+k) → palette visible; type a query → rows filter.
- Create a space via the palette "New space" (or POST one first), confirm chip updates after switching.
- Press `2` → switches to second space (chip name changes).
Kill the server afterward.

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(ui): space chip, command palette, 1-9 switching, scoped item load"
```

---

### Task 6: Frontend — resume bar + anchors/recent grouping

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Add resume bar markup to `index.html`**

Immediately after the `.composer` div and before `<main id="list">`, add:

```html
  <div class="resume-bar" id="resumeBar">
    <span class="resume-label">▸ where I left off</span>
    <div class="resume-text" id="resumeText" tabindex="0"></div>
  </div>
```

- [ ] **Step 2: Add styles to `styles.css`**

Append:

```css
.resume-bar { display: flex; align-items: center; gap: 12px; max-width: 1100px; width: 100%; margin: 0 auto; padding: 8px 20px; }
.resume-label { color: var(--pin); font-size: 12px; font-weight: 600; flex-shrink: 0; }
.resume-text { flex: 1; color: var(--text); font-size: 13px; padding: 6px 10px; border-radius: 7px; border: 1px solid transparent; cursor: text; min-height: 20px; }
.resume-text:empty::before { content: 'what are you in the middle of?'; color: var(--text-faint); }
.resume-text:hover { border-color: var(--border); }
.resume-text.editing { border-color: var(--accent); background: var(--bg-elev); outline: none; white-space: pre-wrap; }
.list-section { color: var(--text-faint); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.7px; margin: 8px 2px 2px; }
```

- [ ] **Step 3: Implement resume bar in `app.js`**

Add element ref near the top:

```js
const resumeText = $('#resumeText');
```

Add render + edit logic:

```js
function renderResume() {
  const sp = activeSpace();
  resumeText.textContent = sp ? sp.resumeNote : '';
}
resumeText.addEventListener('focus', () => resumeText.classList.add('editing'));
resumeText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); resumeText.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); renderResume(); resumeText.blur(); }
});
resumeText.addEventListener('blur', async () => {
  resumeText.classList.remove('editing');
  const sp = activeSpace();
  const val = resumeText.textContent.trim();
  if (sp && val !== sp.resumeNote) {
    await api('PATCH', '/api/spaces/' + sp.id, { resumeNote: val });
    sp.resumeNote = val;
  }
});
```

Call `renderResume()` inside `renderChip()` (append `renderResume();` at its end) and inside `switchSpace` (already calls `renderChip`).

- [ ] **Step 4: Add anchors/recent grouping to `render()` in `app.js`**

Replace the `render()` function's list-building branch (the `listEl.innerHTML = items.map(...)` line) with grouped rendering:

```js
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
```

(Selection index stays aligned because `items` is already `[...pinned, ...rest]` order from the server's pinned-first sort.)

- [ ] **Step 5: Browser smoke test**

Boot server, Playwright:
- Type into resume bar, press Enter, reload page → text persists.
- Add two items, pin one (`p`) → "Anchors" and "Recent" headers appear, pinned item under Anchors.
- Switch space → resume text changes to that space's note.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(ui): per-space resume line and anchors/recent grouping"
```

---

### Task 7: Frontend — move nudge, search scope toggle, space chips, url open

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Add search-scope toggle markup to `index.html`**

Inside `.search-wrap`, after the `#count` span, add:

```html
      <button id="scopeToggle" class="scope-toggle" title="Toggle search across all spaces (⌘\)">all</button>
```

- [ ] **Step 2: Add styles to `styles.css`**

Append:

```css
.scope-toggle { position: absolute; right: 8px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-faint); font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 3px 7px; border-radius: 5px; cursor: pointer; }
.scope-toggle.on { background: var(--accent); color: #07111f; border-color: var(--accent); }
.space-tag { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 4px; color: var(--text); display: inline-flex; align-items: center; gap: 4px; }
.space-tag .dot { width: 7px; height: 7px; border-radius: 50%; }
.nudge { margin-top: 8px; display: inline-flex; align-items: center; gap: 6px; background: var(--accent-dim); color: var(--text); border: 1px solid var(--border-strong); border-radius: 7px; padding: 4px 9px; font-size: 11px; cursor: pointer; }
.nudge:hover { border-color: var(--accent); }
.nudge .x { color: var(--text-faint); margin-left: 4px; }
.open-btn { }
```

- [ ] **Step 3: Search scope toggle in `app.js`**

Add ref + handler:

```js
const scopeToggle = $('#scopeToggle');
function renderScope() { scopeToggle.classList.toggle('on', searchAll); }
scopeToggle.addEventListener('click', () => { searchAll = !searchAll; renderScope(); load(); });
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); searchAll = !searchAll; renderScope(); load(); }
});
```

Call `renderScope()` once during boot (add to the boot IIFE after `loadSpaces()`).

- [ ] **Step 4: Show space tag on cards when searching all**

In the `card(it, i)` function in `app.js`, in the `card-head`, after the `<span class="badge ...">` line, add a conditional space tag:

```js
        ${searchAll && it.spaceName ? `<span class="space-tag"><span class="dot" style="background:${(spaces.find(s=>s.id===it.spaceId)||{}).color||'#888'}"></span>${escapeHtml(it.spaceName)}</span>` : ''}
```

- [ ] **Step 5: URL open button in `app.js`**

In `card(it, i)`, in the `.card-actions` block, add an open button for url items (before the copy button):

```js
          ${it.type === 'url' ? `<button class="icon-btn open" data-act="open" title="Open ↗">↗</button>` : ''}
```

In the `listEl` click handler's action switch, add:

```js
    else if (act === 'open') window.open(it.content, '_blank');
```

- [ ] **Step 6: Move-nudge chip in `app.js`**

Track the suggestion and render it on the matching card. Add module state near the top:

```js
let suggestion = null; // { itemId, spaceId, spaceName }
```

In the text-add paths, capture `suggestedSpace`. Update `addText()` and the global-paste handler: after the POST response `r`, set:

```js
    if (r.suggestedSpace) suggestion = { itemId: r.item.id, spaceId: r.suggestedSpace.id, spaceName: r.suggestedSpace.name };
```

(Change those POST calls to capture the response, e.g. `const r = await api('POST', '/api/items', { content });`.)

In `card(it, i)`, after the `body` is appended (end of the returned template, before closing `</div>`), add the nudge for the matching item:

```js
      ${suggestion && suggestion.itemId === it.id ? `<div class="nudge" data-act="move" data-space="${suggestion.spaceId}">↪ ${escapeHtml(suggestion.spaceName)}? move<span class="x" data-act="dismiss">✕</span></div>` : ''}
```

In the click handler action switch, add:

```js
    else if (act === 'move') { e.stopPropagation(); api('PATCH', '/api/items/' + it.id, { spaceId: actBtn.dataset.space }).then(() => { suggestion = null; load(); }); }
    else if (act === 'dismiss') { e.stopPropagation(); suggestion = null; render(); }
```

(Place these inside the existing `if (actBtn)` block. Note `data-act="dismiss"` is nested in the nudge; ensure the `actBtn = e.target.closest('[data-act]')` lookup catches it — it does.)

Clear `suggestion` when switching spaces or searching: add `suggestion = null;` at the start of `switchSpace` and in the search `input` debounce callback.

- [ ] **Step 7: Browser smoke test**

Boot server, Playwright:
- Create space "Billing". Active = General. Paste "billing is broken" → a "↪ Billing? move" chip appears on the new card. Click it → item moves (disappears from General view).
- Toggle scope (click `all` or `⌘\`) → searching shows items from all spaces with space tags.
- Add a url item → `↗` button present; (open opens a tab — assert button exists).

- [ ] **Step 8: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "feat(ui): move-nudge, all-spaces search toggle with tags, url open"
```

---

### Task 8: README + full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update `README.md`**

Add a "Spaces" section documenting: what a Space is, `⌘K` palette + `1`–`9` switching, the resume line, anchors, the move nudge, and the `all` search toggle (`⌘\`). Update the keys table with `⌘K`, `1`–`9`, `⌘\`. Note storage is now `data/heap.json` v2 (`{version, activeSpaceId, spaces, items}`) and migrates v1 automatically.

- [ ] **Step 2: Run full automated suite**

Run: `npm test`
Expected: PASS (all store + server tests).

- [ ] **Step 3: Full manual smoke via Playwright**

Boot a fresh data dir, then exercise the end-to-end story:
- Create 2 spaces, switch with `⌘K` and with `1`/`2`.
- Paste text into each; set a resume line in each; confirm it follows the active space.
- Pin an item → Anchors header. Paste content matching the other space → nudge → move.
- Toggle `all` search → find an item from the other space with its tag.
- Reload page → active space, resume lines, items all persisted.
Kill server, clear the scratch `data/` dir created during smoke.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document Spaces, switching, resume line, search scope"
```

---

## Self-Review

**Spec coverage:**
- Space model (id/name/color/hints/resumeNote/order) → Tasks 1–2. ✓
- Item gains `spaceId` → Task 3. ✓
- Persisted `activeSpaceId`, restore on reopen → Tasks 1, 4, 5. ✓
- v1→v2 migration → Task 1. ✓
- ⌘K palette + 1–9 switching → Task 5. ✓
- Resume line → Task 6. ✓
- Anchors/Recent → Task 6. ✓
- Move-nudge from hints → Tasks 3 (logic), 7 (UI). ✓
- Search active vs all + space chips → Tasks 3 (logic), 7 (UI). ✓
- Click copies; url ↗ open → Task 7. ✓
- Delete-space reassign + can't-delete-last + active-follows → Task 2. ✓
- API endpoints (spaces/state/items params) → Task 4. ✓
- Designed-for auto-switch: `PATCH /api/state {activeSpaceId}` exists (Task 4) — a future shell hook calls it; no shell code built. ✓
- Out-of-scope items: none introduced. ✓

**Placeholder scan:** No TBD/TODO. The `.open-btn {}` empty CSS rule is intentional (reserved hook, harmless) — acceptable; remove if undesired. Every code step shows real code.

**Type consistency:** Store methods (`listSpaces`, `getState`, `setActiveSpace`, `createSpace`, `updateSpace`, `deleteSpace`, `createTextItem`→`{item, suggestedSpace}`, `createImageItem`→`{item}`, `updateItem`, `deleteItem`, `getItem`, `searchItems`) are named identically across Tasks 1–4 and consumed with those exact names/shapes in `server.js`. Frontend state names (`spaces`, `activeSpaceId`, `searchAll`, `suggestion`, `palRows`, `palSel`) are introduced in Task 5 and reused consistently in Tasks 6–7. Item view includes `spaceId`/`spaceName` (store `listView` + server POST responses) consumed by the space-tag/nudge UI.

**Note on TDD boundary:** Store/server logic is unit/integration tested (`node:test`). Frontend (vanilla DOM, no framework/bundler) is verified by Playwright browser smoke steps rather than unit tests — an honest choice given zero build tooling; the value-bearing logic lives in the tested store.
