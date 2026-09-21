import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

test("the map page loads without errors and mounts the engine", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html?view=map");
  try {
    assert.equal(await page.evaluate(() => typeof window.IvyMap), "object");
    assert.ok(await page.$("#map"), "#map mount exists");
    assert.ok(await page.$("#document"), "#document exists");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
