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
