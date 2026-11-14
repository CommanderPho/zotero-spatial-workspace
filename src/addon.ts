import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import type { SceneStore } from "./modules/scene";
import type { LayoutStore } from "./modules/persistence";
import type { DataBridge } from "./modules/data";
import type { Board } from "./modules/board";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    scene?: SceneStore;
    layout?: LayoutStore;
    bridge?: DataBridge;
    boards: Map<Window, Board>;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: {
    openBoard?: (libraryID?: number) => Promise<void>;
    openBoardWindow?: (libraryID?: number) => Promise<void>;
    addSelectedToBoard?: () => Promise<void>;
  };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      boards: new Map(),
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
