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

// Regression: the skip link targets "#map", which is page chrome, not a
// content node. followHash() used to fall through to home() for ANY
// unresolvable hash, so "Skip to content" while zoomed in threw the reader
// back to the whole-map view. A hash naming real page chrome must be a
// no-op instead; only a hash matching nothing at all still goes home.
test("the skip link's #map hash leaves the camera in place; a hash matching nothing still goes home", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html#open");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted);
    await settle(page, 300);
    const before = await page.evaluate(() => IvyMap.state());
    assert.deepEqual(before.path, ["open"], "loaded zoomed into the open station");
    // Activate the real skip link, exactly as a keyboard/screen-reader user
    // would: it's a fixed, off-screen-until-:focus link (docs.css), so
    // focus it and press Enter rather than page.click(), which refuses to
    // click something rendered outside the viewport.
    await page.focus(".skip-link");
    await page.keyboard.press("Enter");
    await settle(page, 300);
    const afterSkip = await page.evaluate(() => IvyMap.state());
    assert.equal(await page.evaluate(() => location.hash), "#map", "the skip link did navigate the hash");
    assert.equal(afterSkip.scale, before.scale, "camera scale is unchanged by the #map skip link");
    assert.deepEqual(afterSkip.path, before.path, "camera path is unchanged by the #map skip link");
    // A hash that matches nothing at all still falls through to home().
    await page.evaluate(() => { location.hash = "#nonsense"; });
    await settle(page, 300);
    const cards = await page.evaluate(() => [...document.querySelectorAll("#world .card")]
      .map((c) => c.hasAttribute("data-show")));
    assert.ok(cards.length > 0, "cards were rendered");
    assert.ok(cards.every(Boolean), "every card has a data-show attribute");
    const expectedFitScale = await independentFitScale(page);
    assert.equal((await page.evaluate(() => IvyMap._cam().s)), expectedFitScale, "#nonsense lands at the fit scale");
    assert.deepEqual((await page.evaluate(() => IvyMap.state())).path, [], "#nonsense clears the camera path");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

// The root (the apex above the whole timeline) sits one level above a
// station: stepping out of a bare station should reach it, not jump straight
// past it to the fit view, and stepping out of the root itself should reach
// the fit view, same as before roots existed.
test("flying out from a station reaches the root, and out of the root reaches the fit view", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html#open");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted);
    await settle(page, 300);
    assert.deepEqual((await page.evaluate(() => IvyMap.here().map((n) => n.id))), ["open"], "loaded zoomed into the open station");
    await page.keyboard.press("Escape");
    await settle(page, 300);
    assert.deepEqual((await page.evaluate(() => IvyMap.here().map((n) => n.id))), ["a-vaults-life"], "stepping out of a station reaches the root");
    await page.keyboard.press("Escape");
    await settle(page, 300);
    assert.deepEqual((await page.evaluate(() => IvyMap.here())), [], "stepping out of the root reaches the fit view (\"Whole map\")");
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
