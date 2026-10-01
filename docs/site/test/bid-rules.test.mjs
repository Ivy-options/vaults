import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

for (const width of [1440, 390, 320]) {
  test(`bid rule reference is keyboard accessible and fits at ${width}px`, async () => {
    const server = await startServer();
    const { page, errors, close } = await openPage(server.url + "index.html#bid-rules", { width, height: 900 });
    try {
      await page.waitForFunction(() => window.IvyShell?.state().guideLoaded);
      const frame = page.frames().find(f => f.parentFrame());
      await frame.evaluate(() => document.fonts.ready);
      if (process.env.IVY_DOCS_QA_DIR) {
        await frame.locator("#bid-rules").scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${process.env.IVY_DOCS_QA_DIR}/bid-rules-${width}.png` });
        await frame.locator("#bid-rules-example .tablewrap").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.IVY_DOCS_QA_DIR}/offers-${width}.png` });
      }
      const details = frame.locator("#bid-rules .bid-rule-detail");
      assert.equal(await details.count(), 8);
      assert.equal(await frame.locator("#bid-rules details[open]").count(), 0);
      for (let i = 0; i < 8; i++) {
        const rule = details.nth(i);
        const summary = rule.locator("summary");
        await summary.focus();
        await page.keyboard.press("Enter");
        assert.equal(await rule.evaluate(el => el.open), true);
        assert.equal(await rule.locator(".bid-rule-body").isVisible(), true);
        if (i === 5 && process.env.IVY_DOCS_QA_DIR) {
          await summary.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `${process.env.IVY_DOCS_QA_DIR}/volatility-${width}.png` });
        }
        const fit = await rule.evaluate(el => {
          const r = el.getBoundingClientRect();
          const body = el.querySelector(".bid-rule-body");
          return { left: r.left, right: r.right, viewport: innerWidth, overflow: body.scrollWidth - body.clientWidth };
        });
        assert.ok(fit.left >= 0 && fit.right <= fit.viewport + 1, "rule stays inside the reading viewport");
        assert.ok(fit.overflow <= 1, "expanded configuration text wraps");
        await page.keyboard.press("Space");
        assert.equal(await rule.evaluate(el => el.open), false);
      }
      assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (process.env.IVY_DOCS_QA_DIR) {
        await page.click("#themeToggle");
        await frame.locator("#bid-rules").evaluate(el => el.scrollIntoView());
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${process.env.IVY_DOCS_QA_DIR}/light-${width}.png` });
      }
      assert.deepEqual(errors, []);
    } finally {
      await close();
      await server.close();
    }
  });
}

test("bid rule details work without JavaScript and print even when closed", async () => {
  const server = await startServer();
  const { page, close } = await openPage(server.url + "index.html#bid-rules", { width: 390 });
  try {
    const browser = page.context().browser();
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    const reader = await context.newPage();
    await reader.goto(server.url + "guide.html#bid-rules");
    const rules = reader.locator("#bid-rules .bid-rule-detail");
    assert.equal(await rules.count(), 8);
    await rules.nth(5).locator("summary").click();
    assert.equal(await rules.nth(5).locator(".bid-rule-body").isVisible(), true);
    await reader.emulateMedia({ media: "print" });
    for (let i = 0; i < 8; i++) {
      assert.equal(await rules.nth(i).locator(".bid-rule-body").isVisible(), true, "printing includes closed rule details");
    }
    await context.close();
  } finally {
    await close();
    await server.close();
  }
});
