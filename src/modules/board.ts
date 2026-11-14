/**
 * Board host lifecycle: mounts the canvas + toolbar into either a Zotero tab
 * or a chrome pop-out window, wires the renderer / interaction / resize
 * observer / library drops, and tears everything down on close.
 * One board UI per host window; the scene itself is shared.
 */

import { config } from "../../package.json";
import type { FluentMessageId } from "../../typings/i10n";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { isWindowAlive } from "../utils/window";
import type { SceneStore } from "./scene";
import { computeLayout } from "./layout";
import { parseFilter } from "./filter";
import { Renderer2D } from "./render2d";
import { Interaction } from "./interaction";

const TAB_TYPE = `${config.addonRef}-board`;

type BoardHost = "tab" | "window";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Stroke-based 16px toolbar icons (currentColor, so they follow the theme). */
const TOOLBAR_ICONS: Record<string, string[]> = {
  // 2x2 grid of cards: auto-arrange
  arrange: [
    "M2.5 2.5h4.5v4.5H2.5z",
    "M9 2.5h4.5v4.5H9z",
    "M2.5 9h4.5v4.5H2.5z",
    "M9 9h4.5v4.5H9z",
  ],
  // Four corners framing the board: zoom to fit
  fit: ["M6 2.5H2.5V6", "M10 2.5h3.5V6", "M6 13.5H2.5V10", "M10 13.5h3.5V10"],
  // Sticky note with folded corner: notes toggle
  notes: [
    "M3 2.5h10v7.5l-3.5 3.5H3z",
    "M9.5 13.5V10H13",
    "M5.5 6h5",
    "M5.5 8.5h3",
  ],
  // Cross: clear filter
  clear: ["M4 4l8 8", "M12 4l-8 8"],
  // Arrow out of a frame: pop out to a window
  popout: ["M6.5 2.5H2.5v11h11V9.5", "M9.5 2.5H13.5V6.5", "M8 8l5.5-5.5"],
  // Arrow into a frame: dock back to a tab
  dock: ["M2.5 4.5h11v9H2.5z", "M5 2.5h6", "M8 7.5v4", "M6 10l2 2 2-2"],
};

function createToolbarIcon(doc: Document, name: string): Element {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.4");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(`${config.addonRef}-btn-icon`);
  for (const d of TOOLBAR_ICONS[name] ?? []) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/** Resolve Zotero library items from a drag dataTransfer. */
export function itemsFromDataTransfer(
  dataTransfer: DataTransfer | null,
): Zotero.Item[] {
  if (!dataTransfer) {
    return [];
  }
  let ids: number[] = [];
  const dragDrop = (
    Zotero as unknown as {
      DragDrop?: {
        getDataFromDataTransfer?: (dt: DataTransfer) => {
          dataType?: string;
          data?: unknown[];
        } | null;
      };
    }
  ).DragDrop;
  const parsed = dragDrop?.getDataFromDataTransfer?.(dataTransfer);
  if (
    parsed?.data &&
    (parsed.dataType === "zotero/item" || parsed.dataType === "item")
  ) {
    ids = parsed.data.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  }
  if (!ids.length) {
    const raw = dataTransfer.getData("zotero/item");
    if (raw) {
      ids = raw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((id) => Number.isFinite(id));
    }
  }
  if (!ids.length) {
    return [];
  }
  const items = Zotero.Items.get(ids);
  return (Array.isArray(items) ? items : [items]).filter(
    (item): item is Zotero.Item => !!item,
  );
}

function dataTransferHasItems(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) {
    return false;
  }
  const types = Array.from(dataTransfer.types || []);
  return types.includes("zotero/item");
}

export class Board {
  /** Main Zotero window (used for tabs and openDialog). */
  readonly mainWin: _ZoteroTypes.MainWindow;
  private scene: SceneStore;
  private host: BoardHost | null = null;
  /** Window that owns the board DOM (main window or chrome pop-out). */
  private hostWin?: Window;
  private tabID?: string;
  private chromeWin?: Window;
  private root?: HTMLElement;
  private canvas?: HTMLCanvasElement;
  private statusEl?: HTMLElement;
  private filterInput?: HTMLInputElement;
  private filterClearBtn?: HTMLButtonElement;
  private notesBtn?: HTMLButtonElement;
  private renderer?: Renderer2D;
  private interaction?: Interaction;
  private resizeObserver?: ResizeObserver;
  private unsubscribeScene?: () => void;
  private dropCleanups: Array<() => void> = [];
  private destroyed = false;
  private closingChrome = false;

