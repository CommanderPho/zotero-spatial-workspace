/**
 * Zotero -> scene bridge.
 *
 * Builds scene nodes from collections, regular items, and notes (metadata
 * only), keeps them in sync through Zotero notifier events, and prunes
 * deleted items. The bridge never modifies Zotero data: the board is a view
 * overlay.
 */

import {
  CARD_H,
  CARD_W,
  NOTE_H,
  NOTE_W,
  REGION_HEADER,
  REGION_PAD,
  type Camera,
  type Rect,
  type SceneNode,
  type SceneStore,
} from "./scene";
import { applyLayout, type LayoutStore } from "./persistence";
import { computeLayout, findFreeSpot, GRID_GAP } from "./layout";

const CHUNK = 250;

export function collectionNodeID(id: number): string {
  return `c${id}`;
}

export function itemNodeID(id: number): string {
  return `i${id}`;
}

export function noteNodeID(id: number): string {
  return `n${id}`;
}

export class DataBridge {
  private scene: SceneStore;
  private layout: LayoutStore;
  private onSceneChanged: () => void;
  private notifierID?: string;
  private loading = false;

  constructor(
    scene: SceneStore,
    layout: LayoutStore,
    onSceneChanged: () => void,
  ) {
    this.scene = scene;
    this.layout = layout;
    this.onSceneChanged = onSceneChanged;
  }

  registerNotifier(): void {
    const callback = {
      notify: async (
        event: string,
        type: string,
        ids: number[] | string[],
        extraData: { [key: string]: any },
      ) => {
        if (!addon?.data.alive) {
          this.unregisterNotifier();
          return;
        }
        await addon.hooks.onNotify(event, type, ids, extraData);
      },
    };
    this.notifierID = Zotero.Notifier.registerObserver(callback, [
      "item",
      "collection",
    ]);
    Zotero.Plugins.addObserver({
      shutdown: ({ id }) => {
        if (id === addon.data.config.addonID) {
          this.unregisterNotifier();
        }
      },
    });
  }

