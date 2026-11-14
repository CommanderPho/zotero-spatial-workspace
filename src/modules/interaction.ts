/**
 * Pointer / wheel / keyboard input for the board canvas.
 *
 * - Middle-drag pans; background left-drag draws a selection marquee
 *   (Shift adds); card drag moves the selection (Shift-click toggles).
 * - Wheel zooms at the cursor.
 * - Double-click opens the item in Zotero (reader for PDFs).
 * - Delete removes nodes from the board only; Zotero data is untouched.
 *
 * Pointer moves are rAF-coalesced so a high-Hz mouse never queues more than
 * one scene update per frame.
 */

import type { SceneStore, SceneNode } from "./scene";
import type { Renderer2D } from "./render2d";
import { getString } from "../utils/locale";

type DragMode = "pan" | "move" | "marquee" | null;

export interface InteractionOptions {
  /** Ctrl/Cmd+F: focus the toolbar filter input. */
  onFocusFilter?: () => void;
  /** Esc with an active filter: clear it. */
  onClearFilter?: () => void;
}

export class Interaction {
  private canvas: HTMLCanvasElement;
  private scene: SceneStore;
  private renderer: Renderer2D;
  private tooltip: HTMLElement;
  private options: InteractionOptions;
  private mode: DragMode = null;
  private lastX = 0;
  private lastY = 0;
  private startX = 0;
  private startY = 0;
  private moved = false;
  private dragOrigins = new Map<string, { x: number; y: number }>();
  private pendingMove: { x: number; y: number } | null = null;
  private moveRaf = 0;
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private cleanups: Array<() => void> = [];

