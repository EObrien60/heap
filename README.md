# heap 📥

A fast, light scratch store for the stuff you constantly paste in and out — SQL queries, variables, messages, bug reports, images. Replaces the "dump everything in Notes" workflow with something instant and keyboard-driven.

Runs two ways: a **desktop app** (macOS, summoned by a global hotkey) or a plain **local web app** (zero dependencies). The core (server + web UI) has no dependencies; only the desktop build uses Electron.

## Desktop app (macOS)

A Spotlight-style frosted overlay that lives in the menu bar, summoned with a global hotkey (default **⌘⇧V**). No dock icon. Starts at login.

```bash
npm install        # one-time: pulls Electron + electron-builder
npm run app        # run it
npm run dist       # build heap.app + a .dmg into dist/
```

- **⌘⇧V** toggles the overlay (search auto-focused). Click away or hit it again to dismiss — focus snaps back to wherever you were, so you can paste immediately.
- The **menu-bar tray** has Show heap · Launch at login · Quit.
- **Unsigned build:** the first time you open `heap.app`, right-click it → **Open** to get past Gatekeeper (once).
- **Change the hotkey:** edit `~/Library/Application Support/heap/config.json` (`{"hotkey": "CommandOrControl+Shift+V"}` — any [Electron accelerator](https://www.electronjs.org/docs/latest/api/accelerator)) and relaunch.
- Desktop data lives in `~/Library/Application Support/heap/data/`.

## Web app

```bash
node server.js
```

Opens `http://localhost:4321` in your browser. Pin the tab and leave it.

Custom port: `PORT=5000 node server.js`. Don't auto-open: `NO_OPEN=1 node server.js`.

Run tests: `npm test`.

## How to use

- **Paste in** — `⌘V` anywhere in the tab drops text or an image straight onto the heap. Or type in the composer and hit `⌘↵`. Or drag an image in.
- **Search** — hit `/`, type. Filters everything in the active Space as you type.
- **Copy back out** — click any item (or select + `↵`) to copy it. Images copy as images.
- **Organize** — pin (`p` / ★) keeps things on top; edit text (`e`); delete (`⌫`).

## Spaces

A **Space** is a per-project context — a named bucket that keeps its own items, resume line, anchors, and keywords. Only one Space is active at a time; every new paste lands there and the heap view re-filters to that Space when you switch.

### Switching Spaces

- **`⌘K`** — opens the command palette. Fuzzy-jump to any Space, or run a command: **New space**, **Rename** the active Space, or **Delete** it (its items move to another Space — you can't delete your last one).
- **`⌘1`–`⌘9`** — jump instantly to your first nine Spaces (works even while the search box is focused, like browser tabs; bare `1`–`9` also works when you're not typing).
- The active Space shows as a colored chip in the top bar — click it to open the palette too.

### Resume line

Each Space has a single editable **"▸ where I left off"** line sitting just under the composer. Click it, type your note, hit `↵` to save or `Esc` to cancel. It's one line, not a task list — a quick breadcrumb so you remember where you were when you switch back.

### Anchors

Pin an item (`p` / ★) and it moves to the **Anchors** section at the top of the heap — always-there URLs, credentials, queries, or anything you need to grab repeatedly. Everything else appears under **Recent**.

### Move nudge

Each Space has a set of **keywords** (the Space name auto-seeds them; you can add more). When you paste something whose content matches another Space's keywords, a **↪ \<Space\>? move** chip appears on that card. One click moves the item to the suggested Space. No drag-and-drop required.

### Search scope

Search defaults to the **active Space**. Hit **`⌘\`** (or click the **all** toggle in the search bar) to search across every Space — results show a space tag so you know where each item lives.

### Keys

| Key | Action |
|-----|--------|
| `/` | focus search |
| `↑ ↓` / `j k` | move selection |
| `↵` | copy selected |
| `p` | pin / unpin |
| `e` | edit (text items) |
| `⌫` | delete |
| `⌘V` | paste into heap |
| `⌘↵` | save composer / edit |
| `Esc` | clear selection / cancel edit |
| `⌘K` | command palette (spaces) |
| `⌘1`–`⌘9` | jump to Space by index (also bare `1`–`9` when not typing) |
| `⌘\` | toggle all-spaces search |

## Type detection

Items are auto-tagged as `sql`, `json`, `url`, `code`, `image`, or `text`, with light syntax coloring for SQL and JSON.

## Storage

- `data/heap.json` — all text items + metadata, in v2 shape `{version, activeSpaceId, spaces, items}` (atomic writes)
- `data/images/` — pasted images

A **v1 file** (bare JSON array from an older heap) is migrated automatically on first launch into a default **"General"** Space — no manual steps needed.

Back it up by copying `data/`. Delete it to start fresh.
