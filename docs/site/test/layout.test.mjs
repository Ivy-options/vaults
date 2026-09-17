import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

test("layoutWorld centres stations over rows, stacks actions and sizes tiles", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    const out = await page.evaluate(() => {
      const { nodes } = IvyMap.readDocument(document.querySelector("#document"));
      const world = IvyMap.layoutWorld(nodes, (n) => (n.kind === "action" ? 110 : n.id === "approvals" ? 40 : 60));
      const g = (id) => { const n = nodes.find((n) => n.id === id); return { x: n.x, y: n.y, w: n.w, h: n.h, column: n.column, bottom: n.bottom }; };
      return { world: { width: world.width, height: world.height, lines: world.lines }, open: g("open"), custody: g("open-custody"), m1: g("lps-deposit-collateral"), m2: g("owner-opens-the-auction"), a1: g("add-funds"), a2: g("waits"), t1: g("who-may-deposit"), t2: g("approvals"), terms: g("terms"), lab: g("fee-lab") };
    });
    const G = { station: [360, 200], moment: [300, 170], action: [300, 150], gap: 40, momentY: 320, actionY: 560, actionGap: 20, tile: 132, tileGap: 12, custody: [220, 170] };
    // Two moments: row width 640. Station centred over the row.
    const rowW = 2 * G.moment[0] + G.gap;
    assert.equal(out.m2.x - out.m1.x, G.moment[0] + G.gap);
    assert.equal(out.open.x + out.open.w / 2, out.m1.x + rowW / 2);
    assert.equal(out.m1.y, G.momentY);
    // Custody tile sits right of the station card.
    assert.equal(out.custody.x, out.open.x + out.open.w + G.gap);
    assert.equal(out.custody.y, 0);
    // Actions stack under the moment; headers are measured (110 here); the first has two tile rows (one single, one spanning).
    assert.equal(out.a1.y, G.actionY);
    assert.equal(out.a1.h, 110 + G.tileGap + (60 + G.tileGap) + (40 + G.tileGap));
    assert.equal(out.a2.h, 110);
    assert.equal(out.a2.y, out.a1.y + out.a1.h + G.actionGap);
    assert.equal(out.t1.x - out.a1.x, G.tileGap);
    assert.equal(out.t1.w, G.tile);
    assert.equal(out.t2.w, 2 * G.tile + G.tileGap);
    assert.equal(out.t2.y, out.t1.y + 60 + G.tileGap);
    assert.equal(out.m1.bottom, out.a2.y + out.a2.h);
    // Lab spans the card width and takes its measured height.
    assert.equal(out.lab.w, 2 * G.tile + G.tileGap);
    assert.equal(out.lab.h, 60);
    // The shelf band starts below the life band, and its station has a column.
    assert.ok(out.terms.y > out.m1.bottom, "shelf below life band");
    assert.ok(out.terms.column.w >= 300 + 2 * G.gap);
    assert.ok(out.world.lines.some((l) => l.kind === "main"));
    assert.ok(out.world.lines.some((l) => l.kind === "rule"));
    // Gap connectors never overlap a card: each ends where the next card starts.
    const gaps = out.world.lines.filter((l) => l.kind === "gap");
    assert.ok(gaps.some((l) => l.y === out.m1.y + out.m1.h && l.h === out.a1.y - (out.m1.y + out.m1.h)));
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
