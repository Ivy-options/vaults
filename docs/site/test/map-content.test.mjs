import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

async function withMap(run, suffix = "?view=map") {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html" + suffix);
  try {
    await page.waitForFunction(() => window.IvyMap?.mounted && window.IvyShell);
    await settle(page, 550);
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await close(); await server.close(); }
}

test("canvas links navigate between topics and canonical references preserve the map camera", () => withMap(async (page) => {
  assert.equal(await page.locator("#reading-toggle").count(), 0);
  await page.locator('.card[data-id="open"]').click();
  await settle(page, 400);
  assert.equal(await page.evaluate(() => IvyMap.here()[0]?.id), 'open');
  await page.evaluate(() => IvyMap.flyTo('open-or-schedule', false));
  await page.locator('.card[data-id="open-or-schedule"] a[href="#auction"]').click();
  await settle(page, 400);
  assert.equal(await page.evaluate(() => IvyMap.here()[0]?.id), 'auction');
  await page.evaluate(() => IvyMap.flyTo('set-the-terms', false));
  const camera = await page.evaluate(() => IvyMap._cam());
  const reference = page.locator('.card[data-id="set-the-terms"] a[data-guide]');
  await reference.waitFor({ state: "visible" });
  await reference.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => IvyShell.state().guideLoaded);
  const frame = page.frames().find(f => f.parentFrame());
  assert.ok(frame.url().endsWith('guide.html#terms'), frame.url());
  await frame.goto(new URL('guide.html#overview', frame.url()).href);
  await page.locator('#back-to-map').click();
  await reference.click();
  await frame.waitForURL('**/guide.html#terms');
  assert.ok(await page.locator('#panel-guide.is-loaded').count());
  await page.locator('#back-to-map').click();
  assert.deepEqual(await page.evaluate(() => IvyMap._cam()), camera);
  await page.evaluate(() => IvyMap.flyTo('missing-report', false));
  await page.locator('.card[data-id="missing-report"] a[data-guide]').click();
  await frame.waitForURL('**/guide.html#cash-missing-reports');
}));

test("map search returns the relevant card without repeating ancestor chapters", () => withMap(async page => {
  const hits = await page.evaluate(() => IvyMap.search('Token approvals').map(hit => hit.node.id));
  assert.deepEqual(hits, ['hub-and-vaults']);
}));

test("all explanation cards preserve authored structure and fit mobile at reading zoom", () => withMap(async page => {
  await page.setViewportSize({ width: 320, height: 740 });
  const ids = await page.locator('#document [data-kind="moment"], #document [data-kind="action"]').evaluateAll(cards => cards.map(card => card.id));
  for (const id of ids) {
    await page.evaluate(id => IvyMap.flyTo(id, false), id);
    const card = page.locator(`.card[data-id="${id}"]`);
    const body = card.locator('.moment-body, .action-body');
    assert.ok(await body.isVisible(), id);
    const content = await page.evaluate(id => {
      const source = document.getElementById(id);
      const rendered = document.querySelector(`.card[data-id="${id}"] .moment-body, .card[data-id="${id}"] .action-body`);
      const authored = [...source.children].filter(el => !/^H[1-6]$/.test(el.tagName) && el.tagName !== 'SECTION');
      const tier = rendered.parentElement;
      return {
        expected: authored.map(el => el.outerHTML).join(''),
        actual: rendered.innerHTML,
        overflow: tier.scrollHeight > tier.clientHeight + 1,
      };
    }, id);
    assert.equal(content.actual, content.expected, id);
    assert.equal(content.overflow, false, id);
    const box = await card.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 320, JSON.stringify({ id, box }));
  }
  assert.deepEqual(await page.evaluate(() => IvyMap.search('selects and submits').map(hit => hit.node.id)), ['who-is-around-a-vault']);
}));

test("a retired text-view URL opens the canonical Guide", () => withMap(async page => {
  assert.equal(await page.evaluate(() => IvyShell.state().mode), 'guide');
  assert.equal(await page.locator('body.reading').count(), 0);
}, '?view=text'));

test("readers can start at any topic using keyboard search on mobile", () => withMap(async page => {
  await page.setViewportSize({ width: 320, height: 740 });
  assert.equal(await page.locator('#phase-nav').count(), 0);
  const input = page.locator('#search-input');
  for (const [query, id] of [['Claim the reserved payout', 'claim-payout'], ['Token approvals', 'hub-and-vaults']]) {
    await input.fill(query);
    await input.press('Enter');
    assert.equal(await page.evaluate(() => IvyMap.here().at(-1)?.id), id);
  }
}));

