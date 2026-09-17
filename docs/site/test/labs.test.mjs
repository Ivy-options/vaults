import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

test("every lab computes the documented worked examples inside its own scope", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/labs.html");
  try {
    await page.evaluate(() => IvyLabs.mountAll(document));
    // Fees: 200 bps on 1,000 USDC.
    assert.equal(await page.textContent("#fee-rate-output"), "200 bps · 2%");
    assert.equal(await page.textContent("#fee-net"), "980 USDC");
    assert.equal(await page.textContent("#fee-treasury"), "20 USDC");
    await page.fill("#fee-rate", "1000"); await page.dispatchEvent("#fee-rate", "input");
    assert.equal(await page.textContent("#fee-treasury"), "100 USDC");
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
