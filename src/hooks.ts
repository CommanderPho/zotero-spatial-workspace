import { getString, initLocale } from "./utils/locale";
import { registerPrefsScripts } from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { SceneStore } from "./modules/scene";
import { LayoutStore } from "./modules/persistence";
import { DataBridge } from "./modules/data";
import { Board } from "./modules/board";
import { registerCommands, unregisterCommands } from "./modules/commands";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();

  registerPrefsPane();

  addon.data.scene = new SceneStore();
  addon.data.layout = new LayoutStore(addon.data.scene);
  addon.data.bridge = new DataBridge(
    addon.data.scene,
    addon.data.layout,
    () => {
      for (const board of addon.data.boards.values()) {
        board.onSceneChanged();
      }
    },
  );
  addon.data.bridge.registerNotifier();

  registerShortcuts();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerCommands(win);

  new ztoolkit.ProgressWindow(addon.data.config.addonName, {
    closeOnClick: true,
    closeTime: 3000,
  })
    .createLine({
      text: getString("startup-finish"),
      type: "success",
      progress: 100,
    })
    .show();
}

async function onMainWindowUnload(win: Window): Promise<void> {
  const board = addon.data.boards.get(win);
  if (board) {
    board.destroy();
    addon.data.boards.delete(win);
  }
  unregisterCommands();
  ztoolkit.unregisterAll();
}

async function onShutdown(): Promise<void> {
  for (const board of addon.data.boards.values()) {
    board.destroy();
  }
  addon.data.boards.clear();
  unregisterCommands();
  ztoolkit.unregisterAll();
  addon.data.bridge?.unregisterNotifier();
  await addon.data.layout?.flush();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Dispatcher for Zotero Notify events. Forwarded to the data bridge, which
 * keeps the spatial scene in sync with the library.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  if (!addon?.data.alive) {
    return;
  }
  await addon.data.bridge?.handleNotify(event, type, ids, extraData);
}

/**
 * Dispatcher for Preference UI events.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(type: string) {
  switch (type) {
    case "open-board":
      void addon.api.openBoard?.();
      break;
    default:
      break;
  }
}

function registerPrefsPane() {
  Zotero.PreferencePanes.register({
    pluginID: addon.data.config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${addon.data.config.addonRef}/content/icons/favicon.png`,
  });
}

function registerShortcuts() {
  ztoolkit.Keyboard.register((ev, keyOptions) => {
    if (keyOptions.type !== "keydown") {
      return;
    }
    // Ctrl/Cmd+Shift+W opens or focuses the spatial board
    if (keyOptions.keyboard?.equals("accel,shift,w")) {
      ev.preventDefault();
      addon.hooks.onShortcuts("open-board");
    }
  });
}

// Hooks only do dispatch. Don't add code that does real jobs in hooks.
export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
};
