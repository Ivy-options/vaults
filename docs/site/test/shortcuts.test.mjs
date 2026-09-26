import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

const isOpen = (page) => page.evaluate(() => document.querySelector("#shortcuts").matches(":popover-open"));

test("the shortcuts list opens from its toolbar button and the ? key, and Escape closes it without moving the camera", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html?view=map");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted);
    await settle(page, 300);
    assert.equal(await isOpen(page), false);

    await page.click("#shortcuts-toggle");
    assert.equal(await isOpen(page), true, "toolbar button opens the list");
    await page.click("#shortcuts-toggle");
    assert.equal(await isOpen(page), false, "toolbar button closes the list");

    await page.evaluate(() => IvyMap.flyTo("lps-deposit-collateral", false));
    await settle(page, 200);
    await page.focus("#map");
    const pathBefore = await page.evaluate(() => IvyMap.here().map((n) => n.id));
    await page.keyboard.press("?");
    assert.equal(await isOpen(page), true, "? opens the list");
    await page.keyboard.press("Escape");
    await settle(page, 200);
    assert.equal(await isOpen(page), false, "Escape closes the list");
    assert.deepEqual(await page.evaluate(() => IvyMap.here().map((n) => n.id)), pathBefore, "Escape did not also zoom out");

    await page.focus("#search-input");
    await page.keyboard.press("?");
    assert.equal(await isOpen(page), false, "typing ? in search stays in the search box");
    assert.equal(await page.inputValue("#search-input"), "?");

    await page.focus("#map");
    await page.keyboard.press("?");
    await page.click("#mode-tab-guide");
    assert.equal(await isOpen(page), false, "switching to the Guide closes the map's shortcuts");
    assert.equal(await page.isVisible("#shortcuts-toggle"), false, "the Guide toolbar has no shortcuts button");
    await page.keyboard.press("?");
    assert.equal(await isOpen(page), false, "? does nothing in the Guide");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
