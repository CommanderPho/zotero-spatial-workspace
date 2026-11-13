/**
 * Entry points: Tools menu, item context menu, and the public API used by
 * the keyboard shortcut. Menus use the native Zotero.MenuManager (Zotero 8+).
 */

import { config } from "../../package.json";
import { getLocaleID, getString } from "../utils/locale";
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
  `${config.addonRef}-item-add`,
];

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
    const win = Zotero.getMainWindow();
    const pane = Zotero.getActiveZoteroPane();
    const targetLibrary =
      libraryID ??
      (addon.data.scene?.libraryID ||
        (pane && getSelectedLibraryID(pane)) ||
        Zotero.Libraries.userLibraryID);
    if (
      !addon.data.scene ||
      addon.data.scene.libraryID !== targetLibrary ||
      addon.data.scene.nodes.size === 0
    ) {
      await addon.data.bridge?.loadLibrary(targetLibrary);
    }
    let board = addon.data.boards.get(win);
    if (!board || !board.isOpen) {
      board = new Board(win, addon.data.scene!);
      addon.data.boards.set(win, board);
    }
    await board.open();
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
    if (
      !addon.data.scene ||
      addon.data.scene.libraryID !== libraryID ||
      addon.data.scene.nodes.size === 0
    ) {
      await addon.data.bridge?.loadLibrary(libraryID);
    }
    const count = addon.data.bridge?.addItems(items) ?? 0;
    await addon.api.openBoard?.(libraryID);
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
    } catch (e) {
      // Menu may not be registered in this window.
    }
  }
  addon.api.openBoard = undefined;
  addon.api.addSelectedToBoard = undefined;
}
