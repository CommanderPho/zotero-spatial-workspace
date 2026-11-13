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
  type SceneNode,
  type SceneStore,
} from "./scene";
import { applyLayout, type LayoutStore } from "./persistence";

const GRID_GAP = 28;
const REGION_GAP = 90;
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

    // Collection regions, laid out in a coarse grid; positions are refined
    // by recomputeRegions() once members are placed.
    let col = 0;
    const colsPerRow = Math.max(1, Math.ceil(Math.sqrt(collections.length)));
    for (const collection of collections) {
      const regionID = collectionNodeID(collection.id);
      regionOf.set(collection.id, regionID);
      const gx = col % colsPerRow;
      const gy = Math.floor(col / colsPerRow);
      const regionNode: SceneNode = {
        id: regionID,
        kind: "collection",
        zoteroID: collection.id,
        libraryID,
        x: gx * (CARD_W * 3 + REGION_GAP),
        y: gy * (CARD_H * 3 + REGION_GAP),
        z: 0,
        w: CARD_W * 3,
        h: CARD_H * 3,
        title: collection.name,
        badge: "collection",
      };
      nodes.push(regionNode);
      regionNodes.set(regionID, regionNode);
      col++;
    }

    // Regular items: place inside their first collection region, else in
    // the unfiled area to the right of the region grid.
    const items = await Zotero.Items.getAll(libraryID, true, false);
    const memberCount = new Map<string, number>();
    let unfiled = 0;
    const regionCols = Math.max(1, colsPerRow);
    const unfiledX = regionCols * (CARD_W * 3 + REGION_GAP);
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
        const index = memberCount.get(regionID) ?? 0;
        memberCount.set(regionID, index + 1);
        const gx = index % 3;
        const gy = Math.floor(index / 3);
        const region = regionNodes.get(regionID)!;
        node.x = region.x + REGION_PAD + gx * (CARD_W + GRID_GAP);
        node.y =
          region.y + REGION_HEADER + REGION_PAD + gy * (CARD_H + GRID_GAP);
      } else {
        const gx = unfiled % 4;
        const gy = Math.floor(unfiled / 4);
        node.x = unfiledX + gx * (CARD_W + GRID_GAP);
        node.y = gy * (CARD_H + GRID_GAP);
        unfiled++;
      }
      nodes.push(node);
      // Yield periodically so huge libraries don't block the UI thread.
      if (i % CHUNK === CHUNK - 1) {
        await Zotero.Promise.delay(0);
      }
    }

    // Notes of placed items, offset from their parent card.
    const itemNodeByID = new Map(
      nodes.filter((n) => n.kind === "item").map((n) => [n.zoteroID, n]),
    );
    for (const itemNode of itemNodeByID.values()) {
      const item = Zotero.Items.get(itemNode.zoteroID);
      if (!item) {
        continue;
      }
      const noteIDs = item.getNotes();
      let noteIndex = 0;
      for (const noteID of noteIDs) {
        const note = Zotero.Items.get(noteID);
        if (!note || note.deleted) {
          continue;
        }
        const node = this.noteToNode(note, itemNode);
        node.x = itemNode.x + CARD_W + GRID_GAP;
        node.y = itemNode.y + noteIndex * (NOTE_H + GRID_GAP / 2);
        nodes.push(node);
        noteIndex++;
      }
    }

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
              node.x = parentNode.x + CARD_W + GRID_GAP;
              node.y = parentNode.y;
              added.push(node);
            }
          } else if (item.isRegularItem()) {
            const node = this.itemToNode(item);
            const spot = this.freeSpotNearCamera();
            node.x = spot.x;
            node.y = spot.y;
            added.push(node);
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
        for (const id of ids) {
          const collection = Zotero.Collections.get(id);
          if (!collection || collection.libraryID !== libraryID) {
            continue;
          }
          const spot = this.freeSpotNearCamera();
          added.push({
            id: collectionNodeID(id),
            kind: "collection",
            zoteroID: id,
            libraryID,
            x: spot.x,
            y: spot.y,
            z: 0,
            w: CARD_W + REGION_PAD * 2,
            h: CARD_H + REGION_PAD * 2 + REGION_HEADER,
            title: collection.name,
            badge: "collection",
          });
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
          node.x = parentNode.x + CARD_W + GRID_GAP;
          node.y = parentNode.y + index * (NOTE_H + GRID_GAP / 2);
          added.push(node);
          index++;
        }
        continue;
      }
      if (!item.isRegularItem() || this.scene.nodes.has(itemNodeID(item.id))) {
        continue;
      }
      const node = this.itemToNode(item);
      const spot = this.freeSpotNearCamera(index);
      node.x = spot.x;
      node.y = spot.y;
      added.push(node);
      index++;
      // Bring along child notes.
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

  private freeSpotNearCamera(index = 0): { x: number; y: number } {
    const cam = this.scene.camera;
    const gx = index % 4;
    const gy = Math.floor(index / 4);
    return {
      x: cam.x + 60 + gx * (CARD_W + GRID_GAP),
      y: cam.y + 60 + gy * (CARD_H + GRID_GAP),
    };
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
