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
// Honor PORT=0 (ephemeral) — `|| 4321` would wrongly treat "0" as unset.
const PORT = process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 4321;
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
    const found = store._state().items.find((i) => i.imageFile === safe);
    res.writeHead(200, { 'Content-Type': (found && found.mime) || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.end(data);
  });
}

function spaceNameOf(id) { const sp = store._state().spaces.find((s) => s.id === id); return sp ? sp.name : null; }

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
      const allItems = store._state().items;
      const total = all ? allItems.length : allItems.filter((i) => i.spaceId === spaceId).length;
      return sendJSON(res, 200, { items, total });
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
        return sendJSON(res, 201, { item: { ...item, src: `/api/images/${item.imageFile}`, spaceName: spaceNameOf(item.spaceId) } });
      }
      if (!body.content || !String(body.content).trim()) return sendJSON(res, 400, { error: 'empty content' });
      const { item, suggestedSpace } = store.createTextItem({ content: String(body.content), title: body.title, type: body.type, spaceId: body.spaceId });
      return sendJSON(res, 201, { item: { ...item, spaceName: spaceNameOf(item.spaceId) }, suggestedSpace });
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
  return new Promise((resolve, reject) => {
    server.once('error', reject); // surface bind failures (e.g. EADDRINUSE) instead of hanging
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
