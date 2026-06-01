#!/usr/bin/env node
'use strict';

/*
 * heap — a fast, light scratch store for the stuff you constantly paste in and out.
 * Zero dependencies. Just `node server.js`.
 *
 * Storage: data/heap.json (atomic writes) + data/images/<id>.<ext> for image blobs.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const DB_FILE = path.join(DATA_DIR, 'heap.json');

const PORT = Number(process.env.PORT) || 4321;
const MAX_BODY = 64 * 1024 * 1024; // 64MB — covers pasted screenshots

// ---------- storage ----------

fs.mkdirSync(IMAGES_DIR, { recursive: true });

/** @type {Array<object>} kept in memory, persisted on mutation */
let items = [];
try {
  if (fs.existsSync(DB_FILE)) {
    items = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!Array.isArray(items)) items = [];
  }
} catch (err) {
  console.error('Could not read heap.json, starting empty:', err.message);
  items = [];
}

let saveTimer = null;
let savePending = false;
function persist() {
  // Debounce bursts of writes but guarantee eventual flush.
  savePending = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!savePending) return;
    savePending = false;
    const tmp = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(items));
      fs.renameSync(tmp, DB_FILE); // atomic on same filesystem
    } catch (err) {
      console.error('Failed to persist heap.json:', err.message);
    }
  }, 50);
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

// ---------- type detection ----------

const SQL_RE = /^\s*(WITH|SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+(TABLE|INDEX|VIEW|DATABASE|SCHEMA)|ALTER\s+TABLE|DROP\s+(TABLE|INDEX|VIEW)|TRUNCATE|EXPLAIN|BEGIN|COMMIT)\b/i;
const URL_RE = /^https?:\/\/\S+$/i;

function detectType(text) {
  const t = (text || '').trim();
  if (!t) return 'text';
  if (URL_RE.test(t)) return 'url';
  if (SQL_RE.test(t)) return 'sql';
  // JSON
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); return 'json'; } catch (_) { /* not json */ }
  }
  // Code heuristic: structural punctuation density / common code tokens.
  const codeHints = /[;{}]|\b(function|const|let|var|def|class|import|export|return|public|private|async|await|=>)\b|^\s{2,}\S/m;
  if (codeHints.test(t) && /\n/.test(t)) return 'code';
  if (codeHints.test(t) && t.length < 200 && /[;{}()=]/.test(t)) return 'code';
  return 'text';
}

function titleFor(text, type) {
  const firstLine = (text || '').trim().split('\n')[0].trim();
  if (firstLine.length <= 80) return firstLine;
  return firstLine.slice(0, 77) + '…';
}

// ---------- item ops ----------

