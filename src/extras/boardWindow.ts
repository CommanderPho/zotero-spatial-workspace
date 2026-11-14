/**
 * Chrome window bootstrap for the Spatial Workspace pop-out.
 * Resolves the deferred init promise passed via window.arguments so the
 * plugin can mount the board into #board-container.
 */

declare const window: Window & {
  arguments?: Array<{ _initPromise?: { resolve: () => void } }>;
};

window.addEventListener("DOMContentLoaded", () => {
  window.arguments?.[0]?._initPromise?.resolve();
});
