# Zotero Spatial Workspace

Organize your folders, papers, and notes in a 2D/3D spatial environment.

[![zotero target version](https://img.shields.io/badge/Zotero-8--11-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)

Spatial Workspace adds a dedicated board tab to Zotero where your library
becomes a spatial canvas: collections appear as folder regions, papers as
cards, and notes as sticky cards linked to their parent paper. Drag things
where they make sense to you. The board is a **view overlay** — your Zotero
collections and items are never modified.

This is v0.1: a fast 2D board. The scene model is renderer-agnostic so a 3D
view can be added in a later release.

## Features

- **Spatial board tab** — open from Tools → Open Spatial Workspace, the item
  context menu, or `Ctrl+Shift+W` (`Cmd+Shift+W` on macOS).
- **Pop-out window** — use the toolbar **Pop out** button (or Tools → Open
  Spatial Workspace in Window) to place the board beside the library so you
  can drag papers onto it. **Dock** returns it to a tab.
- **Folders, papers, notes** — collections render as labeled regions, regular
  items as cards (title, creator, year), notes as yellow sticky cards with a
  link line to their parent.
- **Direct manipulation** — pan with middle-drag, zoom at the cursor with the
  wheel, marquee-select by dragging the background (Shift to add), drag cards
  (Shift-click toggles), double-click a card to open the item in Zotero.
- **Add from the library** — drag items onto the board (best with the pop-out
  window beside the library), or select items and right-click → "Add to
  Spatial Workspace". Dropped items land at the drop point; context-menu adds
  land near the current view.
- **Temporary filters** — a toolbar search box hides non-matching cards
  without moving anything; clearing it restores the board exactly.
  Query terms: bare words (title/creator/type), `title:`, `author:`,
  `type:`, `kind:item|note|collection`, and date terms `added:`,
  `modified:`, `read:` with comparisons (`added:>2024-01-01`,
  `read:>7d`, `added:never`, `read:any`). Relative dates: `d`/`w`/`m`/`y`,
  `today`. `Ctrl/Cmd+F` focuses the box, `Esc` clears the filter.
  "Read" matches Zotero's Last Read column (newest attachment read time).
- **Auto-arrange & zoom-to-fit** — toolbar buttons lay cards out in tidy grids
  inside their folder regions, or fit the whole board in view (with a filter
  active, Fit frames only the matches).
- **Persistent layout** — positions, regions, and camera are saved per library
  under `<Zotero data directory>/spatialworkspace/layout-<libraryID>.json`
  (debounced, atomic writes) and restored on startup.
- **Live sync** — renames, new items, trashing, and deletions in Zotero update
  the board automatically.
- **Performance** — a single Canvas2D surface with viewport culling, a spatial
  hash for hit-testing, level-of-detail labels, and dirty-flag rendering.
  Handles 10k+ nodes without an idle render loop.

## Controls

| Input             | Action                                             |
| ----------------- | -------------------------------------------------- |
| Middle-drag       | Pan                                                |
| Drag background   | Marquee select (Shift adds)                        |
| Mouse wheel       | Zoom at cursor                                     |
| Drag card         | Move card(s)                                       |
| Shift-click       | Toggle multi-select                                |
| Double-click card | Open item in Zotero                                |
| Delete            | Remove selection from board (items stay in Zotero) |
| Esc               | Clear filter (if active) and selection             |
| Ctrl/Cmd+F        | Focus the filter box                               |
| Ctrl/Cmd+Shift+W  | Open/focus the board                               |

Toolbar: auto-arrange, zoom-to-fit, toggle notes, pop out / dock, temporary
filter box.

Preferences (Settings → Spatial Workspace): autosave delay, show notes,
label detail.

## Development

Requires Node.js LTS and a Zotero 8+ installation (developed against 10.x).

```powershell
cp .env.example .env   # then set binary + dev profile paths
npm install
npm start              # or .\dev.ps1
npm run build          # production build + type check -> .scaffold/build/*.xpi
```

`npm start` launches an isolated dev profile with hot reload. The board layout
lives in the Zotero **data** directory, so it survives profile resets.

Architecture (all under `src/modules/`):

- `scene.ts` — renderer-agnostic scene store (nodes, regions, spatial hash,
  dirty flags, temporary visibility filter). The seam for a future
  `render3d.ts`.
- `filter.ts` — pure filter query parser/matcher (title, kind, added /
  modified / read dates); no Zotero dependencies.
- `persistence.ts` — per-library JSON layout, debounced atomic saves.
- `data.ts` — Zotero → scene bridge with notifier-driven live sync.
- `render2d.ts` — Canvas2D renderer (culling, LOD, cached text metrics).
- `interaction.ts` — pan/zoom/drag/select/open input handling.
- `commands.ts` — menus, shortcut, board tab/window lifecycle, toolbar actions.

## License

AGPL-3.0-or-later (from the Zotero plugin template).