function createTextItem({ content, title, type, tags }) {
  const now = Date.now();
  const detected = type || detectType(content);
  const item = {
    id: newId(),
    kind: 'text',
    type: detected,
    title: (title && title.trim()) || titleFor(content, detected),
    content: content || '',
    tags: Array.isArray(tags) ? tags : [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  items.unshift(item);
  persist();
  return item;
}

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
};

function createImageItem({ dataUrl, title, tags }) {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || '');
  if (!m) throw new Error('Invalid image data URL');
  const mime = m[1];
  const ext = MIME_EXT[mime] || 'bin';
  const buf = Buffer.from(m[2], 'base64');
  const now = Date.now();
  const id = newId();
  const file = `${id}.${ext}`;
  fs.writeFileSync(path.join(IMAGES_DIR, file), buf);
  const item = {
    id,
    kind: 'image',
    type: 'image',
    title: (title && title.trim()) || 'Image',
    imageFile: file,
    mime,
    bytes: buf.length,
    tags: Array.isArray(tags) ? tags : [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  items.unshift(item);
  persist();
  return item;
}

function updateItem(id, patch) {
  const item = items.find((i) => i.id === id);
  if (!item) return null;
  if (typeof patch.title === 'string') item.title = patch.title;
  if (typeof patch.content === 'string' && item.kind === 'text') {
    item.content = patch.content;
    item.type = detectType(patch.content);
    if (!patch.title) item.title = titleFor(patch.content, item.type);
  }
  if (typeof patch.pinned === 'boolean') item.pinned = patch.pinned;
  if (Array.isArray(patch.tags)) item.tags = patch.tags;
  item.updatedAt = Date.now();
  persist();
  return item;
}

function deleteItem(id) {
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return false;
  const [removed] = items.splice(idx, 1);
  if (removed.kind === 'image' && removed.imageFile) {
    fs.unlink(path.join(IMAGES_DIR, removed.imageFile), () => {});
  }
  persist();
  return true;
}

function searchItems(q) {
  let result = items;
  if (q && q.trim()) {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    result = items.filter((i) => {
      const hay = (i.title + ' ' + (i.content || '') + ' ' + i.type + ' ' + (i.tags || []).join(' ')).toLowerCase();
      return tokens.every((tok) => hay.includes(tok));
    });
  }
  // pinned first, then most-recently-updated.
  return result.slice().sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

// strip heavy content for list payloads
function listView(i) {
  if (i.kind === 'image') {
    return { ...i, src: `/api/images/${i.imageFile}` };
  }
  const preview = (i.content || '').slice(0, 600);
  return { ...i, content: preview, truncated: (i.content || '').length > 600 };
}

// ---------- http helpers ----------

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function serveImage(req, res, file) {
  const safe = path.basename(file);
  const filePath = path.join(IMAGES_DIR, safe);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const item = items.find((i) => i.imageFile === safe);
    res.writeHead(200, {
      'Content-Type': (item && item.mime) || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(data);
  });
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const { method } = req;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // API
    if (p === '/api/items' && method === 'GET') {
      const q = url.searchParams.get('q') || '';
      return sendJSON(res, 200, { items: searchItems(q).map(listView), total: items.length });
    }

    if (p.startsWith('/api/items/') && method === 'GET') {
      const id = p.slice('/api/items/'.length);
      const item = items.find((i) => i.id === id);
      if (!item) return sendJSON(res, 404, { error: 'not found' });
      const view = item.kind === 'image' ? { ...item, src: `/api/images/${item.imageFile}` } : item;
      return sendJSON(res, 200, { item: view });
    }

    if (p === '/api/items' && method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      let item;
      if (body.kind === 'image' || (typeof body.dataUrl === 'string' && body.dataUrl.startsWith('data:'))) {
        item = createImageItem({ dataUrl: body.dataUrl, title: body.title, tags: body.tags });
      } else {
        if (!body.content || !String(body.content).trim()) return sendJSON(res, 400, { error: 'empty content' });
        item = createTextItem({ content: String(body.content), title: body.title, type: body.type, tags: body.tags });
      }
      const view = item.kind === 'image' ? { ...item, src: `/api/images/${item.imageFile}` } : item;
      return sendJSON(res, 201, { item: view });
    }

    if (p.startsWith('/api/items/') && method === 'PATCH') {
      const id = p.slice('/api/items/'.length);
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const item = updateItem(id, body);
      if (!item) return sendJSON(res, 404, { error: 'not found' });
      return sendJSON(res, 200, { item });
    }

    if (p.startsWith('/api/items/') && method === 'DELETE') {
      const id = p.slice('/api/items/'.length);
      return sendJSON(res, deleteItem(id) ? 200 : 404, { ok: true });
    }

    if (p.startsWith('/api/images/') && method === 'GET') {
      return serveImage(req, res, p.slice('/api/images/'.length));
    }

    if (method === 'GET') return serveStatic(req, res, p);

    res.writeHead(405); res.end('Method not allowed');
  } catch (err) {
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  const urlStr = `http://localhost:${PORT}`;
  console.log(`\n  heap is live → ${urlStr}\n  (${items.length} item${items.length === 1 ? '' : 's'} loaded)\n`);
  if (process.env.NO_OPEN !== '1' && process.platform === 'darwin') {
    execFile('open', [urlStr], () => {});
  }
});
