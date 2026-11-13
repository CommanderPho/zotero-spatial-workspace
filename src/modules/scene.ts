/**
 * Renderer-agnostic spatial scene model.
 *
 * The scene owns node geometry, selection, and a uniform-grid spatial hash
 * used for hit-testing and viewport culling. It knows nothing about Canvas2D
 * or WebGL: a future 3D renderer can consume the same nodes (z is reserved
 * for that) and the same dirty-flag protocol.
 */

import {
  EMPTY_FILTER,
  nodeMatchesFilter,
  regionNameMatchesFilter,
  type NodeFilter,
} from "./filter";

export type NodeKind = "collection" | "item" | "note";

export interface SceneNode {
  /** Stable id: `c<collectionID>`, `i<itemID>`, or `n<itemID>`. */
  id: string;
  kind: NodeKind;
  /** Zotero item/collection id. */
  zoteroID: number;
  libraryID: number;
  x: number;
  y: number;
  /** Reserved for the future 3D view; always 0 in 2D. */
  z: number;
  w: number;
  h: number;
  /** Region membership: collection nodes own a region, items/notes may sit in one. */
  parentRegionID?: string;
  /** For notes: the scene id of the parent item node. */
  linkID?: string;
  title: string;
  subtitle?: string;
  /** Item type name or note marker, used for card accents. */
  badge?: string;
  /** Zotero dateAdded, epoch ms. Undefined when unknown. */
  added?: number;
  /** Zotero dateModified, epoch ms. Undefined when unknown. */
  modified?: number;
  /**
   * Last read time, epoch ms: max attachmentLastRead over the item's
   * attachments (Zotero's "Last Read" column). Undefined = never read.
   */
  read?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Camera {
  /** World coordinate at the viewport center. */
  x: number;
  y: number;
  /** Pixels per world unit. */
  zoom: number;
}

export const CARD_W = 220;
export const CARD_H = 92;
export const NOTE_W = 180;
export const NOTE_H = 76;
export const REGION_PAD = 24;
export const REGION_HEADER = 34;

const CELL_SIZE = 512;

function cellKey(cx: number, cy: number): string {
  return cx + ":" + cy;
}

/**
 * Uniform-grid spatial hash over node AABBs. Rebuilt lazily when nodes move;
 * queries are O(cells covered) instead of O(all nodes).
 */
export class SpatialHash {
  private cells = new Map<string, Set<string>>();
  private nodeCells = new Map<string, string[]>();

  clear(): void {
    this.cells.clear();
    this.nodeCells.clear();
  }

  insert(node: SceneNode): void {
    this.remove(node.id);
    const keys: string[] = [];
    const x0 = Math.floor(node.x / CELL_SIZE);
    const y0 = Math.floor(node.y / CELL_SIZE);
    const x1 = Math.floor((node.x + node.w) / CELL_SIZE);
    const y1 = Math.floor((node.y + node.h) / CELL_SIZE);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = new Set();
          this.cells.set(key, bucket);
        }
        bucket.add(node.id);
        keys.push(key);
      }
    }
    this.nodeCells.set(node.id, keys);
  }

  remove(id: string): void {
    const keys = this.nodeCells.get(id);
    if (!keys) {
      return;
    }
    for (const key of keys) {
      const bucket = this.cells.get(key);
      if (bucket) {
        bucket.delete(id);
        if (bucket.size === 0) {
          this.cells.delete(key);
        }
      }
    }
    this.nodeCells.delete(id);
  }

  /** Ids of nodes whose AABB intersects the rect (candidates, not exact). */
  query(rect: Rect): string[] {
    const out = new Set<string>();
    const x0 = Math.floor(rect.x / CELL_SIZE);
    const y0 = Math.floor(rect.y / CELL_SIZE);
    const x1 = Math.floor((rect.x + rect.w) / CELL_SIZE);
    const y1 = Math.floor((rect.y + rect.h) / CELL_SIZE);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const bucket = this.cells.get(cellKey(cx, cy));
        if (bucket) {
          for (const id of bucket) {
            out.add(id);
          }
        }
      }
    }
    return [...out];
  }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

export function pointInRect(px: number, py: number, r: Rect): boolean {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
}

export class SceneStore {
  readonly nodes = new Map<string, SceneNode>();
  readonly selection = new Set<string>();
  readonly hash = new SpatialHash();
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  libraryID = 0;
  /** Bumped on any change; renderers use it as a dirty flag. */
  revision = 0;
  /**
   * Temporary visibility filter (view state only, never persisted).
   * Empty filter = everything visible.
   */
  filter: NodeFilter = EMPTY_FILTER;
  /**
   * Ids hidden by the active filter. Maintained by setFilter()/reset();
   * membership tests are O(1) for the renderer, hit-testing, and queries.
   */
  private hidden = new Set<string>();

