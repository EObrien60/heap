# heap desktop (Electron) — design

**Date:** 2026-06-02
**Status:** Approved, ready for implementation plan
**Builds on:** heap v2 (zero-dep Node server + store + vanilla web UI, with Spaces)

## Goal

Turn heap into a native-feeling macOS desktop app: a Spotlight-style overlay summoned by a global hotkey (default **⌘⇧V**), packaged as a `.app`/`.dmg`, launching at login, living in the menu-bar tray with no dock icon. Reuse the existing server + web UI unchanged; Electron is a thin, native-feeling wrapper.

## Principles

- **Reuse, don't rewrite.** The store, `server.js`, and `public/` web UI are untouched in behavior. The renderer keeps talking to the local server over `fetch`. Electron wraps them.
- **Native feel.** Vibrancy, rounded panel, floating level, real Edit-menu shortcuts, and focus-return-on-hide so it behaves like a first-class macOS utility, not a browser tab.
- **KISS.** No signing/notarization, auto-update, custom icon, in-app settings UI, or non-mac builds this phase.

## Architecture

Electron's **main process boots the existing `server.js` in-process**. `server.js` already exports `startServer()` and only self-listens under `require.main === module`, so the main process can require and start it.

Boot sequence in `electron/main.js` (before requiring the server):
1. Set `process.env.HEAP_DATA_DIR = path.join(app.getPath('userData'), 'data')`.
2. Set `process.env.PORT = '0'` (ephemeral) and `process.env.NO_OPEN = '1'` (don't spawn a system browser).
3. `const { startServer } = require('../server')`, `const server = await startServer()`, read `server.address().port`.
4. Create the `BrowserWindow` and load `http://localhost:<port>`.

Data lives in `~/Library/Application Support/heap/data` (`data/heap.json` + `data/images/`). The store's fresh/migrate logic handles an empty dir on first launch.

The renderer uses **no `nodeIntegration` and no preload/IPC for core behavior** — it's just the existing web app served locally. The only main→renderer touch is a one-line `webContents.executeJavaScript` to (a) add an `.in-app` body class for native styling and (b) focus the search box on show. The web app remains fully functional in a plain browser (no `.in-app` class there).

**External links:** `webContents.setWindowOpenHandler` returns `{action:'deny'}` and calls `shell.openExternal(url)`, so the `url` items' `↗` open button (and any link) opens in the user's default browser instead of spawning an in-app window. (Same for any target=_blank navigation.)

## The overlay window

`BrowserWindow` options:
- `frame: false`, `transparent: true`, `vibrancy: 'under-window'`, `visualEffectState: 'active'`, `roundedCorners: true`, `hasShadow: true`.
- `alwaysOnTop: true` at floating panel level (`win.setAlwaysOnTop(true, 'floating')`), `skipTaskbar: true`, `fullscreenable: false`, `resizable: true`.
- Centered, default size ~760×560.
- `show: false` initially; `backgroundColor: '#00000000'` so vibrancy shows through.

Behaviors:
- **Toggle on hotkey:** ⌘⇧V shows+focuses if hidden, hides if visible.
- **Hide on blur:** `win.on('blur', hide)` — clicking away dismisses it.
- **Focus return on hide:** on macOS, `app.hide()` is used to dismiss so focus returns to the previously-active app — letting the user immediately ⌘V the thing they just grabbed into wherever they were working. (Window is also `win.hide()`-ed.)
- **Show = ready to type:** on show, focus the window and inject `document.getElementById('search').focus()` so typing/searching is instant.
- **Esc stays the in-app key** (clear selection / cancel edit). Dismiss is hotkey-again or click-away — Esc is NOT bound to hide, to avoid fighting the existing UI.
- Subtle CSS fade-in (`.in-app` opacity transition) on show.

## Native styling (`.in-app` overrides in `public/styles.css`)

Added rules, applied only when the `.in-app` class is present (injected by Electron), so browser use is unchanged:
- Make the base background translucent (e.g. `body.in-app { background: rgba(13,16,23,0.72); }`) so the vibrancy blur shows through.
- Round the whole window: `body.in-app { border-radius: 12px; overflow: hidden; }` with a subtle 1px inner border for definition.
- `opacity` transition for fade-in (toggled by an `.in-app.ready` class set shortly after show, or a CSS animation on load).

## Application menu (standard roles)

A frameless window has **no Edit menu**, so ⌘C/⌘V/⌘X/⌘A/⌘Z would not work in the search/composer/edit fields — unacceptable for a paste tool. `electron/main.js` installs a minimal `Menu`:
- **App menu:** About · Hide (⌘H) · Quit (⌘Q).
- **Edit menu:** Undo/Redo · Cut/Copy/Paste/Select All (standard `role`s).
- **Window:** Close (⌘W) → hides the overlay rather than quitting.

This both restores essential shortcuts and adds native polish.

## In-app prompt/confirm (Electron lacks `window.prompt`)

Electron renderers **do not implement `window.prompt`** (it returns null and warns), and the Spaces flows use `prompt()` (new/rename space) and `confirm()` (delete space). So in the desktop app, creating/renaming a space would silently fail. Fix in the web app (benefits the browser too): replace the three `prompt()`/`confirm()` calls in `public/app.js` with a tiny **in-app modal** — a promise-returning `askText(label, initial)` and `askConfirm(message)` rendered as a small centered DOM dialog (reusing the existing palette/overlay styling). Because it's a DOM modal (not a separate native dialog or window), it doesn't trigger the Electron window's `blur`→hide, so it composes correctly with hide-on-blur. The web app stays browser-compatible (the modal is plain DOM).

This adds a small modal to `public/index.html` + `public/styles.css` + helper functions in `public/app.js`, and rewires `runPaletteRow`'s new/rename/delete branches to `await` them.

## Tray (menu bar)

App runs as a macOS **accessory** (`LSUIElement: true` via electron-builder `extendInfo`; `app.dock.hide()` as belt-and-suspenders), so there's no dock icon — the tray is the persistent presence.
- Tray icon embedded as a base64 **template image** data URL via `nativeImage.createFromDataURL(...).setTemplateImage(true)` (no asset file; renders correctly in light/dark menu bars).
- Left-click tray → **show + focus** the overlay (not toggle). Toggling is the hotkey's job; making the tray click "show only" avoids a race where the click's `blur` hides the window and the click handler immediately re-shows it.
- Tray menu: **Show heap** · **Launch at login** (checkbox, reflects/sets `app.getLoginItemSettings().openAtLogin`) · **Quit**.

## Global hotkey — changeable via config

`electron/config.js` owns a tiny JSON config at `userData/config.json`:
- `loadConfig()` → returns `{ hotkey }`, defaulting to `'CommandOrControl+Shift+V'` when the file is missing or corrupt; writes the default file on first run.
- Main registers the accelerator with `globalShortcut.register(cfg.hotkey, toggle)`. If registration returns false (already owned by another app), log it and set the tray tooltip/menu to note the conflict — don't crash.
- Rebinding this phase = edit `config.json` and relaunch (documented). An in-app rebinding UI is out of scope.

`config.js` is pure and **unit-tested** (default-on-missing, reads existing value, tolerates corrupt JSON).

## Lifecycle

- **Single instance:** `app.requestSingleInstanceLock()`; on `second-instance`, toggle/show the existing window instead of starting a new one.
- **Launch at login:** `app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })` set on first run (default on), toggleable from the tray.
- **No quit on window close:** closing/hiding the overlay keeps the app alive in the tray. Quit only via ⌘Q or the tray.
- On `will-quit`, `globalShortcut.unregisterAll()` and close the server.

## Packaging (electron-builder)

`package.json` gains:
- `"main": "electron/main.js"`.
- devDeps: `electron`, `electron-builder`.
- scripts: `"app": "electron ."`, `"dist": "electron-builder"` (keep `"start": "node server.js"` and `"test": "node --test"`).
- `build` block: `appId` (e.g. `io.triplebolt.heap`), `productName: "heap"`, `mac.target: ["dmg"]`, `mac.category`, `mac.extendInfo.LSUIElement: true`, `files: ["server.js","lib/**","public/**","electron/**","package.json"]`, exclude `data/`, `test/`, `docs/`.
- **Unsigned**: no `identity`; first launch needs right-click → Open (Gatekeeper). Documented in README.
- App/.dmg Finder icon uses Electron's default this phase (a custom `.icns` is a follow-up; with no dock icon it's low-visibility). Tray icon is the embedded template image.

