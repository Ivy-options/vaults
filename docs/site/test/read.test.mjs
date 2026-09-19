import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

test("readDocument turns nested sections into a node tree", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    const tree = await page.evaluate(() => {
      const { nodes } = IvyMap.readDocument(document.querySelector("#document"));
      return nodes.map((n) => ({ id: n.id, kind: n.kind, band: n.band, label: n.label, actor: n.actor, dim: n.dim, when: n.when, tagline: n.tagline, summary: n.summary, path: n.path, parent: n.parent?.id ?? null, children: n.children.map((c) => c.id), span: n.span }));
    });
    const byId = Object.fromEntries(tree.map((n) => [n.id, n]));
    assert.equal(byId.open.kind, "station");
    assert.equal(byId.open.band, "life");
    assert.equal(byId.open.tagline, "Funding the vault.");
    assert.deepEqual(byId.open.children, ["open-custody", "lps-deposit-collateral", "owner-opens-the-auction"]);
    assert.equal(byId["lps-deposit-collateral"].when, "while Open");
    assert.equal(byId["lps-deposit-collateral"].summary, "LPs add collateral and receive shares.");
    assert.equal(byId["add-funds"].actor, "lp");
    assert.equal(byId["add-funds"].path, "open/lps-deposit-collateral/add-funds");
    assert.equal(byId.waits.dim, true);
    assert.equal(byId.approvals.span, 2);
    assert.equal(byId["fee-lab"].kind, "lab");
    assert.equal(byId.terms.band, "shelf");
    assert.equal(byId["strike-limit-rules"].actor, null);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("readDocument throws on authoring errors", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    const results = await page.evaluate(() => {
      const buildRoot = (html) => {
        const div = document.createElement("div");
        div.innerHTML = html;
        return div.firstElementChild;
      };
      const tryRead = (html) => {
        try {
          IvyMap.readDocument(buildRoot(html));
          return null;
        } catch (e) {
          return e.message;
        }
      };
      return {
        duplicate: tryRead('<main><article><section data-kind="station" id="dup"><h2>A</h2></section><section data-kind="station" id="dup"><h2>B</h2></section></article></main>'),
        unknownKind: tryRead('<main><article><section data-kind="bogus" id="x"><h2>A</h2></section></article></main>'),
        missingId: tryRead('<main><article><section data-kind="station"><h2>A</h2></section></article></main>'),
        // A <section> with no data-kind at all is invisible to the
        // ":scope > section[data-kind]" walk, so without a check it would
        // silently drop its whole subtree from the map instead of erroring.
        missingKind: tryRead('<main><article><section data-kind="station" id="s"><h2>A</h2><section id="orphan"><h3>B</h3></section></section></article></main>'),
      };
    });
    assert.match(results.duplicate, /Duplicate node id/);
    assert.match(results.unknownKind, /Unknown data-kind/);
    assert.match(results.missingId, /Section without id/);
    assert.match(results.missingKind, /Section without data-kind/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
