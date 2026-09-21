import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

// assets/embed.js is a no-op outside a frame (window.self === window.top),
// which is the normal way every classic page is opened on its own. The
// framed case — the shell's Guide view hiding this same .topbar — is
// exercised in shell.test.mjs, against the real iframe.
for (const page of ["index.html", "operations.html", "license.html"]) {
  test(`${page} opened standalone keeps its own top bar and is not marked embedded`, async () => {
    const server = await startServer();
    const { page: tab, errors, close } = await openPage(server.url + page);
    try {
      const state = await tab.evaluate(() => ({
        display: getComputedStyle(document.querySelector(".topbar")).display,
        embedded: document.documentElement.classList.contains("ivy-embedded"),
      }));
      assert.notEqual(state.display, "none", "the standalone page shows its own top bar");
      assert.equal(state.embedded, false);
      assert.deepEqual(errors, []);
    } finally {
      await close();
      await server.close();
    }
  });
}