## New / changed files

- **Create** `electron/main.js` — lifecycle, server boot, overlay window, vibrancy, tray, global hotkey, application menu, login item, single-instance, focus-return-on-hide.
- **Create** `electron/config.js` — hotkey config load/default/persist (unit-tested).
- **Create** `electron/tray-icon.js` (or inline constant) — base64 template-image data URL for the tray.
- **Create** `test/config.test.js` — `node:test` units for config.
- **Create** `electron/main.js`, `electron/config.js`, tray-icon constant, `test/config.test.js` (above).
- **Modify** `public/styles.css` — `.in-app` native-styling overrides (translucent bg, rounded window, fade-in) + the in-app modal styles.
- **Modify** `public/index.html` — add the in-app modal markup.
- **Modify** `public/app.js` — `askText`/`askConfirm` modal helpers; rewire the new/rename/delete space branches from `prompt()`/`confirm()` to them.
- **Modify** `package.json` — `main`, devDeps, scripts, `build` block.
- **Modify** `README.md` — desktop usage, build/run, Gatekeeper note, hotkey change, data location.
- **Untouched:** `lib/store.js`, `server.js` (behavior unchanged; the `.in-app` class is added by Electron at runtime, not in the HTML).

## Testing

- **Unit (`node:test`):** `electron/config.js` — default when file missing (and writes it), reads an existing hotkey, tolerates corrupt JSON by falling back to default. Existing 23 tests stay green; total grows.
- **Server still standalone:** `node server.js` still works unchanged (sanity).
- **In-app modal (browser-verified):** with the standalone server, drive New/Rename/Delete-space through the new modal via Playwright and confirm they work without `window.prompt` (this is the Electron-blocker that's actually testable in a browser).
- **Electron launch smoke (automated, best-effort):** `npm run app` boots without crashing, the in-process server starts (log line), and the window loads the local URL. Verified by launching with a short auto-quit and checking logs / no error exit.
- **Interactive (user-confirmed):** global hotkey toggles the overlay; blur hides it and focus returns to the prior app; ⌘C/⌘V/⌘A work in fields; tray menu (Show / Launch at login / Quit) works; relaunch persists data; launch-at-login registered. A global hotkey and tray interaction can't be driven from the build sandbox — these are explicitly handed to the user with a checklist, and the report states what was machine-verified vs. needs-hands.

## Success criteria

Hit ⌘⇧V from anywhere → heap fades in centered with a native frosted panel, search focused; type or ⌘V to capture, ⏎ to copy back out; click away or hit ⌘⇧V again → it vanishes and focus snaps back to the app you were in, ready to paste. It's in the menu bar, starts at login, and never shows a dock icon. Building is `npm run dist`.

## Out of scope (KISS)

Code signing / notarization, auto-update, custom `.icns`, in-app hotkey-rebinding UI, Windows/Linux builds, native-clipboard/IPC features beyond what the web app already does, multi-window.
