import { assert } from "chai";
import { config } from "../package.json";
import { rectsIntersect, type SceneNode } from "../src/modules/scene";

/**
 * Regression test for the default layout: collection regions used to be
 * placed on a fixed-size grid and then grown around their members, so large
 * collections overlapped their neighbours, and note cards landed on top of
 * the next column's item cards.
 */
describe("default layout", function () {
  this.timeout(120000);

  it("lays out regions and cards without any overlap", async function () {
    const instance = Zotero[config.addonInstance];
    const libraryID = Zotero.Libraries.userLibraryID;

    // Seed collections of very different sizes; the large one overflowed
    // the old fixed grid cell (3x3 cards) into the next region.
    const sizes = [30, 12, 7, 3, 0];
    const collectionIDs: number[] = [];
    for (let i = 0; i < sizes.length; i++) {
      const collection = new Zotero.Collection();
      collection.libraryID = libraryID;
      collection.name = `Layout Test Collection ${i}`;
      collectionIDs.push(await collection.saveTx());
    }

    const itemIDs: number[] = [];
    for (let c = 0; c < sizes.length; c++) {
      for (let i = 0; i < sizes[c]; i++) {
        const item = new Zotero.Item("journalArticle");
        item.libraryID = libraryID;
        item.setField("title", `Layout Paper ${c}-${i}`);
        item.setCollections([collectionIDs[c]]);
        itemIDs.push(await item.saveTx());
      }
    }
    // A few unfiled items.
    for (let i = 0; i < 5; i++) {
      const item = new Zotero.Item("book");
      item.libraryID = libraryID;
      item.setField("title", `Layout Unfiled ${i}`);
      itemIDs.push(await item.saveTx());
    }
    // Multi-note items: notes must not land on neighbouring cards.
    for (const itemID of itemIDs.slice(0, 3)) {
      for (let n = 0; n < 3; n++) {
        const note = new Zotero.Item("note");
        note.libraryID = libraryID;
        note.parentID = itemID;
        note.setNote(`<p>Layout note ${n} for item ${itemID}.</p>`);
        await note.saveTx();
      }
    }

    // Fresh layout (no saved positions) for the seeded library.
    await instance.data.bridge!.loadLibrary(libraryID);
    const scene = instance.data.scene!;

    const nodes = [...scene.nodes.values()];
    assert.isAbove(nodes.length, 0, "scene should contain nodes");

    const assertNoOverlaps = (list: SceneNode[], label: string) => {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          assert.isFalse(
            rectsIntersect(list[i], list[j]),
            `${label}: ${list[i].id} (${list[i].title}) overlaps ` +
              `${list[j].id} (${list[j].title})`,
          );
        }
      }
    };

    // Regions must not overlap each other.
    assertNoOverlaps(
      nodes.filter((n) => n.kind === "collection"),
      "regions",
    );
    // Cards and notes must not overlap each other (the old note lane bug).
    assertNoOverlaps(
      nodes.filter((n) => n.kind !== "collection"),
      "cards",
    );
    // Every member card must sit fully inside its own region.
    for (const node of nodes) {
      if (node.kind === "collection" || !node.parentRegionID) {
        continue;
      }
      const region = scene.nodes.get(node.parentRegionID);
      assert.isNotEmpty(region, `region ${node.parentRegionID} should exist`);
      assert.isAtLeast(node.x, region!.x, `${node.id} inside region left`);
      assert.isAtLeast(node.y, region!.y, `${node.id} inside region top`);
      assert.isAtMost(
        node.x + node.w,
        region!.x + region!.w,
        `${node.id} inside region right`,
      );
      assert.isAtMost(
        node.y + node.h,
        region!.y + region!.h,
        `${node.id} inside region bottom`,
      );
    }

    // The Arrange action must produce a clean layout too, even after the
    // user has dragged cards around.
    const first = nodes.find((n) => n.kind === "item")!;
    scene.moveSilent(first.id, first.x + 5000, first.y + 5000);
    scene.endBatch();
    const win = Zotero.getMainWindow();
    await instance.api.openBoard(libraryID);
    const board = instance.data.boards.get(win)!;
    board.autoArrange();
    assertNoOverlaps(
      [...scene.nodes.values()].filter((n) => n.kind === "collection"),
      "regions after arrange",
    );
    assertNoOverlaps(
      [...scene.nodes.values()].filter((n) => n.kind !== "collection"),
      "cards after arrange",
    );
  });
});
