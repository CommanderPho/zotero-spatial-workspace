/**
 * Board tab lifecycle: creates the Zotero tab, mounts the canvas + toolbar,
 * wires the renderer / interaction / resize observer, and tears everything
 * down on close. One board per main window; the scene itself is shared.
 */

import { config } from "../../package.json";
import type { FluentMessageId } from "../../typings/i10n";
import { getString, getLocaleID } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import type { SceneStore } from "./scene";
import { computeLayout } from "./layout";
import { parseFilter } from "./filter";
import { Renderer2D } from "./render2d";
import { Interaction } from "./interaction";

const TAB_TYPE = `${config.addonRef}-board`;

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

export class Board {
  readonly win: _ZoteroTypes.MainWindow;
  private scene: SceneStore;
  private tabID?: string;
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
  private destroyed = false;

  constructor(win: _ZoteroTypes.MainWindow, scene: SceneStore) {
    this.win = win;
    this.scene = scene;
  }

  get isOpen(): boolean {
    return !!this.tabID && !this.destroyed;
  }

  /** Open the tab (or focus it when already open). */
  async open(): Promise<void> {
    if (this.isOpen) {
      this.win.Zotero_Tabs.select(this.tabID!);
      return;
    }
    const { id, container } = this.win.Zotero_Tabs.add({
      type: TAB_TYPE,
      title: getString("board-tab-title"),
      data: {
        icon: `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`,
      },
      select: true,
      onClose: () => this.destroy(),
    });
    this.tabID = id;
    this.mount(container as unknown as HTMLElement);
  }

  private mount(container: HTMLElement): void {
    const doc = this.win.document;

    const link = ztoolkit.UI.createElement(doc, "link", {
      properties: {
        rel: "stylesheet",
        type: "text/css",
        href: `chrome://${config.addonRef}/content/board.css`,
      },
    });
    doc.documentElement?.appendChild(link);

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

    // Temporary visibility filter: hides non-matching cards without
    // touching positions or the saved layout.
    const filterInput = ztoolkit.UI.createElement(doc, "input", {
      classList: [`${config.addonRef}-filter-input`],
      attributes: {
        type: "search",
        "data-l10n-id": getLocaleID("board-filter-placeholder"),
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

    this.resizeObserver = new this.win.ResizeObserver(() => this.syncSize());
    this.resizeObserver!.observe(wrap);
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
    const wrap = this.canvas.parentElement!;
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      // The tab pane may not be laid out yet (e.g. right after Tabs.add).
      // Retry on the next frames until it has real dimensions.
      this.win.requestAnimationFrame(() => this.syncSize());
      return;
    }
    this.renderer.resize(
      rect.width,
      rect.height,
      this.win.devicePixelRatio || 1,
    );
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

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.unsubscribeScene?.();
    this.resizeObserver?.disconnect();
    this.interaction?.dispose();
    this.renderer?.cancel();
    if (this.tabID) {
      const tabID = this.tabID;
      this.tabID = undefined;
      try {
        this.win.Zotero_Tabs.close(tabID);
      } catch (e) {
        // Tab may already be closing.
      }
    }
    this.root?.remove();
    this.root = undefined;
    this.canvas = undefined;
    this.filterInput = undefined;
    this.filterClearBtn = undefined;
    this.notesBtn = undefined;
    this.renderer = undefined;
    this.interaction = undefined;
  }
}
