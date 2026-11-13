/**
 * Canvas2D renderer for the spatial board.
 *
 * Performance strategy:
 * - One canvas, DPR-aware; redraw only when the scene revision changes
 *   (dirty flag) or the viewport resizes. No idle rAF loop.
 * - Viewport culling through the scene's spatial hash.
 * - Level-of-detail labels: text is dropped below zoom thresholds and
 *   truncated with cached measurements.
 * - Draw order: regions, note links, item cards, note cards, selection,
 *   marquee.
 */

import { getPref } from "../utils/prefs";
import {
  REGION_HEADER,
  rectsIntersect,
  type Rect,
  type SceneNode,
  type SceneStore,
} from "./scene";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 4;
/** Below this zoom, card text is hidden entirely. */
const TEXT_ZOOM = 0.35;
/** Below this zoom, only titles (no subtitles) are drawn. */
const SUBTITLE_ZOOM = 0.6;

const COLORS = {
  background: "#f6f7f9",
  grid: "rgba(0, 0, 0, 0.045)",
  regionFill: "rgba(80, 120, 200, 0.06)",
  regionBorder: "rgba(80, 120, 200, 0.35)",
  regionLabel: "#3b5b92",
  cardFill: "#ffffff",
  cardBorder: "rgba(0, 0, 0, 0.18)",
  cardTitle: "#1a1a1a",
  cardSubtitle: "#666666",
  noteFill: "#fff6c9",
  noteBorder: "rgba(160, 140, 40, 0.5)",
  noteText: "#4a4318",
  noteLink: "rgba(160, 140, 40, 0.55)",
  selection: "#2f6fed",
  marqueeFill: "rgba(47, 111, 237, 0.08)",
  marqueeBorder: "rgba(47, 111, 237, 0.7)",
};

export interface RenderOptions {
  showNotes: boolean;
  labelDetail: "auto" | "full" | "minimal";
}

export class Renderer2D {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scene: SceneStore;
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;
  private lastRevision = -1;
  private lastOptionsKey = "";
  private lastMarquee: Rect | null = null;
  private rafID = 0;
  private truncateCache = new Map<string, string>();
  /** Marquee rect in world coordinates, set by interaction while dragging. */
  marquee: Rect | null = null;

  constructor(canvas: HTMLCanvasElement, scene: SceneStore) {
    this.canvas = canvas;
    this.scene = scene;
    const ctx = canvas.getContext("2d", {
      alpha: false,
    }) as CanvasRenderingContext2D | null;
    if (!ctx) {
      throw new Error("Canvas2D context unavailable");
    }
    this.ctx = ctx;
  }

  /** Resize backing store to element size * devicePixelRatio. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.lastRevision = -1;
    this.requestDraw();
  }

  get viewport(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  private get view(): Window {
    return this.canvas.ownerDocument!.defaultView as Window;
  }

  /** Coalesce redraw requests into one animation frame. */
  requestDraw(): void {
    if (this.rafID) {
      return;
    }
    this.rafID = this.view.requestAnimationFrame(() => {
      this.rafID = 0;
      this.draw();
    });
  }

  cancel(): void {
    if (this.rafID) {
      this.view.cancelAnimationFrame(this.rafID);
      this.rafID = 0;
    }
  }

