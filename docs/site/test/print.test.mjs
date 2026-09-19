import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

// map.css previously had no @media print rule at all: the mounted page keeps
// #map fixed-height and overflow:hidden and #document display:none for the
// whole session, so printing captured one page of whatever the camera
// happened to be framing, and the document itself was unreachable to print.
test("printing the mounted map shows the document, not the fixed-height viewport", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html");
  let dir;
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted);
    await settle(page, 300);
    await page.emulateMedia({ media: "print" });
    const styles = await page.evaluate(() => ({
      mapDisplay: getComputedStyle(document.querySelector("#map")).display,
      toolbarDisplay: getComputedStyle(document.querySelector("#toolbar")).display,
      documentDisplay: getComputedStyle(document.querySelector("#document")).display,
      documentOverflow: getComputedStyle(document.querySelector("#document")).overflow,
      htmlOverflow: getComputedStyle(document.documentElement).overflow,
      bodyOverflow: getComputedStyle(document.body).overflow,
    }));
    assert.equal(styles.mapDisplay, "none", "#map is hidden when printing");
    assert.equal(styles.toolbarDisplay, "none", "#toolbar is hidden when printing");
    assert.equal(styles.documentDisplay, "block", "#document is shown when printing");
    assert.equal(styles.documentOverflow, "visible", "#document does not clip to a scroll box when printing");
    assert.equal(styles.htmlOverflow, "visible", "html is not clipped to the viewport when printing");
    assert.equal(styles.bodyOverflow, "visible", "body is not clipped to the viewport when printing");

    dir = await mkdtemp(join(tmpdir(), "ivy-print-"));
    const pdfPath = join(dir, "map.pdf");
    await page.pdf({ path: pdfPath });
    const pdf = await readFile(pdfPath);
    const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    assert.ok(pageCount > 1, `expected the whole document to print as more than one page, got ${pageCount}`);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});
