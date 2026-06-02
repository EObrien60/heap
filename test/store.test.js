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

test('renaming a space re-seeds its hints from the new name (no explicit hints)', () => {
  const s = freshStore();
  const sp = s.createSpace({ name: 'Scratch' });
  assert.deepEqual(sp.hints, ['scratch']);
  const up = s.updateSpace(sp.id, { name: 'Billing API' });
  assert.deepEqual(up.hints.sort(), ['api', 'billing']);
  // explicit hints still win over re-seeding
  const up2 = s.updateSpace(sp.id, { name: 'Payments', hints: ['pay', 'stripe'] });
  assert.deepEqual(up2.hints, ['pay', 'stripe']);
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
