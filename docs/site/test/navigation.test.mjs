import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

const state = (page) => page.evaluate(() => IvyMap.state());

test("hash, aliases, search, keyboard and reading view", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html#add-funds");
  try {
    await page.waitForFunction(() => IvyMap.mounted);
    await settle(page, 300);
    assert.deepEqual((await state(page)).path, ["open", "lps-deposit-collateral", "add-funds"], "hash frames the node on load");
    // Flying updates the hash; an alias resolves.
    await page.evaluate(() => { IvyMap.ALIASES["old-anchor"] = "owner-opens-the-auction"; });
    await page.evaluate(() => IvyMap.flyTo("owner-opens-the-auction", false));
    assert.equal(await page.evaluate(() => location.hash), "#owner-opens-the-auction");
    await page.evaluate(() => { location.hash = "#old-anchor"; });
    await settle(page, 300);
    assert.deepEqual((await state(page)).path, ["open", "owner-opens-the-auction"]);
    // Search.
    const hits = await page.evaluate(() => IvyMap.search("mints shares").map((h) => h.node.id));
    assert.equal(hits[0], "add-funds");
    await page.fill("#search-input", "approvals");
    await page.waitForSelector("#search-results li");
    await page.keyboard.press("Enter"); await settle(page);
    assert.equal((await state(page)).path.at(-1), "approvals");
    // Keyboard: focus the map, Home goes to the station, arrows move between siblings, Enter flies in.
    await page.focus("#map");
    await page.keyboard.press("Home"); await settle(page);
    assert.deepEqual((await state(page)).path, ["open"]);
    await page.keyboard.press("ArrowDown"); // into the first moment
    await page.keyboard.press("ArrowRight"); // next moment
    await page.keyboard.press("Enter"); await settle(page);
    assert.deepEqual((await state(page)).path, ["open", "owner-opens-the-auction"]);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), "owner-opens-the-auction");
    // Reading view shows the document and hides the map.
    await page.click("#reading-toggle");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#map")).display), "none");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#document")).display), "block");
    await page.click("#reading-toggle");
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#document")).display), "none");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("without JavaScript the document is a readable page with every heading", async () => {
  const server = await startServer();
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ javaScriptEnabled: false });
  try {
    await page.goto(server.url + "test/fixtures/tree.html");
    const headings = await page.$$eval("#document h2, #document h3, #document h4, #document h5", (els) => els.map((e) => e.textContent.trim()));
    assert.deepEqual(headings.slice(0, 5), ["Open", "What the vault holds", "LPs deposit collateral", "Add funds", "Who may deposit"]);
    assert.equal(await page.$eval("#document", (e) => getComputedStyle(e).display), "block");
  } finally {
    await browser.close();
    await server.close();
  }
});
