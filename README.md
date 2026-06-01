# heap 📥

A fast, light scratch store for the stuff you constantly paste in and out — SQL queries, variables, messages, bug reports, images. Replaces the "dump everything in Notes" workflow with something instant and keyboard-driven.

Zero dependencies. Pure Node + a vanilla web UI. Your data lives in `./data/`.

## Run

```bash
node server.js
```

Opens `http://localhost:4321` in your browser (macOS). Pin the tab and leave it.

Custom port: `PORT=5000 node server.js`. Don't auto-open: `NO_OPEN=1 node server.js`.

## How to use

- **Paste in** — `⌘V` anywhere in the tab drops text or an image straight onto the heap. Or type in the composer and hit `⌘↵`. Or drag an image in.
- **Search** — hit `/`, type. Filters everything as you type.
- **Copy back out** — click any item (or select + `↵`) to copy it. Images copy as images.
- **Organize** — pin (`p` / ★) keeps things on top; edit text (`e`); delete (`⌫`).

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

## Type detection

Items are auto-tagged as `sql`, `json`, `url`, `code`, `image`, or `text`, with light syntax coloring for SQL and JSON.

## Storage

- `data/heap.json` — all text items + metadata (atomic writes)
- `data/images/` — pasted images

Back it up by copying `data/`. Delete it to start fresh.
