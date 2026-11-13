declare const _globalThis: {
  [key: string]: any;
  Zotero: _ZoteroTypes.Zotero;
  ztoolkit: ZToolkit;
  addon: typeof addon;
};

declare type ZToolkit = ReturnType<
  typeof import("../src/utils/ztoolkit").createZToolkit
>;

declare const ztoolkit: ZToolkit;

declare const rootURI: string;

declare const addon: import("../src/addon").default;

declare const __env__: "production" | "development";

// NOTE: Do NOT declare main-window globals (ZoteroPane, Zotero_Tabs, etc.)
// here. The plugin bundle runs in the bootstrap sandbox where they do not
// exist. Access them via Zotero.getActiveZoteroPane() or
// Zotero.getMainWindow().ZoteroPane / .Zotero_Tabs instead.
