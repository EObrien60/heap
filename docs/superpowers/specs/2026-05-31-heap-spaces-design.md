# heap v2 — Spaces (context-switching) design

**Date:** 2026-05-31
**Status:** Approved, ready for implementation plan
**Builds on:** heap v1 (zero-dep Node server + vanilla web UI clipboard heap)

## Problem

heap v1 solves *storage* of pasted scratch. But the real pain for a high-velocity, multi-project developer isn't storing text — it's **state reconstruction** when jumping between projects. Each jump loses the *working set*: which DB, the query you keep re-running, the staging URL, the ticket, the branch, and the fragile "what was I about to do" thought. A flat pile doesn't help rebuild that.

## Goal

One goal: **make the jump between contexts faster.** Add exactly one new dimension — *context* — and the minimum UI to switch it, see it, and rebuild head-state in a glance. Ruthless KISS: nothing that turns this into a task manager, wiki, or sync product.

## The model

Add one concept: a **Space** = the kit you need to be productive in one project/context. Exactly one Space is *active* at a time.

```
Space { id, name, color, hints: string[], resumeNote: string, order, createdAt }
Item  { ...v1 fields, spaceId }
State { activeSpaceId }
```

- Every Item belongs to exactly one Space (`spaceId`).
- `activeSpaceId` is persisted server-side, so reopening the tab restores the user where they were.
- On first launch after upgrade, the v1 flat heap auto-migrates into a default Space named **"General"**, which becomes the active Space. No data loss, no manual step.

## Features

### 1. Switch (the most-used action — must be fastest)
- **`⌘K`** opens a fuzzy command palette: type to jump to a Space, or run an action (new Space, rename Space, delete Space, toggle search-all).
- **`1`–`9`** snap instantly to the Space at that `order` position.
- Active Space shown as a **colored chip** in the top bar; clicking it also opens the palette.
- Switching re-filters the entire heap to the active Space instantly.

### 2. Resume line
- Each Space has one editable **`▸ where I left off`** line, pinned at the very top of the Space view.
- Click to edit, `Enter` saves, `Esc` cancels. Empty state prompts: *"what are you in the middle of?"*
- One line of free text. Explicitly **not** a task list.

### 3. Anchors
- Pinned items in the active Space render first under an **Anchors** header (the always-there staging URL, connection string, the query you re-run).
- Everything else renders under a **Recent** header.
- Pinning (existing `p` / ★) is how an item joins the kit. Headers only appear when both groups are non-empty; otherwise the list renders plain.

### 4. Capture + "move?" nudge
- New pastes land silently in the **active** Space (zero capture friction — the whole point).
- After a **text** item is created, the server checks its content+title against every *other* Space's `hints` using word-boundary, case-insensitive matching. Each Space's name auto-seeds its hints; the user can add more (repo name, db name, ticket prefix).
- If the best-matching other Space has ≥1 hint match, the API returns `suggestedSpace: {id, name}`. The new card shows a dismissable **`↪ <Space>? move`** chip. One click moves the item (PATCH `spaceId`). No chip when there's no match.
- Image items are not matched (no text to match on).

### 5. Search
- Defaults to the **active Space**.
- A toggle — button in the search bar, `⌘\` shortcut, or a leading `!` in the query — flips to **all Spaces**.
- In all-Spaces results, each card shows its Space chip so contexts stay distinguishable.

### 6. Click behavior
- Unchanged from v1: **click copies** every item (preserves muscle memory).
- `url` items gain a small **↗ open** button that opens the URL in a new tab. Copy remains the click default and is still available via the copy button.

## API changes

Storage shape becomes:
```json
{ "version": 2, "activeSpaceId": "<id>", "spaces": [ ... ], "items": [ ... ] }
```

Endpoints:
- `GET /api/spaces` → all spaces (ordered).
- `POST /api/spaces` → `{name, color?}`; auto-seeds `hints` with name tokens, assigns `order`, returns the space.
- `PATCH /api/spaces/:id` → any of `name`, `color`, `hints`, `resumeNote`, `order`.
- `DELETE /api/spaces/:id` → reassigns its items to the next remaining Space (first by `order`, excluding the one being deleted); items are never orphaned or destroyed. Refuses to delete the last remaining Space. If the deleted Space was active, the active Space becomes the reassignment target.
- `GET /api/state` → `{activeSpaceId}`.
- `PATCH /api/state` → `{activeSpaceId}`.
- `POST /api/items` → accepts optional `spaceId` (defaults to active); for text items, computes and returns `suggestedSpace` when a hint match exists.
- `GET /api/items?space=<id>&all=0|1&q=<query>` → `all=1` ignores `space` and searches every Space (each item view includes its `spaceId`/space name for chip rendering).
- `PATCH /api/items/:id` → existing fields plus `spaceId` (move between Spaces).
- `DELETE /api/items/:id` → unchanged.

**Migration on load:** if `heap.json` parses to a bare array (v1), wrap it: create the General Space, set every item's `spaceId` to General, set `activeSpaceId` to General, set `version: 2`, persist atomically. Idempotent — already-v2 files load unchanged.

## Files touched

- `server.js` — v2 storage shape, v1→v2 migration, space CRUD, `/api/state`, `spaceId` on items, search scope (`space`/`all`), `suggestedSpace` computation, delete-space reassignment.
- `public/index.html` — command palette overlay, resume bar, active-Space chip, search-scope toggle.
- `public/app.js` — spaces state, palette + fuzzy match, `1`–`9` switching, resume bar edit, search scope toggle + space chips on results, move-nudge chip, anchors/recent grouping, url ↗ open.
- `public/styles.css` — palette, resume bar, space chips, anchors header, nudge chip.
- `README.md` — document Spaces, switching keys, search scope.

`app.js` will grow notably. If it crosses ~600 lines or responsibilities tangle, split into small ES modules loaded via `<script type="module">` (no bundler needed) — but only if it genuinely improves clarity, not preemptively.

## Designed-for-but-not-built

**Auto-switch from shell.** The `spaceId` + `hints` model and the `PATCH /api/state {activeSpaceId}` endpoint are built so a future opt-in shell hook can report `cwd`/git-repo and switch the active Space automatically — with zero rework. We do **not** build any shell watching, daemon, or hook now.

## Explicitly out of scope

Tags beyond Space; templates/variable substitution; cross-machine sync; collaboration/sharing; time tracking; any "AI summarize my day." Each is a different product and violates the one-goal rule.

## Verification

**API tests (curl/node, as in v1):**
- v1 bare-array file migrates to v2 with all items assigned to General.
- Create Space; auto-seeded hints include the name.
- Paste lands in active Space.
- Paste whose content matches another Space's hint returns `suggestedSpace`; non-matching paste does not.
- `GET /api/items` scoped to active Space vs `all=1` global.
- Move item between Spaces via PATCH.
- Delete Space reassigns its items to the next remaining Space; cannot delete the last Space; deleting the active Space moves active to the reassignment target.
- `resumeNote` and `activeSpaceId` persist across restart.

**Browser smoke (Playwright):**
- `⌘K` palette switches Space; `1`–`9` quick keys switch.
- Resume bar edits and persists.
- Search-scope toggle flips active ↔ all, chips appear on global results.
- Move-nudge chip appears on a matching paste and moves the item.
- `url` ↗ open button present.

## Success criteria

A multi-project dev can: paste into the right context without thinking, switch their entire working set in one keystroke, glance at one line to remember where they were, and find anything across all contexts on demand — all without the tool ever feeling heavier than the v1 heap.
