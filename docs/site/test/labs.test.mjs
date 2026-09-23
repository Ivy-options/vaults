import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

test("every lab computes the documented worked examples inside its own scope", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/labs.html");
  try {
    await page.evaluate(() => IvyLabs.mountAll(document));
    // Checkbox/radio rows sit inline (label wraps the input and its text), not stacked.
    for (const selector of [".consent-controls label", ".registry-node label"]) {
      const style = await page.evaluate((s) => {
        const cs = getComputedStyle(document.querySelector(s));
        return { display: cs.display, columnGap: cs.columnGap };
      }, selector);
      assert.equal(style.display, "flex", selector);
      assert.equal(style.columnGap, "8px", selector);
    }
    // Fees: 200 bps on 1,000 USDC.
    assert.equal(await page.textContent("#fee-rate-output"), "200 bps · 2%");
    assert.equal(await page.textContent("#fee-net"), "980 USDC");
    assert.equal(await page.textContent("#fee-treasury"), "20 USDC");
    await page.fill("#fee-rate", "1000"); await page.dispatchEvent("#fee-rate", "input");
    assert.equal(await page.textContent("#fee-treasury"), "100 USDC");
    // Fee boundaries: 0 bps and 10,000 bps (100%), matching the guide's un-grouped USDC amounts exactly.
    await page.fill("#fee-rate", "0"); await page.dispatchEvent("#fee-rate", "input");
    assert.equal(await page.textContent("#fee-rate-output"), "0 bps · 0%");
    assert.equal(await page.textContent("#fee-net"), "1000 USDC");
    assert.equal(await page.textContent("#fee-treasury"), "0 USDC");
    await page.fill("#fee-rate", "10000"); await page.dispatchEvent("#fee-rate", "input");
    assert.equal(await page.textContent("#fee-rate-output"), "10,000 bps · 100%");
    assert.equal(await page.textContent("#fee-net"), "0 USDC");
    assert.equal(await page.textContent("#fee-treasury"), "1000 USDC");
    // Payoff calculator defaults: 10 WETH, strike 3000, premium 100, 30 days.
    assert.equal(await page.textContent("#premiumYield"), "3.33%");
    assert.equal(await page.textContent("#premiumApr"), "40.56%");
    assert.equal(await page.textContent("#notional"), "10 WETH");
    assert.equal(await page.textContent("#premTotal"), "1,000 USDC");
    assert.ok((await page.$$("#calcChart polyline")).length >= 2, "chart drawn");
    await page.fill("#dep", "0"); await page.dispatchEvent("#dep", "input");
    assert.equal(await page.textContent("#calcError"), "Enter a deposit greater than zero.");
    // Cash accounting default 3,300 on a 10 WETH call at 3,000.
    assert.equal(await page.textContent("#cash-buyer-value"), "0.9091 WETH");
    assert.equal(await page.textContent("#cash-pool-percent"), "90.91% of collateral");
    // Consent: unticking LP B leaves 60% approving.
    await page.uncheck("#consent-b");
    assert.match(await page.textContent("#consent-status"), /60% of current shares approve · consent incomplete/);
    // Releases: choose B.
    await page.check('input[name="recommended-release"][value="B"]');
    assert.equal(await page.textContent("#release-status"), "Recommended for new creation: Hub B. Existing position stays on Hub A.");
    // Custody: phase select changes the backing label.
    await page.selectOption('[data-lab="custody"] select[name="phase"]', "3");
    assert.equal(await page.textContent('[data-lab="custody"] .custody-backing h4'), "Shareholder pool");
    // Actor routes: LP route lists the deposit call.
    await page.click('[data-lab="actor-routes"] [data-route="1"]');
    assert.match(await page.textContent('[data-lab="actor-routes"] .actor-route'), /Hub\.deposit/);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("every lab fits a 276px-wide map card without horizontal overflow", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/labs.html");
  try {
    await page.evaluate(() => IvyLabs.mountAll(document));
    const overflow = await page.evaluate(() => {
      // A mounted lab lives inside a `.card.lab` (see map.css / map.js's KINDS list)
      // that is always ~276 world px wide, regardless of the browser's own width.
      // Reproduce that boundary here and measure each lab against it.
      return [...document.querySelectorAll("[data-lab]")].map((el) => {
        const card = document.createElement("div");
        card.className = "card lab";
        card.style.width = "276px";
        el.replaceWith(card);
        card.appendChild(el);
        return [el.dataset.lab, card.scrollWidth, card.clientWidth];
      });
    });
    for (const [lab, scrollWidth, clientWidth] of overflow)
      assert.ok(scrollWidth <= clientWidth + 1, `${lab}: scrollWidth ${scrollWidth} > clientWidth ${clientWidth}`);
    assert.equal(overflow.length, 7, "all seven labs were measured");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("the guide's examples respond to input and the payoff chart follows a theme change from the shell", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html");
  try {
    await page.waitForFunction(() => window.IvyShell?.state().guideLoaded);
    const guide = page.frames().find((f) => f.parentFrame());
    await guide.waitForFunction(() => document.querySelector("#rows tr"));
    const set = (selector, value, event = "input") => guide.evaluate(([s, v, e]) => {
      const el = document.querySelector(s);
      if (el.type === "checkbox" || el.type === "radio") el.checked = v; else el.value = v;
      el.dispatchEvent(new Event(e, { bubbles: true }));
    }, [selector, value, event]);
    const text = (selector) => guide.textContent(selector);

    for (const id of ["fee-rate", "cash-kind-demo", "cash-price-demo", "consent-a", "unwind-refund"]) {
      assert.equal(await guide.locator(`#${id}`).isDisabled(), false, `${id} is enabled`);
    }
    await set("#fee-rate", "500");
    assert.equal(await text("#fee-net"), "950 USDC");
    assert.equal(await text("#fee-treasury"), "50 USDC");
    assert.equal(await guide.evaluate(() => document.querySelector("#fee-example-bar > span").style.width), "95%");

    await set("#cash-price-demo", "3300");
    assert.equal(await text("#cash-buyer-value"), "0.9091 WETH");
    await set("#consent-b", false, "change");
    assert.match(await text("#consent-status"), /60% of current shares approve · consent incomplete/);
    await set('input[name="recommended-release"][value="B"]', true, "change");
    assert.match(await text("#release-status"), /Hub B/);

    await set("#kind", "put");
    await set("#dep", "30000");
    assert.equal(await text("#depLabel"), "Deposit (USDC)");
    assert.equal(await text("#notional"), "10 WETH");

    const stroke = () => guide.evaluate(() => document.querySelector("#calcChart polyline:last-of-type").getAttribute("stroke"));
    const before = await stroke();
    const theme = await guide.evaluate(() => document.documentElement.dataset.theme);
    await page.click("#themeToggle");
    await guide.waitForFunction((t) => document.documentElement.dataset.theme !== t, theme);
    assert.notEqual(await stroke(), before, "chart redrawn in the new theme's ink");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
