'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, DEFAULT_HOTKEY } = require('../electron/config');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heap-cfg-'));
  return path.join(dir, 'config.json');
}

test('missing config returns the default hotkey and writes the file', () => {
  const f = tmpFile();
  const cfg = loadConfig(f);
  assert.equal(cfg.hotkey, DEFAULT_HOTKEY);
  assert.ok(fs.existsSync(f), 'should have written a default config file');
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(onDisk.hotkey, DEFAULT_HOTKEY);
});

test('reads an existing hotkey value', () => {
  const f = tmpFile();
  fs.writeFileSync(f, JSON.stringify({ hotkey: 'CommandOrControl+Shift+H' }));
  assert.equal(loadConfig(f).hotkey, 'CommandOrControl+Shift+H');
});

test('corrupt JSON falls back to the default hotkey', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{ not valid json ');
  assert.equal(loadConfig(f).hotkey, DEFAULT_HOTKEY);
});

test('empty or non-string hotkey falls back to the default', () => {
  const f1 = tmpFile();
  fs.writeFileSync(f1, JSON.stringify({ hotkey: '   ' }));
  assert.equal(loadConfig(f1).hotkey, DEFAULT_HOTKEY);
  const f2 = tmpFile();
  fs.writeFileSync(f2, JSON.stringify({ hotkey: 42 }));
  assert.equal(loadConfig(f2).hotkey, DEFAULT_HOTKEY);
});

test('default hotkey is Cmd/Ctrl+Shift+V', () => {
  assert.equal(DEFAULT_HOTKEY, 'CommandOrControl+Shift+V');
});
