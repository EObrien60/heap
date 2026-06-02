'use strict';
const fs = require('fs');

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+V';

/**
 * Load the hotkey config from the given JSON file path.
 * Returns { hotkey }. Falls back to DEFAULT_HOTKEY when the file is missing,
 * corrupt, or has no valid hotkey string. Writes a default file when missing
 * so the user can discover and edit it.
 */
function loadConfig(configFile) {
  let raw = null;
  try {
    if (fs.existsSync(configFile)) raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (_) {
    raw = null; // corrupt file → fall back
  }
  const obj = raw && typeof raw === 'object' ? raw : {};
  const hotkey = typeof obj.hotkey === 'string' && obj.hotkey.trim() ? obj.hotkey.trim() : DEFAULT_HOTKEY;
  const result = { hotkey };
  if (!fs.existsSync(configFile)) {
    try { fs.writeFileSync(configFile, JSON.stringify(result, null, 2) + '\n'); } catch (_) { /* best effort */ }
  }
  return result;
}

module.exports = { loadConfig, DEFAULT_HOTKEY };
