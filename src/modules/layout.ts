/**
 * Deterministic board layout shared by the initial library load and the
 * "Arrange" toolbar action.
 *
 * The previous algorithm placed every region on a fixed-size coarse grid
 * and only afterwards grew regions around their members, so any collection
 * with more than a handful of cards spilled into its neighbours. Notes were
 * stacked to the right of their parent card with no reserved space, landing
 * exactly on top of the next column's cards.
 *
 * This layout sizes each region from its actual content first (a masonry
 * grid: fixed column count, per-column widths with a reserved note lane,
 * per-row heights tall enough for the tallest note stack), then shelf-packs
 * the finished regions using their real widths and heights. Unfiled cards
 * get their own reserved block. Nothing overlaps by construction, and
 * `SceneStore.recomputeRegions()` reproduces the same region rects from the
 * member positions afterwards.
 */

import {
  CARD_H,
  CARD_W,
  NOTE_H,
  NOTE_W,
  REGION_HEADER,
  REGION_PAD,
  rectsIntersect,
  type Rect,
  type SceneNode,
  type SceneStore,
} from "./scene";

export const GRID_GAP = 28;
export const REGION_GAP = 90;
/** Vertical gap between stacked notes of the same parent. */
const NOTE_GAP = GRID_GAP / 2;
/** Maximum columns of cards inside one region. */
const MAX_COLS = 4;

/** A head card (item, or an orphan note) plus the notes stacked beside it. */
interface Entry {
  head: SceneNode;
  notes: SceneNode[];
}

/** A packed block: a collection region, or the unfiled area. */
interface Block {
  region?: SceneNode;
  entries: Entry[];
  w: number;
  h: number;
}

/**
 * Assign non-overlapping positions to every node in place.
 * Regions are sized to their content and shelf-packed; members and notes
 * are placed inside their region; unfiled cards form a trailing block.
 */
export function computeLayout(nodes: SceneNode[]): void {
  const byID = new Map(nodes.map((n) => [n.id, n]));
  const regions = nodes.filter((n) => n.kind === "collection");
  const regionIDs = new Set(regions.map((r) => r.id));

  const notesByParent = new Map<string, SceneNode[]>();
  for (const node of nodes) {
    if (node.kind === "note" && node.linkID && byID.has(node.linkID)) {
      const list = notesByParent.get(node.linkID) ?? [];
      list.push(node);
      notesByParent.set(node.linkID, list);
    }
  }

  // Heads: items, plus notes whose parent card is not on the board.
  const regionEntries = new Map<string, Entry[]>();
  const unfiledEntries: Entry[] = [];
  for (const node of nodes) {
    if (node.kind === "collection") {
      continue;
    }
    if (node.kind === "note" && node.linkID && byID.has(node.linkID)) {
      continue; // placed beside its parent below
    }
    const entry: Entry = {
      head: node,
      notes: notesByParent.get(node.id) ?? [],
    };
    const regionID =
      node.parentRegionID && regionIDs.has(node.parentRegionID)
        ? node.parentRegionID
        : undefined;
    if (regionID) {
      const list = regionEntries.get(regionID) ?? [];
      list.push(entry);
      regionEntries.set(regionID, list);
    } else {
      unfiledEntries.push(entry);
    }
  }
  const blocks: Block[] = regions.map((region) => {
    const entries = regionEntries.get(region.id) ?? [];
    const content = layoutEntries(entries);
    if (entries.length === 0) {
      region.w = CARD_W + REGION_PAD * 2;
      region.h = CARD_H + REGION_PAD * 2 + REGION_HEADER;
    } else {
      region.w = content.w + REGION_PAD * 2;
      region.h = content.h + REGION_PAD * 2 + REGION_HEADER;
    }
    return { region, entries, w: region.w, h: region.h };
  });
  if (unfiledEntries.length) {
    const content = layoutEntries(unfiledEntries);
    blocks.push({ entries: unfiledEntries, w: content.w, h: content.h });
  }

  // Shelf packing with the regions' real sizes: fill a row until the next
  // block would exceed the target width, then start a row below the tallest
  // block of the previous one. Target width keeps the board roughly square.
  const totalArea = blocks.reduce((sum, b) => sum + b.w * b.h, 0);
  const maxW = blocks.reduce((m, b) => Math.max(m, b.w), 0);
  const targetW = Math.max(maxW, Math.ceil(Math.sqrt(totalArea)));
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.w > targetW) {
      x = 0;
      y += rowH + REGION_GAP;
      rowH = 0;
    }
    const padX = block.region ? REGION_PAD : 0;
    const padY = block.region ? REGION_PAD + REGION_HEADER : 0;
    if (block.region) {
      block.region.x = x;
      block.region.y = y;
    }
    for (const entry of block.entries) {
      entry.head.x += x + padX;
      entry.head.y += y + padY;
      for (const note of entry.notes) {
        note.x += x + padX;
        note.y += y + padY;
      }
    }
    x += block.w + REGION_GAP;
    rowH = Math.max(rowH, block.h);
  }
}