  constructor(
    canvas: HTMLCanvasElement,
    scene: SceneStore,
    renderer: Renderer2D,
    tooltip: HTMLElement,
    options: InteractionOptions = {},
  ) {
    this.canvas = canvas;
    this.scene = scene;
    this.renderer = renderer;
    this.tooltip = tooltip;
    this.options = options;
    this.bind();
  }

  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window,
    type: K | string,
    listener: (ev: any) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, listener as EventListener, options);
    this.cleanups.push(() =>
      target.removeEventListener(type, listener as EventListener, options),
    );
  }

  private bind(): void {
    this.on(this.canvas, "pointerdown", (ev: PointerEvent) =>
      this.onPointerDown(ev),
    );
    this.on(this.canvas, "pointermove", (ev: PointerEvent) =>
      this.onPointerMove(ev),
    );
    this.on(this.canvas, "pointerup", (ev: PointerEvent) =>
      this.onPointerUp(ev),
    );
    this.on(this.canvas, "pointercancel", () => {
      this.renderer.marquee = null;
      this.endDrag();
      this.renderer.requestDraw();
    });
    this.on(
      this.canvas,
      "wheel",
      (ev: WheelEvent) => {
        ev.preventDefault();
        const { x, y } = this.localPoint(ev);
        const factor = Math.exp(-ev.deltaY * 0.0015);
        this.renderer.zoomAt(x, y, factor);
      },
      { passive: false },
    );
    this.on(this.canvas, "dblclick", (ev: MouseEvent) => {
      const { x, y } = this.localPoint(ev);
      const world = this.renderer.screenToWorld(x, y);
      const node = this.scene.hitTest(world.x, world.y);
      if (node) {
        void openNode(node);
      }
    });
    this.on(this.canvas, "keydown", (ev: KeyboardEvent) => this.onKeyDown(ev));
    this.on(this.canvas, "pointerleave", () => this.hideTooltip());
  }

  private localPoint(ev: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private get view(): Window {
    return this.canvas.ownerDocument!.defaultView as Window;
  }

  private onPointerDown(ev: PointerEvent): void {
    if (ev.button !== 0 && ev.button !== 1) {
      return;
    }
    this.canvas.focus();
    this.canvas.setPointerCapture(ev.pointerId);
    this.hideTooltip();
    const { x, y } = this.localPoint(ev);
    this.lastX = this.startX = x;
    this.lastY = this.startY = y;
    this.moved = false;

    const world = this.renderer.screenToWorld(x, y);
    const node = this.scene.hitTest(world.x, world.y);

    if (ev.button === 1) {
      // Middle-drag is the only pan gesture.
      this.mode = "pan";
      return;
    }
    if (!node) {
      // Background: drag draws a selection marquee (Shift adds to the
      // selection). A plain click (no movement) clears selection on release.
      this.mode = "marquee";
      return;
    }

    if (ev.shiftKey) {
      this.scene.toggleSelect(node.id);
    } else if (!this.scene.selection.has(node.id)) {
      this.scene.select([node.id]);
    }

    let hiddenRegionMembers: string[] = [];
    if (node.kind === "collection") {
      // Dragging a region moves the region and everything inside it,
      // including cards currently hidden by the filter (they keep their
      // relative positions), but only visible members become selected.
      const members = this.scene
        .queryRect(node, true)
        .filter((n) => n.kind !== "collection" && n.parentRegionID === node.id);
      const visible = members.filter((n) => !this.scene.isHidden(n.id));
      hiddenRegionMembers = members
        .filter((n) => this.scene.isHidden(n.id))
        .map((n) => n.id);
      this.scene.select([node.id, ...visible.map((n) => n.id)]);
    }

    this.mode = "move";
    this.dragOrigins.clear();
    for (const id of [...this.scene.selection, ...hiddenRegionMembers]) {
      const n = this.scene.nodes.get(id);
      if (n) {
        this.dragOrigins.set(id, { x: n.x, y: n.y });
      }
    }
  }

  private onPointerMove(ev: PointerEvent): void {
    const { x, y } = this.localPoint(ev);
    if (!this.mode) {
      this.scheduleHover(x, y);
      return;
    }
    if (Math.abs(x - this.startX) + Math.abs(y - this.startY) > 3) {
      this.moved = true;
    }
    this.pendingMove = { x, y };
    if (!this.moveRaf) {
      this.moveRaf = this.view.requestAnimationFrame(() => {
        this.moveRaf = 0;
        this.applyPendingMove();
      });
    }
  }

  private applyPendingMove(): void {
    if (!this.pendingMove || !this.mode) {
      return;
    }
    const { x, y } = this.pendingMove;
    this.pendingMove = null;
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;

    if (this.mode === "pan") {
      this.renderer.panBy(dx, dy);
      return;
    }
    if (this.mode === "move") {
      const zoom = this.scene.camera.zoom;
      const wdx = dx / zoom;
      const wdy = dy / zoom;
      for (const [id, origin] of this.dragOrigins) {
        origin.x += wdx;
        origin.y += wdy;
        this.scene.moveSilent(id, origin.x, origin.y);
      }
      this.renderer.requestDraw();
      return;
    }
    if (this.mode === "marquee") {
      const a = this.renderer.screenToWorld(this.startX, this.startY);
      const b = this.renderer.screenToWorld(x, y);
      this.renderer.marquee = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(a.x - b.x),
        h: Math.abs(a.y - b.y),
      };
      this.renderer.requestDraw();
    }
  }

  private onPointerUp(ev: PointerEvent): void {
    this.applyPendingMove();
    const wasMode = this.mode;
    const moved = this.moved;
    this.endDrag();

    if (wasMode === "move" && moved) {
      this.scene.endBatch();
    }
    if (wasMode === "marquee") {
      const marquee = this.renderer.marquee;
      this.renderer.marquee = null;
      if (marquee && marquee.w > 2 && marquee.h > 2) {
        const hits = this.scene
          .queryRect(marquee)
          .filter((n) => n.kind !== "collection")
          .map((n) => n.id);
        this.scene.select(hits, ev.shiftKey);
      } else if (!moved && ev.button === 0 && !ev.shiftKey) {
        this.scene.clearSelection();
      }
      this.renderer.requestDraw();
    }
  }

  private endDrag(): void {
    this.mode = null;
    this.dragOrigins.clear();
    this.pendingMove = null;
    if (this.moveRaf) {
      this.view.cancelAnimationFrame(this.moveRaf);
      this.moveRaf = 0;
    }
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      if (this.scene.filter.active && this.options.onClearFilter) {
        this.options.onClearFilter();
      }
      this.scene.clearSelection();
      this.renderer.marquee = null;
      this.renderer.requestDraw();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "f") {
      if (this.options.onFocusFilter) {
        ev.preventDefault();
        this.options.onFocusFilter();
      }
      return;
    }
    if (ev.key === "Delete" || (Zotero.isMac && ev.key === "Backspace")) {
      const ids = [...this.scene.selection];
      if (ids.length === 0) {
        return;
      }
      ev.preventDefault();
      this.scene.removeMany(ids);
      this.scene.recomputeRegions();
      new ztoolkit.ProgressWindow(addon.data.config.addonName)
        .createLine({
          text: getString("board-removed", { args: { count: ids.length } }),
          type: "default",
        })
        .show();
      return;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
      ev.preventDefault();
      const ids = [...this.scene.nodes.values()]
        .filter((n) => n.kind !== "collection" && !this.scene.isHidden(n.id))
        .map((n) => n.id);
      this.scene.select(ids);
    }
  }

  private scheduleHover(x: number, y: number): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
    }
    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      if (this.mode || this.disposed) {
        return;
      }
      const world = this.renderer.screenToWorld(x, y);
      const node = this.scene.hitTest(world.x, world.y);
      if (!node || node.kind === "collection") {
        this.hideTooltip();
        return;
      }
      const lines = [node.title];
      if (node.subtitle) {
        lines.push(node.subtitle);
      }
      this.tooltip.textContent = lines.join("\n");
      this.tooltip.style.display = "block";
      const wrapRect = this.canvas.parentElement!.getBoundingClientRect();
      const canvasRect = this.canvas.getBoundingClientRect();
      const left = canvasRect.left - wrapRect.left + x + 14;
      const top = canvasRect.top - wrapRect.top + y + 14;
      this.tooltip.style.left = `${Math.min(left, wrapRect.width - 330)}px`;
      this.tooltip.style.top = `${top}px`;
    }, 400);
  }

  private hideTooltip(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.tooltip.style.display = "none";
  }

  dispose(): void {
    this.disposed = true;
    this.hideTooltip();
    this.endDrag();
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
  }
}

/** Open a scene node in Zotero: reader for attachments, note editor, etc. */
export async function openNode(node: SceneNode): Promise<void> {
  const pane = Zotero.getActiveZoteroPane();
  if (!pane) {
    return;
  }
  if (node.kind === "collection") {
    // Collections live in the collection tree, not the items list.
    const collectionsView = pane.collectionsView;
    if (collectionsView) {
      collectionsView.selectByID(`C${node.zoteroID}`);
    }
    return;
  }
  const item = Zotero.Items.get(node.zoteroID);
  if (!item) {
    return;
  }
  if (item.isNote()) {
    await pane.openNote(item.id);
    return;
  }
  if (item.isAttachment()) {
    await Zotero.FileHandlers.open(item);
    return;
  }
  const attachment = await item.getBestAttachment();
  if (attachment) {
    await Zotero.FileHandlers.open(attachment);
    return;
  }
  pane.selectItem(item.id, true);
}