  private listeners = new Set<() => void>();

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.revision++;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Replace all nodes (library load / layout restore). Clears the filter. */
  reset(nodes: SceneNode[], libraryID: number): void {
    this.nodes.clear();
    this.selection.clear();
    this.hash.clear();
    this.libraryID = libraryID;
    this.filter = EMPTY_FILTER;
    this.hidden.clear();
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      this.hash.insert(node);
    }
    this.emit();
  }

  /**
   * Apply (or clear, with an inactive filter) the temporary visibility
   * filter. Hidden nodes keep their positions and stay in the scene;
   * they are skipped by rendering, hit-testing, and rect queries.
   *
   * Rules: items/notes must match every term. A region stays visible when
   * its own name matches or it has at least one matching member; regions
   * never reveal non-matching members.
   */
  setFilter(filter: NodeFilter): number {
    this.filter = filter;
    this.hidden.clear();
    let visibleCount = 0;
    if (filter.active) {
      const regionHasMatch = new Set<string>();
      for (const node of this.nodes.values()) {
        if (node.kind === "collection") {
          continue;
        }
        if (nodeMatchesFilter(node, filter)) {
          visibleCount++;
          if (node.parentRegionID) {
            regionHasMatch.add(node.parentRegionID);
          }
        } else {
          this.hidden.add(node.id);
        }
      }
      for (const node of this.nodes.values()) {
        if (
          node.kind === "collection" &&
          !regionHasMatch.has(node.id) &&
          !regionNameMatchesFilter(node, filter)
        ) {
          this.hidden.add(node.id);
        }
      }
      // Selection must not reference invisible nodes.
      for (const id of [...this.selection]) {
        if (this.hidden.has(id)) {
          this.selection.delete(id);
        }
      }
    } else {
      for (const node of this.nodes.values()) {
        if (node.kind !== "collection") {
          visibleCount++;
        }
      }
    }
    this.emit();
    return visibleCount;
  }

  /** True when the node is currently hidden by the filter. */
  isHidden(id: string): boolean {
    return this.hidden.has(id);
  }

  /** Number of nodes hidden by the active filter. */
  get hiddenCount(): number {
    return this.hidden.size;
  }

  upsert(node: SceneNode): void {
    this.nodes.set(node.id, node);
    this.hash.insert(node);
    if (this.filter.active && node.kind === "collection") {
      this.setFilter(this.filter);
    } else {
      this.refreshHidden(node);
    }
    this.emit();
  }

  upsertMany(nodes: SceneNode[]): void {
    let hasRegion = false;
    const touchedRegions = new Set<string>();
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      this.hash.insert(node);
      hasRegion ||= node.kind === "collection";
      this.refreshHidden(node, touchedRegions);
    }
    if (this.filter.active && hasRegion) {
      this.setFilter(this.filter);
    } else {
      for (const regionID of touchedRegions) {
        this.refreshRegionHidden(regionID);
      }
    }
    this.emit();
  }

  /** Re-evaluate the active filter after in-place node edits. */
  refreshFilter(): void {
    if (this.filter.active) {
      this.setFilter(this.filter);
    }
  }

  /**
   * Keep filter visibility consistent when a non-region node changes.
   * `touchedRegions` defers region re-evaluation to the caller (bulk path).
   */
  private refreshHidden(node: SceneNode, touchedRegions?: Set<string>): void {
    if (!this.filter.active || node.kind === "collection") {
      return;
    }
    if (nodeMatchesFilter(node, this.filter)) {
      this.hidden.delete(node.id);
    } else {
      this.hidden.add(node.id);
      this.selection.delete(node.id);
    }
    if (node.parentRegionID) {
      if (touchedRegions) {
        touchedRegions.add(node.parentRegionID);
      } else {
        this.refreshRegionHidden(node.parentRegionID);
      }
    }
  }

  /** A region stays visible while its name or any member matches. */
  private refreshRegionHidden(regionID: string): void {
    const region = this.nodes.get(regionID);
    if (!region || region.kind !== "collection") {
      return;
    }
    let memberMatched = false;
    for (const node of this.nodes.values()) {
      if (
        node.kind !== "collection" &&
        node.parentRegionID === regionID &&
        !this.hidden.has(node.id)
      ) {
        memberMatched = true;
        break;
      }
    }
    if (memberMatched || regionNameMatchesFilter(region, this.filter)) {
      this.hidden.delete(regionID);
    } else {
      this.hidden.add(regionID);
      this.selection.delete(regionID);
    }
  }

  remove(id: string): void {
    if (!this.nodes.delete(id)) {
      return;
    }
    this.hash.remove(id);
    this.selection.delete(id);
    this.hidden.delete(id);
    this.emit();
  }

  removeMany(ids: string[]): void {
    let changed = false;
    for (const id of ids) {
      if (this.nodes.delete(id)) {
        this.hash.remove(id);
        this.selection.delete(id);
        this.hidden.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  /** Batch move without per-node emits (drag). Call endBatch() after. */
  moveSilent(id: string, x: number, y: number): void {
    const node = this.nodes.get(id);
    if (!node) {
      return;
    }
    node.x = x;
    node.y = y;
    this.hash.insert(node);
    this.revision++;
  }

  endBatch(): void {
    this.emit();
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
    this.revision++;
  }

  select(ids: string[], additive = false): void {
    if (!additive) {
      this.selection.clear();
    }
    for (const id of ids) {
      if (this.nodes.has(id) && !this.hidden.has(id)) {
        this.selection.add(id);
      }
    }
    this.emit();
  }

  toggleSelect(id: string): void {
    if (this.selection.has(id)) {
      this.selection.delete(id);
    } else if (this.nodes.has(id) && !this.hidden.has(id)) {
      this.selection.add(id);
    }
    this.emit();
  }

  clearSelection(): void {
    if (this.selection.size === 0) {
      return;
    }
    this.selection.clear();
    this.emit();
  }

  /** Topmost visible node at a world point (notes/items above regions). */
  hitTest(x: number, y: number): SceneNode | undefined {
    const candidates = this.hash.query({ x, y, w: 0, h: 0 });
    let best: SceneNode | undefined;
    for (const id of candidates) {
      const node = this.nodes.get(id);
      if (!node || this.hidden.has(id) || !pointInRect(x, y, node)) {
        continue;
      }
      if (!best || rank(node) > rank(best)) {
        best = node;
      }
    }
    return best;
  }

  /**
   * Visible nodes whose AABB intersects a world rect, filtered to exact
   * overlap. Hidden nodes are skipped unless `includeHidden` is set
   * (layout/collision code needs the full board).
   */
  queryRect(rect: Rect, includeHidden = false): SceneNode[] {
    const out: SceneNode[] = [];
    for (const id of this.hash.query(rect)) {
      const node = this.nodes.get(id);
      if (
        node &&
        (includeHidden || !this.hidden.has(id)) &&
        rectsIntersect(node, rect)
      ) {
        out.push(node);
      }
    }
    return out;
  }

  /**
   * Bounding box of visible nodes (regions included), or null when empty.
   * With a filter active, zoom-to-fit frames only the matches.
   */
  bounds(): Rect | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.nodes.values()) {
      if (this.hidden.has(node.id)) {
        continue;
      }
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.w);
      maxY = Math.max(maxY, node.y + node.h);
    }
    if (!Number.isFinite(minX)) {
      return null;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** Recompute every collection region to enclose its member cards. */
  recomputeRegions(): void {
    const members = new Map<string, SceneNode[]>();
    for (const node of this.nodes.values()) {
      if (node.kind !== "collection" && node.parentRegionID) {
        const list = members.get(node.parentRegionID) ?? [];
        list.push(node);
        members.set(node.parentRegionID, list);
      }
    }
    for (const node of this.nodes.values()) {
      if (node.kind !== "collection") {
        continue;
      }
      const list = members.get(node.id);
      if (!list || list.length === 0) {
        node.w = CARD_W + REGION_PAD * 2;
        node.h = CARD_H + REGION_PAD * 2 + REGION_HEADER;
      } else {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const m of list) {
          minX = Math.min(minX, m.x);
          minY = Math.min(minY, m.y);
          maxX = Math.max(maxX, m.x + m.w);
          maxY = Math.max(maxY, m.y + m.h);
        }
        node.x = minX - REGION_PAD;
        node.y = minY - REGION_PAD - REGION_HEADER;
        node.w = maxX - minX + REGION_PAD * 2;
        node.h = maxY - minY + REGION_PAD * 2 + REGION_HEADER;
      }
      this.hash.insert(node);
    }
    this.emit();
  }
}

function rank(node: SceneNode): number {
  switch (node.kind) {
    case "note":
      return 3;
    case "item":
      return 2;
    case "collection":
      return 1;
  }
}