test("the default Guide remains readable and scrollable without JavaScript", async () => {
  const server = await startServer();
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    await page.goto(server.url + 'index.html');
    const frame = page.frameLocator('.shell-noscript iframe');
    assert.ok(await frame.locator('#overview').isVisible());
    await frame.locator('#early-exit').scrollIntoViewIfNeeded();
    assert.ok(await frame.locator('body').evaluate(() => scrollY > 500));
    assert.equal(await frame.locator('#modeToggle').count(), 0);
  } finally { await browser.close(); await server.close(); }
});

// A focused card must fit horizontally and retain its own breadcrumb/hash.
test("a selected action fits a narrow viewport and remains the navigation target", () => withMap(async page => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => IvyMap.flyTo('claim-premium', false));
  const card = page.locator('.card[data-id="claim-premium"]');
  const box = await card.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box));
  await card.locator('.action-body').waitFor({ state: 'visible' });
  assert.ok(await card.locator('.action-body').isVisible(), 'selected text is revealed even below the usual zoom threshold');
  assert.equal(await page.evaluate(() => location.hash), '#claim-premium');
  assert.equal(await page.evaluate(() => IvyMap.here().at(-1).id), 'claim-premium');
  await card.focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => IvyMap.here().at(-1).id), 'buyer-has-paid-the-premium');
}));

test("keyboard branch links descend without native canvas scrolling", () => withMap(async page => {
  await page.evaluate(() => IvyMap.flyTo('cancel-any-time', false));
  const branch = page.locator('.card[data-id="cancel-any-time"] a[href="#auction-cancellation-clock"]');
  await branch.focus();
  await page.keyboard.press('Enter');
  await settle(page, 400);
  assert.equal(await page.evaluate(() => IvyMap.here().at(-1)?.id), 'auction-cancellation-clock');
  const detail = page.locator('.card[data-id="auction-cancellation-clock"] a[href="#auction-timeout-setting"]');
  await detail.focus();
  await page.keyboard.press('Enter');
  await settle(page, 400);
  assert.deepEqual(await page.evaluate(() => ({target:IvyMap.here().at(-1)?.id,top:document.querySelector('#map').scrollTop,left:document.querySelector('#map').scrollLeft})), {target:'auction-timeout-setting',top:0,left:0});
  await page.locator('.card[data-id="auction-timeout-setting"]').focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => IvyMap.here().at(-1)?.id), 'auction-cancellation-clock');
}));

test("the role widget accepts Enter and fits when focused on mobile", () => withMap(async page => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => IvyMap.flyTo('actor-routes-lab', false));
  const choice = page.locator('.card[data-id="actor-routes-lab"] [data-route="1"]');
  await choice.waitFor({ state: "visible" });
  assert.ok(await choice.isVisible());
  await choice.focus();
  await page.keyboard.press('Enter');
  assert.equal(await choice.getAttribute('aria-pressed'), 'true');
}));

test("Back to map preserves a panned and zoomed camera after reading a reference", () => withMap(async page => {
  await page.evaluate(() => IvyMap.flyTo('set-the-terms', false));
  await page.waitForTimeout(250);
  await page.keyboard.press('Meta+=');
  const r = await page.locator('#map').boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.wheel(25, 35);
  await page.waitForTimeout(80);
  const before = await page.evaluate(() => IvyMap._cam());
  await page.locator('.card[data-id="set-the-terms"] a[data-guide]').click();
  await page.waitForFunction(() => IvyShell.state().guideLoaded);
  const back = page.locator('#back-to-map');
  assert.ok(await back.isVisible());
  await back.click();
  assert.deepEqual(await page.evaluate(() => IvyMap._cam()), before);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'map');
}));

test("panning a readable mobile card does not hide its explanation", () => withMap(async page => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.evaluate(() => IvyMap.flyTo('claim-premium', false));
  const text = page.locator('.card[data-id="claim-premium"] .action-body');
  await text.waitFor({ state: 'visible' });
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const scale = await page.evaluate(() => IvyMap._cam().s);
  await page.mouse.wheel(0, 8);
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => IvyMap._cam().s), scale);
  assert.ok(await text.isVisible(), 'panning retains revealed text');
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 2 + 12);
  await page.mouse.up();
  assert.ok(await text.isVisible(), 'dragging retains revealed text');
}));

