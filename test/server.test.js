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
