/**
 * Entry points: Tools menu, item context menu, and the public API used by
 * the keyboard shortcut. Menus use the native Zotero.MenuManager (Zotero 8+).
 */

import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
import { isWindowAlive } from "../utils/window";
import { Board } from "./board";

/**
 * Library of the current collection-tree selection, or undefined when no
 * library is selected. Uses getSelectedLibraryIDs(), which replaced the
 * removed getSelectedLibraryID() for multi-library selection; falls back to
 * the singular method on Zotero versions that predate the plural API.
 */
function getSelectedLibraryID(
  pane: _ZoteroTypes.ZoteroPane,
): number | undefined {
  const ids = pane.getSelectedLibraryIDs?.();
  if (Array.isArray(ids)) {
    return ids[0];
  }
  return pane.getSelectedLibraryID?.() || undefined;
}

const MENU_IDS = [
  `${config.addonRef}-tools-open`,
  `${config.addonRef}-tools-open-window`,
  `${config.addonRef}-item-add`,
];

function findOpenBoard(): Board | undefined {
  for (const board of addon.data.boards.values()) {
    if (board.isOpen) {
      return board;
    }
  }
  return undefined;
}

/** Drop dead window keys left after a host closed unexpectedly. */
function pruneDeadBoards(): void {
  for (const [key, board] of [...addon.data.boards.entries()]) {
    if (!board.isOpen || !isWindowAlive(key)) {
      if (board.isOpen) {
        board.destroy({ skipCloseHost: true });
      }
      addon.data.boards.delete(key);
    }
  }
}

async function ensureLibraryLoaded(libraryID: number): Promise<void> {
  if (
    !addon.data.scene ||
    addon.data.scene.libraryID !== libraryID ||
    addon.data.scene.nodes.size === 0
  ) {
    await addon.data.bridge?.loadLibrary(libraryID);
  }
}

function resolveTargetLibrary(libraryID?: number): number {
  const pane = Zotero.getActiveZoteroPane();
  return (
    libraryID ??
    (addon.data.scene?.libraryID ||
      (pane && getSelectedLibraryID(pane)) ||
      Zotero.Libraries.userLibraryID)
  );
}

function getOrCreateBoard(): Board {
  pruneDeadBoards();
  const existing = findOpenBoard();
  if (existing) {
    return existing;
  }
  const mainWin = Zotero.getMainWindow() as _ZoteroTypes.MainWindow;
  const stale = addon.data.boards.get(mainWin);
  if (stale && !stale.isOpen) {
    addon.data.boards.delete(mainWin);
  }
  const board = new Board(mainWin, addon.data.scene!);
  addon.data.boards.set(mainWin, board);
  return board;
}

export function registerCommands(win: _ZoteroTypes.MainWindow): void {
  const menuIcon = `chrome://${config.addonRef}/content/icons/favicon@0.5x.png`;

  Zotero.MenuManager.registerMenu({
    menuID: MENU_IDS[0],
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menuitem-open-board"),
        icon: menuIcon,
        onCommand: () => {
          void addon.api.openBoard?.();
        },
      },
    ],
  });

  Zotero.MenuManager.registerMenu({
    menuID: MENU_IDS[1],
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menuitem-open-board-window"),
        icon: menuIcon,
        onCommand: () => {
          void addon.api.openBoardWindow?.();
        },
      },
    ],
  });

  Zotero.MenuManager.registerMenu({
    menuID: MENU_IDS[2],
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: getLocaleID("menuitem-add-to-board"),
        icon: menuIcon,
        onCommand: () => {
          void addon.api.addSelectedToBoard?.();
        },
      },
    ],
  });

  addon.api.openBoard = async (libraryID?: number) => {
    const targetLibrary = resolveTargetLibrary(libraryID);
    await ensureLibraryLoaded(targetLibrary);
    const board = getOrCreateBoard();
    if (board.isOpen) {
      board.focus();
      return;
    }
    await board.openAsTab();
  };

  addon.api.openBoardWindow = async (libraryID?: number) => {
    const targetLibrary = resolveTargetLibrary(libraryID);
    await ensureLibraryLoaded(targetLibrary);
    const board = getOrCreateBoard();
    if (board.isOpen && board.hostMode === "window") {
      board.focus();
      return;
    }
    if (board.isOpen && board.hostMode === "tab") {
      await board.popOut();
      return;
    }
    await board.openAsWindow();
  };

  addon.api.addSelectedToBoard = async () => {
    const items = Zotero.getActiveZoteroPane()?.getSelectedItems() ?? [];
    if (!items.length) {
      new ztoolkit.ProgressWindow(config.addonName)
        .createLine({
          text: getString("board-nothing-selected"),
          type: "default",
        })
        .show();
      return;
    }
    const libraryID = items[0].libraryID;
    await ensureLibraryLoaded(libraryID);
    const count = addon.data.bridge?.addItems(items) ?? 0;
    const board = getOrCreateBoard();
    if (!board.isOpen) {
      await board.openAsTab();
    } else {
      board.focus();
    }
    if (count > 0) {
      new ztoolkit.ProgressWindow(config.addonName)
        .createLine({
          text: getString("board-added", { args: { count } }),
          type: "success",
        })
        .show();
    }
  };
}

export function unregisterCommands(): void {
  for (const menuID of MENU_IDS) {
    try {
      Zotero.MenuManager.unregisterMenu(menuID);
    } catch {
      // Menu may not be registered in this window.
    }
  }
  addon.api.openBoard = undefined;
  addon.api.openBoardWindow = undefined;
  addon.api.addSelectedToBoard = undefined;
}