  unregisterNotifier(): void {
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = undefined;
    }
  }

  /** Load (or reload) the whole library into the scene. */
  async loadLibrary(libraryID: number): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;
    try {
      const nodes = await this.buildNodes(libraryID);
      const saved = await this.layout.load(libraryID);
      const camera = applyLayout(nodes, saved);
      this.scene.reset(nodes, libraryID);
      this.scene.recomputeRegions();
      if (camera) {
        this.scene.setCamera(camera);
      } else {
        this.scene.setCamera(defaultCamera(this.scene));
      }
      this.onSceneChanged();
    } finally {
      this.loading = false;
    }
  }

  private async buildNodes(libraryID: number): Promise<SceneNode[]> {
    const nodes: SceneNode[] = [];
    const collections = Zotero.Collections.getByLibrary(libraryID);
    const regionOf = new Map<number, string>();
    const regionNodes = new Map<string, SceneNode>();

    // Collection regions; computeLayout() sizes each region around its
    // members and packs them without overlap.
    for (const collection of collections) {
      const regionID = collectionNodeID(collection.id);
      regionOf.set(collection.id, regionID);
      nodes.push({
        id: regionID,
        kind: "collection",
        zoteroID: collection.id,
        libraryID,
        x: 0,
        y: 0,
        z: 0,
        w: CARD_W + REGION_PAD * 2,
        h: CARD_H + REGION_PAD * 2 + REGION_HEADER,
        title: collection.name,
        badge: "collection",
      });
    }

    // Regular items: members of their first collection region, else unfiled.
    const items = await Zotero.Items.getAll(libraryID, true, false);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.isRegularItem()) {
        continue;
      }
      const node = this.itemToNode(item);
      const collectionIDs = item.getCollections();
      const regionID = collectionIDs.length
        ? regionOf.get(collectionIDs[0])
        : undefined;
      if (regionID) {
        node.parentRegionID = regionID;
      }
      nodes.push(node);
      // Yield periodically so huge libraries don't block the UI thread.
      if (i % CHUNK === CHUNK - 1) {
        await Zotero.Promise.delay(0);
      }
    }

    // Notes of placed items; computeLayout() stacks them in a lane reserved
    // beside their parent card.
    const itemNodeByID = new Map(
      nodes.filter((n) => n.kind === "item").map((n) => [n.zoteroID, n]),
    );
    for (const itemNode of itemNodeByID.values()) {
      const item = Zotero.Items.get(itemNode.zoteroID);
      if (!item) {
        continue;
      }
      for (const noteID of item.getNotes()) {
        const note = Zotero.Items.get(noteID);
        if (!note || note.deleted) {
          continue;
        }
        nodes.push(this.noteToNode(note, itemNode));
      }
    }

    computeLayout(nodes);
    return nodes;
  }

  private itemToNode(item: Zotero.Item): SceneNode {
    const year = extractYear(item.getField("date") as string);
    const creator = item.firstCreator || "";
    const subtitle = [creator, year].filter(Boolean).join(" · ");
    return {
      id: itemNodeID(item.id),
      kind: "item",
      zoteroID: item.id,
      libraryID: item.libraryID,
      x: 0,
      y: 0,
      z: 0,
      w: CARD_W,
      h: CARD_H,
      title: item.getDisplayTitle() || String(item.id),
      subtitle,
      badge: item.itemTypeID
        ? Zotero.ItemTypes.getName(item.itemTypeID)
        : undefined,
    };
  }

  private noteToNode(note: Zotero.Item, parent: SceneNode): SceneNode {
    const text = note
      .getNote()
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return {
      id: noteNodeID(note.id),
      kind: "note",
      zoteroID: note.id,
      libraryID: note.libraryID,
      x: 0,
      y: 0,
      z: 0,
      w: NOTE_W,
      h: NOTE_H,
      parentRegionID: parent.parentRegionID,
      linkID: parent.id,
      title: text.slice(0, 140) || "(empty note)",
      badge: "note",
    };
  }

  /** Handle a notifier batch. Only touches nodes of the loaded library. */
  async handleNotify(
    event: string,
    type: string,
    ids: Array<string | number>,
    extraData: { [key: string]: any },
  ): Promise<void> {
    if (this.loading || this.scene.libraryID === 0) {
      return;
    }
    if (type === "item") {
      await this.handleItemNotify(event, ids as number[], extraData);
    } else if (type === "collection") {
      this.handleCollectionNotify(event, ids as number[]);
    }
  }

  private async handleItemNotify(
    event: string,
    ids: number[],
    extraData: { [key: string]: any },
  ): Promise<void> {
    const libraryID = this.scene.libraryID;
    switch (event) {
      case "add": {
        const added: SceneNode[] = [];
        const occupied: Rect[] = [];
        for (const id of ids) {
          const item = Zotero.Items.get(id);
          if (!item || item.libraryID !== libraryID || item.deleted) {
            continue;
          }
          if (item.isNote()) {
            const parent = item.parentItem;
            const parentNode = parent
              ? this.scene.nodes.get(itemNodeID(parent.id))
              : undefined;
            if (parentNode) {
              const node = this.noteToNode(item, parentNode);
              const spot = this.noteSpot(parentNode, added, occupied);
              node.x = spot.x;
              node.y = spot.y;
              added.push(node);
              occupied.push({ x: node.x, y: node.y, w: node.w, h: node.h });
            }
          } else if (item.isRegularItem()) {
            const node = this.itemToNode(item);
            const spot = this.freeSpotNearCamera(0, occupied);
            node.x = spot.x;
            node.y = spot.y;
            added.push(node);
            occupied.push({ x: node.x, y: node.y, w: node.w, h: node.h });
          }
        }
        if (added.length) {
          this.scene.upsertMany(added);
          this.scene.recomputeRegions();
          this.onSceneChanged();
        }
        break;
      }
      case "modify": {
        let changed = false;
        for (const id of ids) {
          const item = Zotero.Items.get(id);
          if (!item || item.libraryID !== libraryID) {
            continue;
          }
          const itemNode = this.scene.nodes.get(itemNodeID(id));
          if (itemNode) {
            const fresh = this.itemToNode(item);
            itemNode.title = fresh.title;
            itemNode.subtitle = fresh.subtitle;
            itemNode.badge = fresh.badge;
            changed = true;
          }
          const noteNode = this.scene.nodes.get(noteNodeID(id));
          if (noteNode && item.isNote()) {
            const parent = item.parentItem;
            const parentNode = parent
              ? this.scene.nodes.get(itemNodeID(parent.id))
              : undefined;
            if (parentNode) {
              const fresh = this.noteToNode(item, parentNode);
              noteNode.title = fresh.title;
              changed = true;
            }
          }
        }
        if (changed) {
          this.scene.endBatch();
          this.onSceneChanged();
        }
        break;
      }
      case "trash": {
        const removed: string[] = [];
        for (const id of ids) {
          removed.push(itemNodeID(id), noteNodeID(id));
          const item = Zotero.Items.get(id);
          if (item && item.isRegularItem()) {
            for (const noteID of item.getNotes(true)) {
              removed.push(noteNodeID(noteID));
            }
          }
        }
        this.scene.removeMany(removed);
        this.scene.recomputeRegions();
        this.onSceneChanged();
        break;
      }
      case "delete": {
        const removed: string[] = [];
        for (const id of ids) {
          removed.push(itemNodeID(id), noteNodeID(id));
        }
        this.scene.removeMany(removed);
        this.scene.recomputeRegions();
        this.onSceneChanged();
        break;
      }
      default:
        break;
    }
  }

  private handleCollectionNotify(event: string, ids: number[]): void {
    const libraryID = this.scene.libraryID;
    switch (event) {
      case "add": {
        const added: SceneNode[] = [];
        const occupied: Rect[] = [];
        for (const id of ids) {
          const collection = Zotero.Collections.get(id);
          if (!collection || collection.libraryID !== libraryID) {
            continue;
          }
          const w = CARD_W + REGION_PAD * 2;
          const h = CARD_H + REGION_PAD * 2 + REGION_HEADER;
          const spot = this.freeSpotNearCamera(0, occupied, w, h);
          added.push({
            id: collectionNodeID(id),
            kind: "collection",
            zoteroID: id,
            libraryID,
            x: spot.x,
            y: spot.y,
            z: 0,
            w,
            h,
            title: collection.name,
            badge: "collection",
          });
          occupied.push({ x: spot.x, y: spot.y, w, h });
        }
        if (added.length) {
          this.scene.upsertMany(added);
          this.onSceneChanged();
        }
        break;
      }
      case "modify": {
        let changed = false;
        for (const id of ids) {
          const collection = Zotero.Collections.get(id);
          const node = this.scene.nodes.get(collectionNodeID(id));
          if (collection && node && collection.libraryID === libraryID) {
            node.title = collection.name;
            changed = true;
          }
        }
        if (changed) {
          this.scene.endBatch();
          this.onSceneChanged();
        }
        break;
      }
      case "trash":
      case "delete": {
        // Keep member cards on the board; they become unfiled.
        const removed = ids.map((id) => collectionNodeID(id));
        for (const node of this.scene.nodes.values()) {
          if (node.parentRegionID && removed.includes(node.parentRegionID)) {
            node.parentRegionID = undefined;
          }
        }
        this.scene.removeMany(removed);
        this.onSceneChanged();
        break;
      }
      default:
        break;
    }
  }

  /** Add existing library items to the board near the current view. */
  addItems(items: Zotero.Item[]): number {
    const added: SceneNode[] = [];
    const occupied: Rect[] = [];
    let index = 0;
    for (const item of items) {
      if (item.libraryID !== this.scene.libraryID || item.deleted) {
        continue;
      }
      if (item.isNote()) {
        const parent = item.parentItem;
        const parentNode = parent
          ? this.scene.nodes.get(itemNodeID(parent.id))
          : undefined;
        if (parentNode && !this.scene.nodes.has(noteNodeID(item.id))) {
          const node = this.noteToNode(item, parentNode);
          const spot = this.noteSpot(parentNode, added, occupied);
          node.x = spot.x;
          node.y = spot.y;
          added.push(node);
          occupied.push({ x: node.x, y: node.y, w: node.w, h: node.h });
        }
        continue;
      }
      if (!item.isRegularItem() || this.scene.nodes.has(itemNodeID(item.id))) {
        continue;
      }
      const node = this.itemToNode(item);
      const spot = this.freeSpotNearCamera(index, occupied);
      node.x = spot.x;
      node.y = spot.y;
      added.push(node);
      occupied.push({ x: node.x, y: node.y, w: node.w, h: node.h });
      index++;
      // Bring along child notes, stacked in the lane beside the card.
      let noteIndex = 0;
      for (const noteID of item.getNotes()) {
        const note = Zotero.Items.get(noteID);
        if (!note || note.deleted || this.scene.nodes.has(noteNodeID(noteID))) {
          continue;
        }
        const noteNode = this.noteToNode(note, node);
        noteNode.x = node.x + CARD_W + GRID_GAP;
        noteNode.y = node.y + noteIndex * (NOTE_H + GRID_GAP / 2);
        added.push(noteNode);
        occupied.push({
          x: noteNode.x,
          y: noteNode.y,
          w: noteNode.w,
          h: noteNode.h,
        });
        noteIndex++;
      }
    }
    if (added.length) {
      this.scene.upsertMany(added);
      this.scene.recomputeRegions();
      this.onSceneChanged();
    }
    return added.length;
  }

  /** Preferred spot near the view center, nudged until collision-free. */
  private freeSpotNearCamera(
    index = 0,
    occupied: Rect[] = [],
    w = CARD_W,
    h = CARD_H,
  ): { x: number; y: number } {
    const cam = this.scene.camera;
    const gx = index % 4;
    const gy = Math.floor(index / 4);
    const preferred = {
      x: cam.x + 60 + gx * (CARD_W + GRID_GAP),
      y: cam.y + 60 + gy * (CARD_H + GRID_GAP),
    };
    return findFreeSpot(this.scene, w, h, preferred, occupied);
  }

  /** Next free slot in the note lane beside a parent card. */
  private noteSpot(
    parent: SceneNode,
    added: SceneNode[],
    occupied: Rect[],
  ): { x: number; y: number } {
    const laneX = parent.x + parent.w + GRID_GAP;
    let y = parent.y;
    for (const node of [...this.scene.nodes.values(), ...added]) {
      if (node.kind === "note" && node.linkID === parent.id) {
        y = Math.max(y, node.y + node.h + GRID_GAP / 2);
      }
    }
    return findFreeSpot(this.scene, NOTE_W, NOTE_H, { x: laneX, y }, occupied);
  }
}

function extractYear(date: string | undefined): string {
  if (!date) {
    return "";
  }
  const match = date.match(/\d{4}/);
  return match ? match[0] : "";
}

function defaultCamera(scene: SceneStore): Camera {
  const bounds = scene.bounds();
  if (!bounds) {
    return { x: 0, y: 0, zoom: 1 };
  }
  return {
    x: bounds.x + bounds.w / 2,
    y: bounds.y + bounds.h / 2,
    zoom: 0.8,
  };
}
