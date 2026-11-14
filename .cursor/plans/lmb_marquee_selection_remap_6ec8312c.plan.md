---
name: LMB marquee selection remap
overview: Reserve canvas panning for middle-mouse drag and make left-drag on the background draw a selection marquee (Shift = additive), matching typical 2D canvas apps.
todos:
  - id: remap-pointer-modes
    content: "interaction.ts: LMB background always starts marquee, MMB stays pan; move click-to-clear to marquee mode (skip when Shift); clear marquee on pointercancel; update comments"
    status: completed
  - id: update-readme-controls
    content: "README.md: update Direct manipulation bullet and Controls table for MMB pan / LMB marquee"
    status: completed
  - id: verify-build-and-smoke
    content: Run npm run build and lint:check; smoke-test marquee select, additive Shift-marquee, click-to-clear, MMB pan, card drag, and Esc cancel in dev Zotero
    status: completed
isProject: false
---

# LMB marquee selection, MMB-only pan

## Target behavior
- LMB drag on empty background: selection marquee; replaces selection, Shift-marquee adds to it.
- LMB click on background (no drag): clears selection (Shift-click keeps it).
- MMB drag: pan — the only pan gesture.
- Unchanged: LMB on a card selects/moves it (Shift-click toggles, region drag carries members), wheel zoom, double-click open, Esc/Delete/Ctrl+A.

No renderer changes needed — marquee drawing already exists in [render2d.ts](src/modules/render2d.ts) and `scene.select(hits, additive)` already supports additive marquee commits.

## Changes

### 1. [src/modules/interaction.ts](src/modules/interaction.ts)
- `onPointerDown` background branch (lines 136–144): always enter marquee mode for LMB; drop the Shift-only gating and the `moved = true` pre-set:

```typescript
if (!node) {
  // Background: drag draws a selection marquee (Shift adds to the
  // selection). A plain click (no movement) clears selection on release.
  this.mode = "marquee";
  return;
}
```

- `onPointerUp` (lines 241–243): move the click-to-clear behavior from `pan` to `marquee` mode, guarded so Shift-click does not clear:

```typescript
if (wasMode === "marquee" && !moved && ev.button === 0 && !ev.shiftKey) {
  this.scene.clearSelection();
}
```

  The existing marquee-commit block (lines 247–258) stays as-is: it already passes `ev.shiftKey` as the additive flag and ignores degenerate rects.
- `pointercancel` handler (line 83): also null `renderer.marquee` and `requestDraw()` so a canceled drag never leaves a stale rectangle on screen (marquee is now the primary LMB gesture).
- Update the file header comment (lines 3–5) and the "Middle-drag always pans" comment to describe the new mapping.

### 2. [README.md](README.md)
- "Direct manipulation" bullet (line 26): pan with middle-drag; marquee-select by dragging the background (Shift to add).
- Controls table (lines 57–60): replace `Drag background → Pan` with `Middle-drag → Pan` and `Drag background → Marquee select (Shift adds)`; keep the Shift-click row.

## Verification
- `npm run build` (includes `tsc --noEmit`) and `npm run lint:check`.
- Manual smoke in a dev Zotero (`npm start`): plain LMB marquee selects intersecting cards; Shift-marquee adds; plain background click clears; MMB drag pans; card drag still moves the selection; Esc cancels an in-flight marquee; no leftover marquee after cancel.