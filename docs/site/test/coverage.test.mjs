import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";
import { REQUIRED } from "./required-anchors.mjs";

test("every old anchor resolves, every moment has one summary paragraph, no tile overflows", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html");
  try {
    await page.waitForFunction(() => IvyMap.mounted);
    const missing = await page.evaluate((ids) => ids.filter((id) => !IvyMap.resolveHash("#" + id)), REQUIRED);
    assert.deepEqual(missing, [], "anchors without a node");
    const lint = await page.evaluate(() => IvyMap.mounted.tree.nodes.flatMap((n) => {
      const out = [];
      if (n.kind === "moment" && n.source.querySelectorAll(":scope > p").length !== 1) out.push(`${n.id}: moment needs exactly one summary paragraph`);
      if (n.kind === "action" && !n.summary) out.push(`${n.id}: action needs a paragraph`);
      if ((n.kind === "tile") && !n.source.querySelector(":scope > h5")) out.push(`${n.id}: tile needs an h5`);
      if (n.kind === "moment" && n.label.split(" ").length < 3) out.push(`${n.id}: moment title must be a sentence, not a label`);
      return out;
    }));
    assert.deepEqual(lint, []);
    for (const lod of [0, 1, 2, 3]) {
      const overflow = await page.evaluate((lod) => {
        IvyMap.setLod(lod);
        return [...document.querySelectorAll("#world .card")].flatMap((card) => {
          const layer = card.querySelector(`:scope > [data-tier="${card.dataset.show}"]`);
          return layer && (layer.scrollHeight > layer.clientHeight + 1 || layer.scrollWidth > layer.clientWidth + 1) ? [`${card.dataset.id}@${lod}`] : [];
        });
      }, lod);
      assert.deepEqual(overflow, [], `overflow at lod ${lod}`);
    }
    const stations = await page.evaluate(() => IvyMap.mounted.tree.nodes.filter((n) => n.kind === "station").map((n) => n.id));
    assert.deepEqual(stations, ["before-the-vault", "open", "auction", "live", "settled", "project"]);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
