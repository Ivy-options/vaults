import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

const state = (page) => page.evaluate(() => IvyMap.state());

test("wheel zooms at the cursor, drag pans, click flies, Esc steps out", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#world .card").length > 0);
    const home = await state(page);
    assert.deepEqual(home.path, []);
    assert.equal(home.lod, 0);
    // Wheel in over the "Open" station: the point under the cursor stays put.
    const box = await page.locator('.card[data-id="open"]').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + 20;
    await page.mouse.move(cx, cy);
    for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(20); }
    await settle(page, 300);
    const after = await page.locator('.card[data-id="open"]').boundingBox();
    assert.ok(Math.abs(after.x + after.width / 2 - cx) < 8, "anchor x drift");
    assert.ok((await state(page)).scale > home.scale);
    // Drag pans by the pointer distance: read the camera before and after and
    // assert it moved by exactly the pointer delta (R8) — proves panning, not
    // just that the CSS transform matches whatever the camera happens to be.
    await page.evaluate(() => IvyMap.home(false));
    await page.evaluate(() => IvyMap.zoomBy(1.5));
    const before = await page.evaluate(() => IvyMap._cam());
    const map = await page.locator("#map").boundingBox();
    await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2); await page.mouse.down();
    await page.mouse.move(map.x + map.width / 2 + 120, map.y + map.height / 2 + 80, { steps: 6 }); await page.mouse.up();
    await settle(page, 200);
    const afterDrag = await page.evaluate(() => IvyMap._cam());
    assert.equal(afterDrag.x - before.x, 120, "camera x moved by drag delta");
    assert.equal(afterDrag.y - before.y, 80, "camera y moved by drag delta");
    assert.equal(afterDrag.s, before.s, "drag does not change scale");
    // Home, then click through three levels.
    await page.evaluate(() => IvyMap.home(false));
    await page.click('.card[data-id="open"]'); await settle(page);
    assert.deepEqual((await state(page)).path, ["open"]);
    await page.click('.card[data-id="lps-deposit-collateral"]'); await settle(page);
    assert.deepEqual((await state(page)).path, ["open", "lps-deposit-collateral"]);
    await page.click('.card[data-id="add-funds"]'); await settle(page);
    assert.deepEqual((await state(page)).path, ["open", "lps-deposit-collateral", "add-funds"]);
    assert.equal((await state(page)).lod, 3);
    assert.equal(await page.textContent("#crumbs"), "Whole map›Open›LPs deposit collateral›LP: Add funds");
    await page.keyboard.press("Escape"); await settle(page);
    assert.deepEqual((await state(page)).path, ["open", "lps-deposit-collateral"]);
    await page.keyboard.press("Escape"); await settle(page);
    await page.keyboard.press("Escape"); await settle(page);
    assert.deepEqual((await state(page)).path, []);
    // Toolbar zoom buttons and Fit.
    await page.click('[data-zoom="+"]'); await settle(page);
    assert.ok((await state(page)).scale > home.scale);
    await page.click("[data-home]"); await settle(page);
    assert.equal((await state(page)).scale, home.scale);
    // The reader cannot zoom out past "whole world fits": the wheel handler and
    // zoomBy both clamp their floor to homeScale() (not homeScale() * 0.8).
    await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(20); }
    await settle(page, 200);
    await page.evaluate(() => IvyMap.zoomBy(1 / 1.5));
    await settle(page, 200);
    assert.equal((await state(page)).scale, home.scale, "cannot zoom out past the home/fit scale");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

// The fit-scale formula, computed independently in the page from the map's
// current client size and the world's intrinsic size — same shape as map.js's
// own homeScale(), but not calling into IvyMap at all, so this can't pass just
// because the handler happens to leave the camera untouched.
const independentFitScale = (page) =>
  page.evaluate(() => {
    const map = document.querySelector("#map"), world = document.querySelector("#world");
    const W = parseFloat(world.style.width), H = parseFloat(world.style.height);
    return Math.min(map.clientWidth / (W + 160), map.clientHeight / (H + 160));
  });

test("resize at home re-fits; resize while zoomed keeps the camera path", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#world .card").length > 0);
    // At home (whole-map view), a resize should re-fit to the new viewport (R9).
    // Read the scale before resizing, resize to a clearly different size, and
    // read the scale again WITHOUT calling home() ourselves — if the resize
    // handler's re-fit branch were removed, the camera would stay at the old
    // scale and both assertions below would fail.
    const preResizeScale = (await state(page)).scale;
    await page.setViewportSize({ width: 1000, height: 700 });
    await settle(page, 200);
    const postResizeScale = (await state(page)).scale;
    const expectedFitScale = await independentFitScale(page);
    assert.notEqual(postResizeScale, preResizeScale, "resize at home changes the scale");
    assert.equal(postResizeScale, expectedFitScale, "resize at home re-fits to the new viewport");
    // Zoomed into a moment, a resize keeps the path unchanged (just clamps).
    await page.evaluate(() => IvyMap.flyTo("lps-deposit-collateral", false));
    const zoomedPath = (await state(page)).path;
    assert.deepEqual(zoomedPath, ["open", "lps-deposit-collateral"]);
    await page.setViewportSize({ width: 900, height: 700 });
    await settle(page, 200);
    assert.deepEqual((await state(page)).path, zoomedPath);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
