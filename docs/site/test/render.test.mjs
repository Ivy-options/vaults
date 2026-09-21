import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

test("cards render one layer per tier, no repeated tiers, and none overflows its tile", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#world .card").length > 0);
    const counts = await page.evaluate(() => ({
      cards: document.querySelectorAll("#world .card").length,
      lines: document.querySelectorAll("#world .line, #world .pin").length,
      actionTiers: [...document.querySelector('.card[data-id="add-funds"]').querySelectorAll(":scope > [data-tier]")].map((l) => l.dataset.tier),
      tileTiers: [...document.querySelector('.card[data-id="who-may-deposit"]').querySelectorAll(":scope > [data-tier]")].map((l) => l.dataset.tier),
      badge: document.querySelector('.card[data-id="add-funds"] .badge').textContent,
      watermark: !!document.querySelector('.card[data-id="add-funds"] > .watermark .portrait'),
      foregroundPortraits: document.querySelectorAll('.card[data-id="add-funds"] [data-tier] .portrait').length,
      waitsTiers: [...document.querySelector('.card[data-id="waits"]').querySelectorAll(":scope > [data-tier]")].map((l) => l.dataset.tier),
      headerVar: document.querySelector('.card[data-id="add-funds"]').style.getPropertyValue("--header"),
      dim: document.querySelector('.card[data-id="waits"]').classList.contains("dim"),
      lab: !!document.querySelector('.card[data-id="fee-lab"] #fee-rate'),
    }));
    assert.equal(counts.cards, 13);
    assert.ok(counts.lines > 5);
    assert.deepEqual(counts.actionTiers, ["0", "1", "2"]);
    assert.deepEqual(counts.tileTiers, ["0", "2", "3"]);
    assert.equal(counts.badge, "LP");
    assert.ok(counts.watermark, "portrait is a watermark");
    assert.equal(counts.foregroundPortraits, 0);
    assert.deepEqual(counts.waitsTiers, ["0", "1", "2"], "an action without tiles has no compact tier");
    assert.match(counts.headerVar, /^\d+px$/);
    assert.ok(counts.dim);
    assert.ok(counts.lab, "lab content moved into the card");
    // Layers reveal new information; zooming closer keeps an explanation readable.
    const tierPairs = await page.evaluate(() =>
      [...document.querySelectorAll("#world .card")].map((card) => {
        const t2 = card.querySelector(':scope > [data-tier="2"]');
        const t3 = card.querySelector(':scope > [data-tier="3"]');
        return { id: card.dataset.id, t2: t2 ? t2.textContent.trim() : null, t3: t3 ? t3.textContent.trim() : null };
      })
    );
    for (const { id, t2, t3 } of tierPairs) {
      if (t2 != null && t3 != null) assert.notEqual(t3, t2, `tier 3 repeats tier 2 text verbatim for ${id}`);
    }
    // Every tier: the shown layer must fit inside its card. Far-range tiers (station 0/1,
    // moment 0) must read centred, like a poster; reading tiers stay left-aligned.
    const textAligns = {};
    for (const lod of [0, 1, 2, 3]) {
      const { overflow, align } = await page.evaluate((lod) => {
        IvyMap.setLod(lod);
        const overflow = [...document.querySelectorAll("#world .card")].flatMap((card) => {
          const layer = card.querySelector(`:scope > [data-tier="${card.dataset.show}"]`);
          if (!layer) return [];
          return layer.scrollHeight > layer.clientHeight + 1 || layer.scrollWidth > layer.clientWidth + 1 ? [`${card.dataset.id}@${lod}`] : [];
        });
        const alignOf = (id) => {
          const card = document.querySelector(`.card[data-id="${id}"]`);
          const layer = card?.querySelector(`:scope > [data-tier="${card.dataset.show}"]`);
          return layer ? getComputedStyle(layer).textAlign : null;
        };
        return { overflow, align: { open: alignOf("open"), moment: alignOf("lps-deposit-collateral") } };
      }, lod);
      assert.deepEqual(overflow, [], `overflowing layers at lod ${lod}`);
      textAligns[lod] = align;
    }
    assert.equal(textAligns[0].open, "center", "station reads centred at lod 0");
    assert.equal(textAligns[0].moment, "center", "moment reads centred at lod 0");
    assert.equal(textAligns[1].open, "center", "station stays centred at lod 1");
    assert.ok(["start", "left"].includes(textAligns[2].moment), "moment reading tier is left-aligned at lod 2");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("a lab card is sized to its mounted widget and fits every actor route", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html?view=map");
  try {
    await page.waitForFunction(() => IvyMap.mounted);
    for (const lod of [2, 3]) {
      const size = await page.evaluate((lod) => {
        IvyMap.setLod(lod);
        const card = document.querySelector('#world .card[data-id="actor-routes-lab"]');
        const layer = card.querySelector(`:scope > [data-tier="${card.dataset.show}"]`);
        return { sh: layer.scrollHeight, ch: layer.clientHeight, sw: layer.scrollWidth, cw: layer.clientWidth };
      }, lod);
      assert.ok(size.sh <= size.ch + 1, `vertical overflow at lod ${lod}: ${JSON.stringify(size)}`);
      assert.ok(size.sw <= size.cw + 1, `horizontal overflow at lod ${lod}: ${JSON.stringify(size)}`);
    }
    await page.evaluate(() => IvyMap.flyTo("actor-routes-lab", false));
    const card = page.locator('#world .card[data-id="actor-routes-lab"]');
    for (const route of [0, 1, 2, 3]) {
      await card.locator(`[data-route="${route}"]`).click();
      const size = await card.evaluate((c) => {
        const layer = c.querySelector(`:scope > [data-tier="${c.dataset.show}"]`);
        return { pressed: c.querySelector("[aria-pressed=true]").dataset.route, sh: layer.scrollHeight, ch: layer.clientHeight };
      });
      assert.equal(size.pressed, String(route));
      assert.ok(size.sh <= size.ch + 1, `vertical overflow after picking route ${route}: ${JSON.stringify(size)}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