  /** World point -> CSS pixel point relative to the canvas. */
  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const cam = this.scene.camera;
    return {
      x: (wx - cam.x) * cam.zoom + this.cssWidth / 2,
      y: (wy - cam.y) * cam.zoom + this.cssHeight / 2,
    };
  }

  /** CSS pixel point -> world point. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cam = this.scene.camera;
    return {
      x: (sx - this.cssWidth / 2) / cam.zoom + cam.x,
      y: (sy - this.cssHeight / 2) / cam.zoom + cam.y,
    };
  }

  /** Visible world rect (for culling queries). */
  viewRect(): Rect {
    const cam = this.scene.camera;
    const w = this.cssWidth / cam.zoom;
    const h = this.cssHeight / cam.zoom;
    return { x: cam.x - w / 2, y: cam.y - h / 2, w, h };
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const cam = this.scene.camera;
    const zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (zoom === cam.zoom) {
      return;
    }
    const before = this.screenToWorld(sx, sy);
    cam.zoom = zoom;
    const after = this.screenToWorld(sx, sy);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    this.scene.setCamera({ ...cam });
    this.requestDraw();
  }

  panBy(dxScreen: number, dyScreen: number): void {
    const cam = this.scene.camera;
    cam.x -= dxScreen / cam.zoom;
    cam.y -= dyScreen / cam.zoom;
    this.scene.setCamera({ ...cam });
    this.requestDraw();
  }

  fitBounds(bounds: Rect | null, padding = 60): void {
    if (!bounds || this.cssWidth === 0 || this.cssHeight === 0) {
      return;
    }
    const zoom = clamp(
      Math.min(
        (this.cssWidth - padding * 2) / Math.max(bounds.w, 1),
        (this.cssHeight - padding * 2) / Math.max(bounds.h, 1),
      ),
      MIN_ZOOM,
      1.2,
    );
    this.scene.setCamera({
      x: bounds.x + bounds.w / 2,
      y: bounds.y + bounds.h / 2,
      zoom,
    });
    this.requestDraw();
  }

  private options(): RenderOptions {
    return {
      showNotes: getPref("showNotes") !== false,
      labelDetail:
        (getPref("labelDetail") as RenderOptions["labelDetail"]) || "auto",
    };
  }

  private draw(): void {
    const options = this.options();
    const optionsKey = `${options.showNotes}|${options.labelDetail}`;
    const marqueeChanged = this.marquee !== this.lastMarquee;
    if (
      this.scene.revision === this.lastRevision &&
      optionsKey === this.lastOptionsKey &&
      !marqueeChanged
    ) {
      return;
    }
    this.lastRevision = this.scene.revision;
    this.lastOptionsKey = optionsKey;
    this.lastMarquee = this.marquee;

    const ctx = this.ctx;
    const cam = this.scene.camera;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    this.drawGrid();

    // World-space transform for scene content.
    ctx.save();
    ctx.translate(this.cssWidth / 2, this.cssHeight / 2);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);

    const view = this.viewRect();
    const visible = this.scene
      .queryRect(view)
      .filter((n) => rectsIntersect(n, view));
    const regions = visible.filter((n) => n.kind === "collection");
    const items = visible.filter((n) => n.kind === "item");
    const notes = options.showNotes
      ? visible.filter((n) => n.kind === "note")
      : [];

    for (const region of regions) {
      this.drawRegion(region, cam.zoom, options);
    }
    for (const note of notes) {
      this.drawNoteLink(note);
    }
    for (const item of items) {
      this.drawCard(item, cam.zoom, options);
    }
    for (const note of notes) {
      this.drawNote(note, cam.zoom, options);
    }
    this.drawSelection(visible);
    if (this.marquee) {
      ctx.fillStyle = COLORS.marqueeFill;
      ctx.strokeStyle = COLORS.marqueeBorder;
      ctx.lineWidth = 1 / cam.zoom;
      ctx.fillRect(
        this.marquee.x,
        this.marquee.y,
        this.marquee.w,
        this.marquee.h,
      );
      ctx.strokeRect(
        this.marquee.x,
        this.marquee.y,
        this.marquee.w,
        this.marquee.h,
      );
    }
    ctx.restore();
  }

  private drawGrid(): void {
    const cam = this.scene.camera;
    if (cam.zoom < 0.2) {
      return;
    }
    const ctx = this.ctx;
    const step = 128 * cam.zoom;
    const origin = this.worldToScreen(0, 0);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = origin.x % step; x < this.cssWidth; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.cssHeight);
    }
    for (let y = origin.y % step; y < this.cssHeight; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(this.cssWidth, y);
    }
    ctx.stroke();
  }

  private drawRegion(
    node: SceneNode,
    zoom: number,
    options: RenderOptions,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.regionFill;
    ctx.strokeStyle = COLORS.regionBorder;
    ctx.lineWidth = 1.5 / zoom;
    roundRect(ctx, node.x, node.y, node.w, node.h, 10);
    ctx.fill();
    ctx.stroke();

    if (zoom < TEXT_ZOOM && options.labelDetail !== "full") {
      return;
    }
    ctx.fillStyle = COLORS.regionLabel;
    ctx.font = `600 ${15}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    const label = this.truncate(node.title, node.w - 24, ctx);
    ctx.fillText(label, node.x + 12, node.y + REGION_HEADER / 2);
  }

  private drawCard(
    node: SceneNode,
    zoom: number,
    options: RenderOptions,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.cardFill;
    ctx.strokeStyle = COLORS.cardBorder;
    ctx.lineWidth = 1 / zoom;
    roundRect(ctx, node.x, node.y, node.w, node.h, 6);
    ctx.fill();
    ctx.stroke();

    const showText =
      options.labelDetail === "full" ||
      (options.labelDetail !== "minimal" && zoom >= TEXT_ZOOM);
    if (!showText) {
      // LOD: colored block only; type accent keeps cards distinguishable.
      ctx.fillStyle = accentColor(node.badge);
      ctx.fillRect(node.x + 6, node.y + 6, 10, 10);
      return;
    }

    ctx.fillStyle = accentColor(node.badge);
    ctx.fillRect(node.x + 8, node.y + 10, 4, node.h - 20);

    ctx.fillStyle = COLORS.cardTitle;
    ctx.font = `600 13px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    const title = this.truncate(node.title, node.w - 28, ctx);
    ctx.fillText(title, node.x + 20, node.y + 10);

    const showSubtitle =
      options.labelDetail === "full" || zoom >= SUBTITLE_ZOOM;
    if (showSubtitle && node.subtitle) {
      ctx.fillStyle = COLORS.cardSubtitle;
      ctx.font = `11px system-ui, sans-serif`;
      const subtitle = this.truncate(node.subtitle, node.w - 28, ctx);
      ctx.fillText(subtitle, node.x + 20, node.y + 30);
    }
    if (showSubtitle && node.badge) {
      ctx.fillStyle = COLORS.cardSubtitle;
      ctx.font = `10px system-ui, sans-serif`;
      ctx.fillText(node.badge, node.x + 20, node.y + node.h - 20);
    }
  }

  private drawNoteLink(note: SceneNode): void {
    if (!note.linkID) {
      return;
    }
    const parent = this.scene.nodes.get(note.linkID);
    if (!parent || this.scene.isHidden(parent.id)) {
      return;
    }
    const ctx = this.ctx;
    const zoom = this.scene.camera.zoom;
    ctx.strokeStyle = COLORS.noteLink;
    ctx.lineWidth = 1 / zoom;
    ctx.beginPath();
    ctx.moveTo(parent.x + parent.w, parent.y + parent.h / 2);
    ctx.lineTo(note.x, note.y + note.h / 2);
    ctx.stroke();
  }

  private drawNote(
    node: SceneNode,
    zoom: number,
    options: RenderOptions,
  ): void {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.noteFill;
    ctx.strokeStyle = COLORS.noteBorder;
    ctx.lineWidth = 1 / zoom;
    roundRect(ctx, node.x, node.y, node.w, node.h, 4);
    ctx.fill();
    ctx.stroke();

    const showText =
      options.labelDetail === "full" ||
      (options.labelDetail !== "minimal" && zoom >= TEXT_ZOOM);
    if (!showText) {
      return;
    }
    ctx.fillStyle = COLORS.noteText;
    ctx.font = `11px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    // Up to three lines of note text.
    const lines = wrapText(ctx, node.title, node.w - 16, 3);
    lines.forEach((line, i) => {
      ctx.fillText(line, node.x + 8, node.y + 8 + i * 15);
    });
  }

  private drawSelection(visible: SceneNode[]): void {
    if (this.scene.selection.size === 0) {
      return;
    }
    const ctx = this.ctx;
    const zoom = this.scene.camera.zoom;
    ctx.strokeStyle = COLORS.selection;
    ctx.lineWidth = 2 / zoom;
    for (const node of visible) {
      if (this.scene.selection.has(node.id)) {
        roundRect(ctx, node.x - 2, node.y - 2, node.w + 4, node.h + 4, 7);
        ctx.stroke();
      }
    }
  }

  /** Truncate with an ellipsis; results cached per font+width+text. */
  private truncate(
    text: string,
    maxWidth: number,
    ctx: CanvasRenderingContext2D,
  ): string {
    const key = `${ctx.font}|${maxWidth}|${text}`;
    const cached = this.truncateCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let result = text;
    if (ctx.measureText(text).width > maxWidth) {
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(text.slice(0, mid) + "…").width <= maxWidth) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      result = text.slice(0, Math.max(lo, 1)) + "…";
    }
    if (this.truncateCache.size > 20000) {
      this.truncateCache.clear();
    }
    this.truncateCache.set(key, result);
    return result;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? line + " " + word : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) {
        break;
      }
    }
  }
  if (lines.length < maxLines && line) {
    lines.push(line);
  }
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    if (ctx.measureText(last).width > maxWidth) {
      lines[maxLines - 1] = last.slice(0, Math.max(1, last.length - 1)) + "…";
    }
  }
  return lines;
}

function accentColor(badge: string | undefined): string {
  switch (badge) {
    case "journalArticle":
      return "#2f6fed";
    case "book":
    case "bookSection":
      return "#8e44ad";
    case "conferencePaper":
      return "#16a085";
    case "thesis":
      return "#d35400";
    case "report":
      return "#7f8c8d";
    case "preprint":
      return "#c0392b";
    case "note":
      return "#b7a125";
    default:
      return "#95a5a6";
  }
}
