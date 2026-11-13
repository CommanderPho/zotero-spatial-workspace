import { assert } from "chai";
import { config } from "../package.json";
import { parseFilter, parseDateBound } from "../src/modules/filter";
import { rectsIntersect } from "../src/modules/scene";

/**
 * Temporary visibility filter: hides non-matching cards without touching
 * positions or the persisted layout, and supports title / date-added /
 * last-read queries.
 */
describe("board filter", function () {
  this.timeout(120000);

  it("parses date bounds (relative and absolute)", function () {
    const now = new Date(2026, 10, 13, 12, 0, 0).getTime();
    assert.equal(
      parseDateBound("today", now),
      new Date(2026, 10, 13).getTime(),
    );
    assert.equal(parseDateBound("7d", now), now - 7 * 86400000);
    assert.equal(parseDateBound("2w", now), now - 14 * 86400000);
    assert.equal(parseDateBound("1y", now), now - 365 * 86400000);
    assert.equal(parseDateBound("2024", now), new Date(2024, 0, 1).getTime());
    assert.equal(
      parseDateBound("2024-05-01", now),
      new Date(2024, 4, 1).getTime(),
    );
    assert.isNull(parseDateBound("not-a-date", now));
  });

  it("filters by title, dates, and kind; clearing restores everything", async function () {
    const instance = Zotero[config.addonInstance];
    const libraryID = Zotero.Libraries.userLibraryID;

    // Seed items with known metadata. attachmentLastRead is an integer
    // Unix timestamp in seconds (Zotero "Last Read" column).
    const readSeconds = Math.floor(Date.now() / 1000) - 3 * 86400;

    const oldItem = new Zotero.Item("journalArticle");
    oldItem.libraryID = libraryID;
    oldItem.setField("title", "Filter Alpha Quantum");
    const oldID = await oldItem.saveTx();

    const newItem = new Zotero.Item("book");
    newItem.libraryID = libraryID;
    newItem.setField("title", "Filter Beta Gardening");
    const newID = await newItem.saveTx();

    const attachment = new Zotero.Item("attachment");
    attachment.libraryID = libraryID;
    attachment.parentID = newID;
    attachment.attachmentContentType = "application/pdf";
    attachment.attachmentLinkMode = Zotero.Attachments.LINK_MODE_IMPORTED_FILE;
    attachment.attachmentLastRead = readSeconds;
    await attachment.saveTx({ skipDateModifiedUpdate: true });

    const note = new Zotero.Item("note");
    note.libraryID = libraryID;
    note.parentID = oldID;
    note.setNote("<p>Filter note gamma.</p>");
    const noteID = await note.saveTx();

    try {
      await instance.data.bridge!.loadLibrary(libraryID);
      const scene = instance.data.scene!;
      const oldNode = scene.nodes.get(`i${oldID}`)!;
      const newNode = scene.nodes.get(`i${newID}`)!;
      const noteNode = scene.nodes.get(`n${noteID}`)!;
      assert.isNotEmpty(oldNode);
      assert.isNotEmpty(newNode);

      // Metadata bridge: added/modified populated; read time from attachment.
      assert.isNumber(oldNode.added, "dateAdded should be populated");
      assert.isNumber(oldNode.modified, "dateModified should be populated");
      assert.isNumber(newNode.read, "read time should come from attachment");
      assert.approximately(newNode.read!, readSeconds * 1000, 1000);
      assert.isUndefined(oldNode.read, "unread item has no read time");

      const originalPositions = new Map(
        [...scene.nodes.values()].map((n) => [n.id, { x: n.x, y: n.y }]),
      );

      // Title filter: only the matching card stays visible.
      scene.setFilter(parseFilter("alpha"));
      assert.isFalse(scene.isHidden(oldNode.id));
      assert.isTrue(scene.isHidden(newNode.id));
      assert.isTrue(scene.isHidden(noteNode.id));
      assert.isUndefined(
        scene.hitTest(newNode.x + 5, newNode.y + 5),
        "hidden cards must not be hit-testable",
      );
      assert.isNotEmpty(scene.hitTest(oldNode.x + 5, oldNode.y + 5));

      // Date filters: everything was added today; nothing was added in 2020.
      scene.setFilter(parseFilter("added:>2020-01-01"));
      assert.isFalse(scene.isHidden(oldNode.id));
      assert.isFalse(scene.isHidden(newNode.id));
      scene.setFilter(parseFilter("added:<2020-01-01"));
      assert.isTrue(scene.isHidden(oldNode.id));
      assert.isTrue(scene.isHidden(newNode.id));

      // Read filters: recently read (>7d = within the last 7 days),
      // stale reads (<7d = more than 7 days ago), never, and any.
      scene.setFilter(parseFilter("read:>7d"));
      assert.isFalse(scene.isHidden(newNode.id));
      assert.isTrue(scene.isHidden(oldNode.id));
      scene.setFilter(parseFilter("read:<7d"));
      assert.isTrue(scene.isHidden(newNode.id), "read 3 days ago is not stale");
      assert.isTrue(scene.isHidden(oldNode.id));
      scene.setFilter(parseFilter("read:never"));
      assert.isFalse(scene.isHidden(oldNode.id));
      assert.isTrue(scene.isHidden(newNode.id));
      scene.setFilter(parseFilter("read:any"));
      assert.isFalse(scene.isHidden(newNode.id));
      assert.isTrue(scene.isHidden(oldNode.id));

      // Kind filter.
      scene.setFilter(parseFilter("kind:note"));
      assert.isFalse(scene.isHidden(noteNode.id));
      assert.isTrue(scene.isHidden(oldNode.id));
      assert.isTrue(scene.isHidden(newNode.id));

      // Filtered bounds only cover visible nodes (zoom-to-fit target).
      scene.setFilter(parseFilter("alpha"));
      const bounds = scene.bounds();
      assert.isNotEmpty(bounds);
      assert.isAtMost(bounds!.x, oldNode.x);
      assert.isAtLeast(bounds!.x + bounds!.w, oldNode.x + oldNode.w);
      assert.isFalse(
        rectsIntersect(bounds!, newNode),
        "hidden card must be outside the fit bounds",
      );

      // Clearing restores visibility and leaves positions untouched.
      scene.setFilter(parseFilter(""));
      assert.equal(scene.hiddenCount, 0);
      for (const [id, pos] of originalPositions) {
        const node = scene.nodes.get(id)!;
        assert.equal(node.x, pos.x, `${id} x unchanged by filtering`);
        assert.equal(node.y, pos.y, `${id} y unchanged by filtering`);
      }

      // The filter is view state: it must not leak into the saved layout.
      scene.setFilter(parseFilter("alpha"));
      await instance.data.layout!.flush();
      const layoutPath = PathUtils.join(
        Zotero.DataDirectory.dir,
        "spatialworkspace",
        `layout-${libraryID}.json`,
      );
      const layout = JSON.parse(await IOUtils.readUTF8(layoutPath));
      assert.equal(layout.nodes.length, scene.nodes.size);
      assert.isUndefined(layout.filter);

      // Toolbar UI: typing a query hides cards, clearing shows them again.
      await instance.api.openBoard(libraryID);
      const win = Zotero.getMainWindow();
      const board = instance.data.boards.get(win)!;
      const input = win.document.querySelector<HTMLInputElement>(
        `input.${config.addonRef}-filter-input`,
      );
      assert.isNotNull(input, "filter input should be mounted");
      input!.value = "beta";
      input!.dispatchEvent(new win.Event("input", { bubbles: true }));
      assert.isTrue(scene.isHidden(oldNode.id));
      assert.isFalse(scene.isHidden(newNode.id));
      const status = win.document.querySelector(`.${config.addonRef}-status`)!;
      assert.include(status.textContent, "filtered");

      board.clearFilter();
      assert.equal(scene.hiddenCount, 0);
      assert.equal(input!.value, "");

      // Hidden nodes cannot be selected, and a name-matched region reveals
      // its members while a non-matching member stays hidden + unselectable.
      const collection = new Zotero.Collection();
      collection.libraryID = libraryID;
      collection.name = "Filter Region Gamma";
      const collectionID = await collection.saveTx();
      try {
        const memberItem = new Zotero.Item("journalArticle");
        memberItem.libraryID = libraryID;
        memberItem.setField("title", "Filter Region Member");
        memberItem.setCollections([collectionID]);
        const memberID = await memberItem.saveTx();
        await instance.data.bridge!.loadLibrary(libraryID);
        const region = scene.nodes.get(`c${collectionID}`)!;
        const member = scene.nodes.get(`i${memberID}`)!;

        // Query matches the region name but not the member title.
        scene.setFilter(parseFilter("gamma"));
        assert.isFalse(scene.isHidden(region.id), "region name matches");
        assert.isTrue(scene.isHidden(member.id), "member does not match");
        scene.select([member.id]);
        assert.isFalse(
          scene.selection.has(member.id),
          "hidden member must not be selectable",
        );
        scene.select([region.id]);
        assert.isTrue(scene.selection.has(region.id));

        // Clearing the filter restores the member and makes it selectable.
        scene.setFilter(parseFilter(""));
        assert.isFalse(scene.isHidden(member.id));
        scene.select([member.id]);
        assert.isTrue(scene.selection.has(member.id));
        scene.clearSelection();
        await Zotero.Items.erase([memberID]);
      } finally {
        await Zotero.Collections.erase([collectionID]);
      }
    } finally {
      // Cleanup seeded data so other tests see a tidy library.
      await Zotero.Items.erase([oldID, newID, noteID]);
    }
  });
});
