'use strict';

/*
 * heap desktop — Electron wrapper around the existing local server + web UI.
 * Spotlight-style frosted overlay, summoned by a global hotkey, living in the
 * menu-bar tray with no dock icon. Reuses server.js + public/ unchanged.
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, shell } = require('electron');
const { loadConfig } = require('./config');

// Single-instance: a second launch just surfaces the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Boot the existing server in-process. Env MUST be set before requiring it,
// because server.js reads PORT / HEAP_DATA_DIR / NO_OPEN at module load.
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const firstRun = !fs.existsSync(CONFIG_PATH);
process.env.HEAP_DATA_DIR = path.join(app.getPath('userData'), 'data');
process.env.PORT = '0'; // ephemeral — we read the real port back
process.env.NO_OPEN = '1'; // never spawn a system browser
process.env.NODE_ENV = process.env.NODE_ENV || 'production';
const { startServer } = require('../server');

let win = null;
let tray = null;
let serverPort = null;
let cfg = null;

const isMac = process.platform === 'darwin';

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 560,
    show: false,
    frame: false,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    roundedCorners: true,
    hasShadow: true,
    resizable: true,
    fullscreenable: false,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadURL(`http://localhost:${serverPort}`);

  // Open external links (the url ↗ button, any target=_blank) in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keep the main window pinned to our local app; open anything else externally.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${serverPort}`)) {
      e.preventDefault();
      if (/^(https?|mailto|tel):/i.test(url)) shell.openExternal(url);
    }
  });

  // Native styling hook: the web app stays browser-agnostic; we flag it as in-app.
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript("document.body.classList.add('in-app');").catch(() => {});
  });

  win.on('blur', hide);
  // Cmd+W / close should hide the overlay, not quit the tray app.
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      hide();
    }
  });
}

function focusSearch() {
  if (!win) return;
  win.webContents
    .executeJavaScript("var s=document.getElementById('search'); if(s){s.focus();s.select();}")
    .catch(() => {});
}

function showWindow() {
  if (!win) return;
  if (isMac) app.show();
  win.center();
  win.show();
  win.focus();
  if (isMac) app.focus({ steal: true });
  focusSearch();
}

function hide() {
  if (!win || !win.isVisible()) return;
  win.hide();
  // Return focus to the app the user was in, so they can immediately paste.
  if (isMac) app.hide();
}

function toggle() {
  if (win && win.isVisible()) hide();
  else showWindow();
}

function buildMenu() {
  // A frameless window has no Edit menu, so Cmd+C/V/X/A/Z would not work in the
  // search/composer fields. Standard roles restore them and add native polish.
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'Window',
      submenu: [{ label: 'Close', accelerator: 'CmdOrCtrl+W', click: hide }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateTrayMenu() {
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show heap', click: showWindow },
      { type: 'separator' },
      {
        label: 'Launch at login',
        type: 'checkbox',
        checked: openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true });
          updateTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit heap',
        accelerator: 'CmdOrCtrl+Q',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  // createFromPath auto-loads tray-icon@2x.png for retina menu bars.
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('heap');
  updateTrayMenu();
  // Left-click shows (not toggle) to avoid a blur/click race with hide-on-blur.
  tray.on('click', showWindow);
}

function registerHotkey() {
  let ok = false;
  try {
    // A hand-edited, malformed accelerator in config.json makes register() throw,
    // not return false — catch it so a typo can't crash startup.
    ok = globalShortcut.register(cfg.hotkey, toggle);
  } catch (err) {
    console.warn('heap: invalid global hotkey', cfg.hotkey, '-', err.message);
  }
  if (!ok) {
    console.warn('heap: could not register global hotkey', cfg.hotkey, '(in use or invalid)');
    if (tray) tray.setToolTip(`heap — hotkey ${cfg.hotkey} unavailable; edit config.json`);
  }
}

app.whenReady().then(async () => {
  if (isMac && app.dock) app.dock.hide(); // accessory app: no dock icon
  cfg = loadConfig(CONFIG_PATH);

  const server = await startServer();
  serverPort = server.address().port;

  buildMenu();
  createWindow();
  createTray();
  registerHotkey();

  // First launch: default to starting at login (user can toggle off in the tray).
  if (firstRun) app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });

  app.on('second-instance', showWindow);
});

// Tray app: keep running when the overlay is hidden/closed.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  app.isQuitting = true;
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