  constructor(mainWin: _ZoteroTypes.MainWindow, scene: SceneStore) {
    this.mainWin = mainWin;
    this.scene = scene;
  }

  /** @deprecated Use mainWin; kept for callers that still read `.win`. */
  get win(): _ZoteroTypes.MainWindow {
    return this.mainWin;
  }

  get isOpen(): boolean {
    return this.host !== null && !this.destroyed;
  }

  get hostMode(): BoardHost | null {
    return this.host;
  }

  /** Key used in addon.data.boards for this instance. */
  get mapKey(): Window {
    if (this.host === "window" && this.chromeWin) {
      return this.chromeWin;
    }
    return this.mainWin;
  }

  /** Focus the existing host (tab or window). */
  focus(): void {
    if (!this.isOpen) {
      return;
    }
    if (this.host === "tab" && this.tabID) {
      this.mainWin.Zotero_Tabs.select(this.tabID);
      this.mainWin.focus();
      return;
    }
    if (this.host === "window" && isWindowAlive(this.chromeWin)) {
      this.chromeWin!.focus();
    }
  }

  /** Open the tab (or focus it when already open as a tab). */
  async openAsTab(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    if (this.isOpen && this.host === "tab") {
      this.focus();
      return;
    }
    if (this.isOpen && this.host === "window") {
      await this.dock();
      return;
    }
    const { id, container } = this.mainWin.Zotero_Tabs.add({
      type: TAB_TYPE,
      title: getString("board-tab-title"),
      data: {
        icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
      },
      select: true,
      onClose: () => {
        if (!this.destroyed && this.host === "tab") {
          this.destroy({ skipCloseHost: true });
        }
      },
    });
    this.tabID = id;
    this.host = "tab";
    this.hostWin = this.mainWin;
    this.mount(container as unknown as HTMLElement);
    this.rekeyBoardMap(this.mainWin);
  }

  /** Open (or focus) the chrome pop-out window. */
  async openAsWindow(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    if (this.isOpen && this.host === "window") {
      this.focus();
      return;
    }
    if (this.isOpen && this.host === "tab") {
      await this.popOut();
      return;
    }
    await this.mountInChromeWindow();
  }

  /** Move from tab into a pop-out window. */
  async popOut(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    if (this.host === "window") {
      this.focus();
      return;
    }
    this.unmount({ closeTab: true });
    await this.mountInChromeWindow();
  }

  /** Move from pop-out window back into a tab. */
  async dock(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    if (this.host === "tab") {
      this.focus();
      return;
    }
    this.unmount({ closeWindow: true });
    await this.openAsTab();
  }

  /** @deprecated Prefer openAsTab(). */
  async open(): Promise<void> {
    await this.openAsTab();
  }

  private async mountInChromeWindow(): Promise<void> {
    const windowArgs = {
      _initPromise: Zotero.Promise.defer(),
    };
    const chromeWin = this.mainWin.openDialog(
      `chrome://${config.addonRef}/content/boardWindow.xhtml`,
      `${config.addonRef}-board`,
      "chrome,centerscreen,resizable,status,dialog=no",
      windowArgs,
    );
    if (!chromeWin) {
      throw new Error("Failed to open Spatial Workspace window");
    }
    await windowArgs._initPromise.promise;

    this.chromeWin = chromeWin;
    this.host = "window";
    this.hostWin = chromeWin;

    chromeWin.addEventListener(
      "unload",
      () => {
        if (this.closingChrome || this.destroyed) {
          return;
        }
        if (this.host === "window") {
          this.destroy({ skipCloseHost: true });
        }
      },
      { once: true },
    );

    const container = chromeWin.document.querySelector(
      "#board-container",
    ) as HTMLElement | null;
    if (!container) {
      chromeWin.close();
      throw new Error("Spatial Workspace window missing #board-container");
    }
    this.mount(container);
    this.rekeyBoardMap(chromeWin);
    chromeWin.focus();
  }

  private rekeyBoardMap(key: Window): void {
    for (const [existingKey, board] of addon.data.boards) {
      if (board === this && existingKey !== key) {
        addon.data.boards.delete(existingKey);
      }
    }
    addon.data.boards.set(key, this);
  }

  private view(): Window {
    return this.hostWin || this.mainWin;
  }

