/**
 * Per-library layout persistence.
 *
 * Layouts live in the Zotero data directory (not the profile), so they
 * survive profile resets: `<dataDir>/spatialworkspace/layout-<libraryID>.json`.
 * Writes are debounced and atomic (temp file + rename); nothing is written
 * per frame or per drag event.
 */

import { getPref } from "../utils/prefs";
import type { Camera, SceneNode, SceneStore } from "./scene";

const DIR_NAME = "spatialworkspace";
const LAYOUT_VERSION = 1;

interface LayoutFile {
  version: number;
  libraryID: number;
  camera: Camera;
  nodes: Array<{
    id: string;
    x: number;
    y: number;
    z?: number;
    parentRegionID?: string;
  }>;
}

export class LayoutStore {
  private scene: SceneStore;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private saveDelay: number;
  private dirty = false;

  constructor(scene: SceneStore) {
    this.scene = scene;
    this.saveDelay = Number(getPref("autosaveDelayMs")) || 800;
    scene.onChange(() => this.scheduleSave());
  }

  setSaveDelay(ms: number): void {
    this.saveDelay = ms;
  }

  private filePath(libraryID: number): string {
    return PathUtils.join(
      Zotero.DataDirectory.dir,
      DIR_NAME,
      `layout-${libraryID}.json`,
    );
  }

  /** Read a saved layout, or null when none exists / it is unreadable. */
  async load(libraryID: number): Promise<LayoutFile | null> {
    const path = this.filePath(libraryID);
    try {
      if (!(await IOUtils.exists(path))) {
        return null;
      }
      const text = await Zotero.File.getContentsAsync(path);
      const data = JSON.parse(text as string) as LayoutFile;
      if (data.version !== LAYOUT_VERSION || data.libraryID !== libraryID) {
        return null;
      }
      return data;
    } catch (e) {
      ztoolkit.log("Failed to load spatial layout", e);
      return null;
    }
  }

  /** Debounced save; coalesces bursts of scene changes into one write. */
  scheduleSave(): void {
    this.dirty = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.saveDelay);
  }

  /** Write immediately if dirty. Serialized so writes never overlap. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) {
      return this.saving;
    }
    this.dirty = false;
    const snapshot = this.snapshot();
    this.saving = this.saving
      .then(() => this.write(snapshot))
      .catch((e) => {
        ztoolkit.log("Failed to save spatial layout", e);
      });
    return this.saving;
  }

  private snapshot(): LayoutFile {
    const nodes: LayoutFile["nodes"] = [];
    for (const node of this.scene.nodes.values()) {
      nodes.push({
        id: node.id,
        x: node.x,
        y: node.y,
        z: node.z || undefined,
        parentRegionID: node.parentRegionID,
      });
    }
    return {
      version: LAYOUT_VERSION,
      libraryID: this.scene.libraryID,
      camera: { ...this.scene.camera },
      nodes,
    };
  }

  private async write(data: LayoutFile): Promise<void> {
    const dirPath = PathUtils.join(Zotero.DataDirectory.dir, DIR_NAME);
    await IOUtils.makeDirectory(dirPath, {
      createAncestors: true,
      ignoreExisting: true,
    });
    const path = this.filePath(data.libraryID);
    const tmpPath = path + ".tmp";
    await Zotero.File.putContentsAsync(tmpPath, JSON.stringify(data));
    // Atomic replace: rename over the previous layout.
    await IOUtils.move(tmpPath, path);
  }
}

/** Apply saved positions onto freshly built scene nodes. */
export function applyLayout(
  nodes: SceneNode[],
  layout: LayoutFile | null,
): Camera | null {
  if (!layout) {
    return null;
  }
  const saved = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const node of nodes) {
    const pos = saved.get(node.id);
    if (pos) {
      node.x = pos.x;
      node.y = pos.y;
      node.z = pos.z ?? 0;
      if (pos.parentRegionID) {
        node.parentRegionID = pos.parentRegionID;
      }
    }
  }
  return layout.camera ?? null;
}