/**
 * Masonry grid for one block's entries, relative to (0, 0).
 * Columns reserve a note lane when any card in them has notes; rows are as
 * tall as the tallest card or note stack in them, so nothing spills into
 * the next row or column.
 */
function layoutEntries(entries: Entry[]): { w: number; h: number } {
  if (entries.length === 0) {
    return { w: 0, h: 0 };
  }
  const cols = clamp(Math.ceil(Math.sqrt(entries.length)), 1, MAX_COLS);
  const rows = Math.ceil(entries.length / cols);
  const colW = new Array<number>(cols).fill(0);
  const rowH = new Array<number>(rows).fill(0);
  entries.forEach((entry, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const stackH = noteStackHeight(entry.notes.length);
    const laneW = entry.notes.length ? GRID_GAP + NOTE_W : 0;
    colW[c] = Math.max(colW[c], entry.head.w + laneW);
    rowH[r] = Math.max(rowH[r], entry.head.h, stackH);
  });
  const colX = prefixOffsets(colW, GRID_GAP);
  const rowY = prefixOffsets(rowH, GRID_GAP);
  entries.forEach((entry, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    entry.head.x = colX[c];
    entry.head.y = rowY[r];
    entry.notes.forEach((note, k) => {
      note.x = entry.head.x + entry.head.w + GRID_GAP;
      note.y = entry.head.y + k * (NOTE_H + NOTE_GAP);
    });
  });
  return {
    w: colW.reduce((a, b) => a + b, 0) + (cols - 1) * GRID_GAP,
    h: rowH.reduce((a, b) => a + b, 0) + (rows - 1) * GRID_GAP,
  };
}

function noteStackHeight(count: number): number {
  return count === 0 ? 0 : count * NOTE_H + (count - 1) * NOTE_GAP;
}

function prefixOffsets(sizes: number[], gap: number): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const size of sizes) {
    out.push(acc);
    acc += size + gap;
  }
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * First collision-free spot for a new node, scanning outward from a
 * preferred position in grid steps. Considers everything already on the
 * board (regions included) plus `occupied` rects for nodes placed earlier
 * in the same batch that are not in the scene yet.
 */
export function findFreeSpot(
  scene: SceneStore,
  w: number,
  h: number,
  preferred: { x: number; y: number },
  occupied: Rect[] = [],
): { x: number; y: number } {
  const stepX = w + GRID_GAP;
  const stepY = h + GRID_GAP;
  const isClear = (x: number, y: number): boolean => {
    const rect = { x, y, w, h };
    if (occupied.some((o) => rectsIntersect(rect, o))) {
      return false;
    }
    return scene.queryRect(rect).length === 0;
  };
  if (isClear(preferred.x, preferred.y)) {
    return { x: preferred.x, y: preferred.y };
  }
  for (let ring = 1; ring <= 24; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
          continue;
        }
        const x = preferred.x + dx * stepX;
        const y = preferred.y + dy * stepY;
        if (isClear(x, y)) {
          return { x, y };
        }
      }
    }
  }
  return { x: preferred.x, y: preferred.y };
}