  private mount(container: HTMLElement): void {
    const view = this.view();
    const doc = container.ownerDocument;
    if (!doc) {
      throw new Error("Board container has no ownerDocument");
    }

    if (!doc.querySelector(`link[href*="${config.addonRef}/content/board.css"]`)) {
      const link = ztoolkit.UI.createElement(doc, "link", {
        properties: {
          rel: "stylesheet",
          type: "text/css",
          href: `chrome://${config.addonRef}/content/board.css`,
        },
      });
      doc.documentElement?.appendChild(link);
    }

    const root = ztoolkit.UI.createElement(doc, "div", {
      classList: [`${config.addonRef}-board-root`],
    });
    this.root = root;

    // Toolbar
    const toolbar = ztoolkit.UI.createElement(doc, "div", {
      classList: [`${config.addonRef}-toolbar`],
    });
    const arrangeBtn = this.toolbarButton(
      doc,
      "arrange",
      "board-toolbar-arrange",
      () => this.autoArrange(),
    );
    const fitBtn = this.toolbarButton(doc, "fit", "board-toolbar-fit", () =>
      this.zoomToFit(),
    );
    const notesBtn = this.toolbarButton(
      doc,
      "notes",
      "board-toolbar-notes",
      () => {
        setPref("showNotes", getPref("showNotes") === false);
        this.refresh();
      },
    );
    notesBtn.setAttribute("aria-pressed", "true");
    this.notesBtn = notesBtn;

    const hostBtn =
      this.host === "window"
        ? this.toolbarButton(doc, "dock", "board-toolbar-dock", () => {
            void this.dock();
          })
        : this.toolbarButton(doc, "popout", "board-toolbar-popout", () => {
            void this.popOut();
          });

    // Temporary visibility filter: hides non-matching cards without
    // touching positions or the saved layout.
    const filterInput = ztoolkit.UI.createElement(doc, "input", {
      classList: [`${config.addonRef}-filter-input`],
      attributes: {
        type: "search",
        placeholder: getString("board-filter-placeholder"),
        title: getString("board-filter-tooltip"),
      },
      listeners: [
        {
          type: "input",
          listener: () => this.applyFilter(filterInput.value),
        },
        {
          type: "keydown",
          listener: (ev: KeyboardEvent) => {
            if (ev.key === "Escape") {
              ev.stopPropagation();
              this.clearFilter();
              this.canvas?.focus();
            }
          },
        },
      ],
    });
    this.filterInput = filterInput;
    const filterClearBtn = this.toolbarButton(
      doc,
      "clear",
      "board-filter-clear",
      () => this.clearFilter(),
      true,
    );
    filterClearBtn.classList.add(`${config.addonRef}-filter-clear`);
    filterClearBtn.style.display = "none";
    this.filterClearBtn = filterClearBtn;

    const status = ztoolkit.UI.createElement(doc, "span", {
      classList: [`${config.addonRef}-status`],
    });
    this.statusEl = status;
    toolbar.append(
      arrangeBtn,
      fitBtn,
      notesBtn,
      hostBtn,
      filterInput,
      filterClearBtn,
      status,
    );

    // Canvas + tooltip
    const wrap = ztoolkit.UI.createElement(doc, "div", {
      classList: [`${config.addonRef}-canvas-wrap`],
    });
    const canvas = ztoolkit.UI.createElement(doc, "canvas", {
      classList: [`${config.addonRef}-canvas`],
      attributes: { tabindex: "0" },
    });
    this.canvas = canvas;
    const tooltip = ztoolkit.UI.createElement(doc, "div", {
      classList: [`${config.addonRef}-tooltip`],
    });
    wrap.append(canvas, tooltip);
    root.append(toolbar, wrap);
    container.append(root);

    this.renderer = new Renderer2D(canvas, this.scene);
    this.interaction = new Interaction(
      canvas,
      this.scene,
      this.renderer,
      tooltip,
      {
        onFocusFilter: () => {
          this.filterInput?.focus();
          this.filterInput?.select();
        },
        onClearFilter: () => this.clearFilter(),
      },
    );

    this.bindDropTarget(root);

    const ResizeObs =
      (view as unknown as { ResizeObserver?: typeof ResizeObserver })
        .ResizeObserver || ResizeObserver;
    this.resizeObserver = new ResizeObs(() => this.syncSize());
    this.resizeObserver.observe(wrap);
    this.syncSize();

    this.unsubscribeScene = this.scene.onChange(() => {
      this.renderer?.requestDraw();
      this.updateStatus();
      this.syncFilterUI();
    });
    this.syncFilterUI();
    this.syncNotesButton();
    this.updateStatus();
    this.renderer.requestDraw();
  }

