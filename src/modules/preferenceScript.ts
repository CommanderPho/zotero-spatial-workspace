import { config } from "../../package.json";
import { getPref } from "../utils/prefs";

export function registerPrefsScripts(window: Window) {
  // Called when the prefs pane loads (see preferences.xhtml onload).
  const doc = window.document;

  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-shownotes`)
    ?.addEventListener("command", () => {
      for (const board of addon.data.boards.values()) {
        board.refresh();
      }
    });

  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-labeldetail`)
    ?.addEventListener("command", () => {
      for (const board of addon.data.boards.values()) {
        board.refresh();
      }
    });

  doc
    .querySelector(`#zotero-prefpane-${config.addonRef}-autosave`)
    ?.addEventListener("change", () => {
      const delay = Number(getPref("autosaveDelayMs"));
      if (Number.isFinite(delay) && delay >= 100) {
        addon.data.layout?.setSaveDelay(delay);
      }
    });
}
