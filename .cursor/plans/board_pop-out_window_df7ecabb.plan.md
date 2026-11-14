---
name: Board pop-out window
overview: Keep the existing Spatial Workspace tab, add a Better Notes–style chrome pop-out window so the board can sit beside the library, and accept `zotero/item` drops onto the board (placing cards at the drop point).
todos: []
isProject: false
---

# Board pop-out and library drag-drop挈## Goal UXs- **Tab stays default**: Tools → Open Spatial Workspace / shortcut still opens the in-window tab (unchanged).- **Pop out**: toolbar button (and Tools → “Open Spatial Workspace in Window”) moves the board into a separate resizable chrome window so the user can place it beside the library and drag papers in.- **Dock**: window toolbar button returns the board to a tab and closes the chrome window.- **Drag-and-drop**: dropping library items onto the board (tab or window) adds them via existing [`DataBridge.addItems`](src/modules/data.ts); cards land at the drop’s world coordinates when possible.Context-menu “Add to Spatial Workspace” remains.## Architecture```mermaidflowchart LR  subgraph mainWin [Zotero main window]    Library[Library item tree]    TabBoard[Board tab]  end  subgraph popWin [Chrome board window]    WinBoard[Board mount]  end  Library -->|