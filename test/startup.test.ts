import { assert } from "chai";
import { config } from "../package.json";

describe("startup", function () {
  it("should have plugin instance defined", function () {
    assert.isNotEmpty(Zotero[config.addonInstance]);
  });

  it("should initialize the spatial scene and layout store", function () {
    const instance = Zotero[config.addonInstance];
    assert.isTrue(instance.data.initialized);
    assert.isNotEmpty(instance.data.scene);
    assert.isNotEmpty(instance.data.layout);
    assert.isNotEmpty(instance.data.bridge);
  });

  it("should open the board tab with a mounted canvas", async function () {
    this.timeout(60000);
    const instance = Zotero[config.addonInstance];

    // Seed a small library so the test is self-contained even in a fresh
    // test profile with an empty data directory.
    const libraryID = Zotero.Libraries.userLibraryID;
    const collection = new Zotero.Collection();
    collection.libraryID = libraryID;
    collection.name = "Spatial Test Collection";
    await collection.saveTx();

    const item = new Zotero.Item("journalArticle");
    item.libraryID = libraryID;
    item.setField("title", "Spatial Workspace Test Paper");
    item.setField("date", "2026-01-01");
    item.setCreators([
      { creatorType: "author", firstName: "Test", lastName: "Author" },
    ]);
    item.setCollections([collection.id]);
    const itemID = await item.saveTx();

    const note = new Zotero.Item("note");
    note.libraryID = libraryID;
    note.parentID = itemID;
    note.setNote("<p>A test note for the spatial board.</p>");
    await note.saveTx();

    await instance.api.openBoard(libraryID);

    const win = Zotero.getMainWindow();
    const board = instance.data.boards.get(win);
    assert.isNotEmpty(board, "board should be registered for the main window");
    assert.isTrue(board!.isOpen, "board tab should be open");

    const canvas = win.document.querySelector(
      `canvas.${config.addonRef}-canvas`,
    );
    assert.isNotNull(canvas, "board canvas should be mounted");
    assert.instanceOf(canvas, win.HTMLCanvasElement);

    const scene = instance.data.scene!;
    assert.isTrue(scene.nodes.has(`c${collection.id}`), "collection region");
    assert.isTrue(scene.nodes.has(`i${itemID}`), "item card");
    assert.isTrue(scene.nodes.has(`n${note.id}`), "note card");

    // Layout persistence: a flush should write the per-library layout file.
    await instance.data.layout!.flush();
    const layoutPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "spatialworkspace",
      `layout-${libraryID}.json`,
    );
    assert.isTrue(
      await IOUtils.exists(layoutPath),
      "layout file should be written",
    );
    const layout = JSON.parse(await IOUtils.readUTF8(layoutPath));
    assert.equal(layout.libraryID, libraryID);
    assert.isAbove(layout.nodes.length, 0);

    // Overlay semantics: the Zotero collection must still contain the item.
    const reloaded = Zotero.Items.get(itemID);
    assert.include(
      reloaded.getCollections(),
      collection.id,
      "Zotero collection membership must be untouched",
    );

    // Layout restore: move a card, save, reload the library, and confirm
    // the saved position is restored (simulates a Zotero restart).
    const itemNodeID = `i${itemID}`;
    scene.moveSilent(itemNodeID, 1234, 5678);
    scene.endBatch();
    await instance.data.layout!.flush();
    await instance.data.bridge!.loadLibrary(libraryID);
    const restored = instance.data.scene!.nodes.get(itemNodeID);
    assert.isNotEmpty(restored, "item node should survive reload");
    assert.equal(restored!.x, 1234, "saved x position should be restored");
    assert.equal(restored!.y, 5678, "saved y position should be restored");
  });
});
