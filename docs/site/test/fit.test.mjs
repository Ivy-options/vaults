import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

// These run against the real docs/site/index.html rather than the small
// fixture: the fixture's proportions happen to be height-bound, which hid the
// regression where home()'s fit scale (via fly()) and homeScale() disagreed
// on the real, width-bound map (findings 1 and 2 of the whole-branch review).
const independentFitScale = (page) =>
  page.evaluate(() => {
    const map = document.querySelector("#map"), world = document.querySelector("#world");
    const W = parseFloat(world.style.width), H = parseFloat(world.style.height);
    return Math.min(map.clientWidth / (W + 160), map.clientHeight / (H + 160));
  });

test("an unresolvable hash still shows the map, at the fit scale, instead of leaving every card unshown", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html#no-such-anchor");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted);
    await settle(page, 300);
    const cards = await page.evaluate(() => [...document.querySelectorAll("#world .card")]
      .map((c) => c.hasAttribute("data-show")));
    assert.ok(cards.length > 0, "cards were rendered");
    assert.ok(cards.every(Boolean), "every card has a data-show attribute");
    const expectedFitScale = await independentFitScale(page);
    assert.equal((await page.evaluate(() => IvyMap._cam().s)), expectedFitScale, "camera lands at the fit scale");
    assert.deepEqual(await page.evaluate(() => IvyMap.here()), [], "no station reads as current at the fit scale");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("loading with no hash stays at the fit view and never rewrites the URL to a station nobody chose", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted);
    await settle(page, 300);
    assert.equal(await page.evaluate(() => location.hash), "", "the URL hash stays empty");
    assert.deepEqual(await page.evaluate(() => IvyMap.here()), [], "here() reports the whole map, not a station");
    const expectedFitScale = await independentFitScale(page);
    assert.equal((await page.evaluate(() => IvyMap._cam().s)), expectedFitScale, "camera scale equals homeScale()'s own formula");
    // Resizing while at the fit view re-fits to the new viewport (R9), which
    // only happens if the camera is recognised as being at "home".
    await page.setViewportSize({ width: 1000, height: 700 });
    await settle(page, 300);
    const refit = await independentFitScale(page);
    assert.equal((await page.evaluate(() => IvyMap._cam().s)), refit, "resize at the fit view re-fits to the new viewport");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