  private bindDropTarget(root: HTMLElement): void {
    const onDragOver = (ev: DragEvent) => {
      if (!dataTransferHasItems(ev.dataTransfer)) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.dataTransfer) {
        ev.dataTransfer.dropEffect = "copy";
      }
      root.classList.add(`${config.addonRef}-drop-target`);
    };
    const onDragLeave = (ev: DragEvent) => {
      const related = ev.relatedTarget as Node | null;
      if (related && root.contains(related)) {
        return;
      }
      root.classList.remove(`${config.addonRef}-drop-target`);
    };
    const onDrop = (ev: DragEvent) => {
      root.classList.remove(`${config.addonRef}-drop-target`);
      if (!dataTransferHasItems(ev.dataTransfer)) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const items = itemsFromDataTransfer(ev.dataTransfer);
      if (!items.length || !this.canvas || !this.renderer) {
        return;
      }
      const rect = this.canvas.getBoundingClientRect();
      const world = this.renderer.screenToWorld(
        ev.clientX - rect.left,
        ev.clientY - rect.top,
      );
      void this.handleItemDrop(items, world);
    };
    const onDragEnd = () => {
      root.classList.remove(`${config.addonRef}-drop-target`);
    };

    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);
    root.addEventListener("dragend", onDragEnd);
    this.dropCleanups.push(
      () => root.removeEventListener("dragover", onDragOver),
      () => root.removeEventListener("dragleave", onDragLeave),
      () => root.removeEventListener("drop", onDrop),
      () => root.removeEventListener("dragend", onDragEnd),
    );
  }

  private async handleItemDrop(
    items: Zotero.Item[],
    at: { x: number; y: number },
  ): Promise<void> {
    const libraryID = items[0]?.libraryID;
    if (libraryID == null) {
      return;
    }
    if (
      !addon.data.scene ||
      addon.data.scene.libraryID !== libraryID ||
      addon.data.scene.nodes.size === 0
    ) {
      await addon.data.bridge?.loadLibrary(libraryID);
    }
    const count = addon.data.bridge?.addItems(items, at) ?? 0;
    if (count > 0) {
      new ztoolkit.ProgressWindow(config.addonName)
        .createLine({
          text: getString("board-added", { args: { count } }),
          type: "success",
        })
        .show();
    }
  }

  /** Mirror the shared scene filter into this board's toolbar controls. */
  private syncFilterUI(): void {
    const raw = this.scene.filter.raw;
    if (this.filterInput && this.filterInput.value !== raw) {
      this.filterInput.value = raw;
    }
    if (this.filterClearBtn) {
      this.filterClearBtn.style.display = raw ? "" : "none";
    }
  }

  /**
   * HTML toolbar button with an inline SVG icon and a localized text label.
   * Labels are set as textContent (not Fluent `.label`, which only works on
   * XUL elements); tooltips use the native `title` attribute.
   */
  private toolbarButton(
    doc: Document,
    icon: string,
    labelKey: FluentMessageId,
    onClick: () => void,
    iconOnly = false,
  ): HTMLButtonElement {
    const button = ztoolkit.UI.createElement(doc, "button", {
      attributes: {
        type: "button",
        title: getString(`${labelKey}-tooltip` as FluentMessageId),
      },
      listeners: [{ type: "click", listener: () => onClick() }],
    });
    button.appendChild(createToolbarIcon(doc, icon));
    if (!iconOnly) {
      const label = doc.createElement("span");
      label.textContent = getString(labelKey);
      button.appendChild(label);
    } else {
      button.setAttribute("aria-label", getString(labelKey));
    }
    return button;
  }

  private syncSize(): void {
    if (!this.canvas || !this.renderer || !this.root || this.destroyed) {
      return;
    }
    const view = this.view();
    const wrap = this.canvas.parentElement!;
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // The tab pane may not be laid out yet (e.g. right after Tabs.add).
      // Retry on the next frames until it has real dimensions.
      view.requestAnimationFrame(() => this.syncSize());
      return;
    }
    this.renderer.resize(rect.width, rect.height, view.devicePixelRatio || 1);
  }

  /** Called by hooks when the data bridge changed the scene. */
  onSceneChanged(): void {
    this.renderer?.requestDraw();
    this.updateStatus();
  }

  /** Re-read prefs and redraw (e.g. after a preference change). */
  refresh(): void {
    this.syncNotesButton();
    this.renderer?.requestDraw();
  }

  /** Reflect the showNotes pref in the toolbar toggle's pressed state. */
  private syncNotesButton(): void {
    if (!this.notesBtn) {
      return;
    }
    const shown = getPref("showNotes") !== false;
    this.notesBtn.setAttribute("aria-pressed", String(shown));
    this.notesBtn.classList.toggle(`${config.addonRef}-btn-active`, shown);
  }

  /** Apply a temporary visibility filter from the toolbar query text. */
  applyFilter(query: string): void {
    this.scene.setFilter(parseFilter(query));
    if (this.filterClearBtn) {
      this.filterClearBtn.style.display = query.trim() ? "" : "none";
    }
    this.updateStatus();
    this.renderer?.requestDraw();
  }

  clearFilter(): void {
    if (this.filterInput) {
      this.filterInput.value = "";
    }
    this.applyFilter("");
  }

  private updateStatus(): void {
    if (!this.statusEl) {
      return;
    }
    let total = 0;
    let visible = 0;
    for (const node of this.scene.nodes.values()) {
      if (node.kind === "collection") {
        continue;
      }
      total++;
      if (!this.scene.isHidden(node.id)) {
        visible++;
      }
    }
    if (this.scene.filter.active) {
      this.statusEl.textContent = getString("board-status-filtered", {
        args: { visible, total },
      });
      return;
    }
    this.statusEl.textContent =
      total === 0
        ? getString("board-status-empty")
        : getString("board-status-count", { args: { count: total } });
  }

  zoomToFit(): void {
    this.renderer?.fitBounds(this.scene.bounds());
  }

  /** Lay cards out in tidy grids inside their folder regions. */
  autoArrange(): void {
    const nodes = [...this.scene.nodes.values()];
    // Tidy alphabetical order within each region and the unfiled area.
    nodes.sort((a, b) => a.title.localeCompare(b.title));
    computeLayout(nodes);
    for (const node of nodes) {
      this.scene.moveSilent(node.id, node.x, node.y);
    }
    this.scene.recomputeRegions();
    this.zoomToFit();
  }

  /**
   * Tear down the mounted UI without marking the board destroyed, so it can
   * be remounted in another host (pop-out / dock).
   *
   * Clears `host` before closing the tab/window so their unload/onClose
   * handlers do not treat this as a user close and call destroy().
   */
  private unmount(options: {
    closeTab?: boolean;
    closeWindow?: boolean;
  } = {}): void {
    const wasTab = this.host === "tab";
    const wasWindow = this.host === "window";
    const tabID = this.tabID;
    const chromeWin = this.chromeWin;

    this.unsubscribeScene?.();
    this.unsubscribeScene = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.interaction?.dispose();
    this.interaction = undefined;
    this.renderer?.cancel();
    this.renderer = undefined;
    for (const cleanup of this.dropCleanups) {
      cleanup();
    }
    this.dropCleanups = [];
    this.root?.remove();
    this.root = undefined;
    this.canvas = undefined;
    this.filterInput = undefined;
    this.filterClearBtn = undefined;
    this.notesBtn = undefined;
    this.statusEl = undefined;

    this.host = null;
    this.hostWin = undefined;
    this.tabID = undefined;
    this.chromeWin = undefined;

    if (options.closeTab && wasTab && tabID) {
      try {
        this.mainWin.Zotero_Tabs.close(tabID);
      } catch {
        // Tab may already be closing.
      }
    }

    if (options.closeWindow && wasWindow && chromeWin) {
      this.closingChrome = true;
      try {
        if (isWindowAlive(chromeWin)) {
          chromeWin.close();
        }
      } catch {
        // Window may already be closing.
      }
      this.closingChrome = false;
    }
  }

  destroy(options: { skipCloseHost?: boolean } = {}): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    const key = this.mapKey;
    this.unmount({
      closeTab: this.host === "tab" && !options.skipCloseHost,
      closeWindow: this.host === "window" && !options.skipCloseHost,
    });
    if (addon.data.boards.get(key) === this) {
      addon.data.boards.delete(key);
    }
  }
}