// Overview and action prose share the same reading scale, including long cards.
test("overview cards fit mobile and their measured text stays inside the card", () => withMap(async page => {
  await page.setViewportSize({width: 320, height: 740});
  await page.evaluate(() => IvyMap.flyTo('how-custody-works', false));
  const card = page.locator('.card[data-id="how-custody-works"]');
  const box = await card.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 320, JSON.stringify(box));
  for (const paragraph of await card.locator('[data-tier="2"] p').all()) {
    assert.ok(await paragraph.isVisible());
  }
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('.card.moment')].filter(card => {
    const text = card.querySelector('[data-tier="2"]');
    return text.scrollHeight > text.clientHeight + 1;
  }).map(card => card.dataset.id));
  assert.deepEqual(overflowing, []);
}));

test('map references land on their exact headings after zoom and repeated visits', () => withMap(async page => {
  for (const [card, hash, scale] of [
    ['set-the-terms', 'terms', 1.7],
    ['sign-a-bid', 'makers', 2],
    ['missing-report', 'cash-missing-reports', 2.5],
    ['agreed-unwind', 'early-exit', 1.8],
    ['set-the-terms', 'terms', 2],
    ['set-the-terms', 'terms', 2],
  ]) {
    await page.evaluate(({card,scale}) => { IvyMap.flyTo(card, false); IvyMap.zoomTo(scale); }, {card,scale});
    await page.locator(`.card[data-id="${card}"] a[data-guide]`).evaluate(link => link.click());
    const frame = page.frames().find(f => f.parentFrame());
    await frame.waitForURL(url => url.hash === '#' + hash);
    await frame.waitForFunction(() => document.readyState === 'complete');
    await frame.evaluate(() => document.fonts.ready);
    await settle(page, 250);
    const top = await frame.evaluate(hash => {
      const target = document.getElementById(hash);
      const heading = target.matches('h1,h2,h3,h4,h5,h6') ? target : target.querySelector('h1,h2,h3,h4,h5,h6');
      return heading.getBoundingClientRect().top;
    }, hash);
    assert.ok(top >= 0 && top <= 30, `${hash} heading starts at ${top}px instead of the top of the Guide`);
    await frame.evaluate(() => scrollBy(0, 300));
    await page.click('#back-to-map');
  }
}));

test('every Map explanation opens a section of the main Guide', () => withMap(async page => {
  const links = await page.locator('#document a[data-guide]').evaluateAll(links => links.map(link => ({path: new URL(link.href).pathname, hash: new URL(link.href).hash})));
  assert.equal(links.length, 4);
  for (const link of links) {
    assert.equal(link.path, '/index.html');
    assert.ok(link.hash, 'each reference identifies a Guide section');
  }
  await page.click('#mode-tab-guide');
  await page.waitForFunction(() => IvyShell.state().guideLoaded);
  const frame = page.frames().find(f => f.parentFrame());
  const detours = await frame.locator('main a[href]').evaluateAll(links => links.filter(link => new URL(link.href).pathname !== location.pathname).map(link => link.href));
  assert.deepEqual(detours, [], 'Guide explanations stay in the Guide');
}));


test("every leaf fits at mobile reading zoom and nested explanations remain searchable", () => withMap(async page => {
  await page.setViewportSize({width:320,height:740});
  const leaves = await page.locator('#document [data-kind="tile"]').evaluateAll(nodes => nodes.map(n => n.id));
  assert.ok(leaves.length > 40);
  for (const id of leaves) {
    await page.evaluate(id => IvyMap.flyTo(id,false), id);
    const card = page.locator(`.card[data-id="${id}"]`);
    const box = await card.boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= 321, `${id} exceeds mobile width`);
    assert.equal(await card.evaluate(c => {const t=c.querySelector('[data-tier="2"]');return t.scrollHeight > t.clientHeight+1 || t.scrollWidth > t.clientWidth+1;}), false, id);
  }
  assert.ok((await page.evaluate(() => IvyMap.search('auctionTimeout').map(h => h.node.id))).includes('auction-timeout-setting'));
  assert.ok((await page.evaluate(() => IvyMap.search('maxSettlementPriceAge').map(h => h.node.id))).includes('cash-live-observation'));
}));

test("mobile breadcrumbs reveal the current leaf and allow scrolling to ancestors", () => withMap(async page => {
  await page.setViewportSize({width:320,height:740});
  await page.evaluate(() => IvyMap.flyTo('auction-timeout-setting',false));
  const result = await page.locator('#crumbs').evaluate(crumbs => {
    const current = crumbs.querySelector('[aria-current]');
    const a = crumbs.getBoundingClientRect(), b = current.getBoundingClientRect();
    return {scroll:crumbs.scrollLeft,visible:b.left >= a.left-1 && b.right <= a.right+1,overflow:getComputedStyle(crumbs).overflowX};
  });
  assert.equal(result.visible,true);
  assert.ok(result.scroll > 0);
  assert.equal(result.overflow,'auto');
}));
