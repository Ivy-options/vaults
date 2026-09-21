import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

async function withMap(run) {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "index.html?view=map");
  try {
    await page.waitForFunction(() => window.IvyMap?.mounted && window.IvyShell);
    await settle(page, 550);
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await close(); await server.close(); }
}

test("Cmd/Ctrl zoom matches the buttons and suppresses a second browser zoom", () => withMap(async (page) => {
  for (const modifier of ["Meta", "Control"]) {
    await page.evaluate(() => IvyMap.flyTo("open", false));
    const before = await page.evaluate(() => IvyMap._cam());
    await page.keyboard.press(`${modifier}+=`);
    const keyboard = await page.evaluate(() => IvyMap._cam());
    assert.equal(keyboard.s, before.s * 1.2);
    await page.evaluate(() => IvyMap.flyTo("open", false));
    await page.locator('[data-zoom="+"]').click();
    assert.deepEqual(await page.evaluate(() => IvyMap._cam()), keyboard, "buttons and shortcuts share the same camera behavior");
    await page.keyboard.press(`${modifier}+0`);
    assert.equal(await page.evaluate(() => IvyMap.state().scale), 1);
  }
  assert.equal(await page.evaluate(() => {
    const e = new KeyboardEvent("keydown", { key: "-", metaKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e);
    return e.defaultPrevented;
  }), true, "the browser must not apply another zoom on top");
}));

test("wheel input interrupts a camera flight at its visible position", () => withMap(async (page) => {
  // Sample and interrupt in one frame so timing cannot turn this into a
  // comparison between two different points of the running animation.
  await page.evaluate(() => IvyMap.flyTo("open"));
  await settle(page, 80);
  const result = await page.evaluate(() => {
    const world = document.querySelector("#world"), map = document.querySelector("#map");
    const before = new DOMMatrix(getComputedStyle(world).transform);
    const r = map.getBoundingClientRect(), x = r.width / 2, y = r.height / 2;
    map.dispatchEvent(new WheelEvent("wheel", { ctrlKey: true, deltaY: -1, clientX: x + r.left, clientY: y + r.top, bubbles: true, cancelable: true }));
    const after = new DOMMatrix(getComputedStyle(world).transform);
    return { ratio: after.a / before.a, driftX: (x - before.e) / before.a - (x - after.e) / after.a, driftY: (y - before.f) / before.a - (y - after.f) / after.a };
  });
  assert.ok(result.ratio > 1 && result.ratio < 1.02, JSON.stringify(result));
  assert.ok(Math.abs(result.driftX) < 0.1 && Math.abs(result.driftY) < 0.1, JSON.stringify(result));
}));

test("map accepts an exact zoom above the old ceiling and resets explicitly", () => withMap(async (page) => {
  await page.locator("#zoom-level").fill("475%");
  await page.locator("#zoom-level").press("Enter");
  assert.equal(await page.evaluate(() => IvyMap.state().scale), 4.75);
  await page.locator("[data-reset-zoom]").click();
  assert.equal(await page.evaluate(() => IvyMap.state().scale), 1);
  await page.locator("#zoom-level").fill("invalid");
  await page.locator("#zoom-level").press("Enter");
  assert.equal(await page.evaluate(() => IvyMap.state().scale), 1);
  assert.equal(await page.locator("#zoom-level").inputValue(), "100%");
}));

test("Guide supports exact zoom and pinch without changing Map zoom", () => withMap(async (page) => {
  await page.evaluate(() => IvyMap.flyTo("open", false));
  const mapCamera = await page.evaluate(() => IvyMap._cam());
  await page.locator("#mode-tab-guide").click();
  await page.waitForFunction(() => IvyShell.state().guideLoaded);
  assert.ok(await page.locator('[data-zoom="+"]').isVisible(), "Guide keeps usable zoom controls");
  const frame = page.frames().find((f) => f.parentFrame());
  await page.locator("[data-reset-zoom]").click();
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1);
  await page.keyboard.press("Meta+=");
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1.2);
  await frame.locator("body").click({ position: { x: 10, y: 10 } });
  await page.keyboard.press("Control+=");
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1.44);
  await page.keyboard.press("Meta+-");
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1.2);
  await page.keyboard.press("Meta+0");
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1);
  await page.locator("#zoom-level").fill("137%");
  await frame.locator("body").dispatchEvent("wheel", { ctrlKey: true, deltaY: -1, clientX: 400, clientY: 250 });
  await settle(page, 50);
  assert.equal(await page.locator("#zoom-level").inputValue(), "137%", "a Guide update cannot overwrite the percentage being typed");
  await page.locator("#zoom-level").press("Enter");
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1.37);
  await frame.locator("body").dispatchEvent("wheel", { ctrlKey: true, deltaY: -20, clientX: 400, clientY: 250 });
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) > 1.37);
  await page.waitForFunction(() => parseFloat(document.querySelector("#zoom-level").value) > 137);
  const scale = await frame.evaluate(() => document.documentElement.style.zoom);
  await frame.locator("body").dispatchEvent("wheel", { deltaY: 200 });
  assert.equal(await frame.evaluate(() => document.documentElement.style.zoom), scale, "ordinary scrolling does not zoom the Guide");
  await page.locator("#mode-tab-map").click();
  assert.deepEqual(await page.evaluate(() => IvyMap._cam()), mapCamera);
  await page.locator("#mode-tab-guide").click();
  assert.equal(await frame.evaluate(() => document.documentElement.style.zoom), scale);
  await page.locator("[data-reset-zoom]").click();
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1);
  await page.locator("#zoom-level").fill("250%");
  await page.locator("#zoom-level").press("Escape");
  assert.equal(await page.locator("#zoom-level").inputValue(), "100%", "Escape cancels an uncommitted zoom value");
}));


test("zoom controls remain reachable at 320px", () => withMap(async (page) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const mode of ["map", "guide"]) {
    await page.locator(`#mode-tab-${mode}`).click();
    for (const selector of ['[data-zoom="-"]', "#zoom-level", '[data-zoom="+"]', "[data-reset-zoom]"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 320, `${mode}: ${selector} is on screen`);
    }
  }
}));

test("a drag begins on a card without a focus-triggered camera jump", () => withMap(async page => {
  await page.evaluate(() => IvyMap.flyTo('open', false));
  await settle(page, 350);
  const box = await page.locator('.card[data-id="add-funds"]').boundingBox();
  const x = box.x + box.width / 2, y = box.y + 20;
  const before = await page.evaluate(() => IvyMap._cam());
  await page.mouse.move(x, y);
  await page.mouse.down();
  assert.deepEqual(await page.evaluate(() => IvyMap._cam()), before, 'pressing a card does not navigate before a drag');
  await page.mouse.move(x + 50, y + 20, { steps: 5 });
  await page.mouse.up();
  const after = await page.evaluate(() => IvyMap._cam());
  assert.equal(after.s, before.s);
  assert.ok(Math.abs(after.x - before.x - 50) < 1e-9);
  assert.ok(Math.abs(after.y - before.y - 20) < 1e-9);
  assert.equal(await page.locator('#map').evaluate(el => el.scrollTop), 0);
}));

test("ordinary wheel movement pans; pinch zooms at the pointer", () => withMap(async page => {
  await page.evaluate(() => IvyMap.flyTo('open', false));
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await page.evaluate(() => IvyMap._cam());
  await page.mouse.wheel(70, 90);
  await page.waitForFunction(({x,y}) => IvyMap._cam().x !== x || IvyMap._cam().y !== y, before);
  const after = await page.evaluate(() => IvyMap._cam());
  assert.equal(after.s, before.s, 'two-finger scrolling must not change zoom');
  assert.ok(Math.abs(after.x - before.x + 70) < 1e-9);
  assert.ok(Math.abs(after.y - before.y + 90) < 1e-9);
  await page.locator('#map').dispatchEvent('wheel', { ctrlKey: true, deltaY: -10, clientX: 600, clientY: 400 });
  assert.ok((await page.evaluate(() => IvyMap._cam().s)) > after.s);
}));

for (const mode of ['map', 'guide']) {
  test(`${mode} wheel zoom uses small steps even for coarse mouse-wheel events`, () => withMap(async page => {
    let frame;
    if (mode === 'guide') {
      await page.click('#mode-tab-guide');
      await page.waitForFunction(() => IvyShell.state().guideLoaded);
      frame = page.frames().find(f => f.parentFrame());
    } else await page.evaluate(() => IvyMap.flyTo('open', false));
    const readScale = () => mode === 'map'
      ? page.evaluate(() => IvyMap._cam().s)
      : frame.evaluate(() => Number(document.documentElement.style.zoom));
    const wheel = async (deltaY, deltaMode) => {
      const target = mode === 'map' ? page.locator('#map') : frame.locator('body');
      await target.dispatchEvent('wheel', { ctrlKey: true, deltaY, deltaMode, clientX: 600, clientY: 400 });
    };
    for (const [delta, units] of [[100, 0], [3, 1], [1, 2], [1, 0]]) {
      if (frame) {
        await page.locator('#zoom-level').fill('150%');
        await page.locator('#zoom-level').press('Enter');
        await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1.5);
      }
      await page.click('[data-reset-zoom]');
      if (frame) await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1);
      await wheel(-delta, units);
      const scale = await readScale();
      const limit = delta === 1 && units === 0 ? 1.005 : 1.11;
      assert.ok(scale > 1 && scale <= limit, `${mode}: delta ${delta}, units ${units} jumped from 100% to ${scale * 100}%`);
      await wheel(delta, units);
      assert.ok(Math.abs(await readScale() - 1) < 1e-9, 'reversing the same wheel step returns to the starting zoom');
    }
  }));
}

test('Map navigation zoom never changes the Guide reading size', () => withMap(async page => {
  await page.click('#mode-tab-guide');
  await page.waitForFunction(() => IvyShell.state().guideLoaded);
  const frame = page.frames().find(f => f.parentFrame());
  await page.locator('#zoom-level').fill('175%');
  await page.locator('#zoom-level').press('Enter');
  await frame.waitForFunction(() => Number(document.documentElement.style.zoom) === 1.75);
  for (const scale of [0.75, 0.3, 6.5]) {
    await page.click('#mode-tab-map');
    await page.evaluate(scale => { IvyMap.flyTo('set-the-terms', false); IvyMap.zoomTo(scale); }, scale);
    const camera = await page.evaluate(() => IvyMap._cam());
    await page.click('#mode-tab-guide');
    assert.equal(await page.locator('#zoom-level').inputValue(), '175%');
    assert.equal(await frame.evaluate(() => Number(document.documentElement.style.zoom)), 1.75);
    await page.click('#back-to-map');
    assert.deepEqual(await page.evaluate(() => IvyMap._cam()), camera);
  }
}));

for (const input of ['buttons', 'keyboard', 'wheel']) {
  test(`Guide-first reading zoom survives repeated Map zoom-out using ${input}`, async () => {
    const server = await startServer();
    const { page, errors, close } = await openPage(server.url + 'index.html');
    try {
      await page.waitForFunction(() => window.IvyShell?.state().guideLoaded && window.IvyMap?.mounted);
      const frame = page.frames().find(f => f.parentFrame());
      const zoom = async (direction, count) => {
        for (let i = 0; i < count; i++) {
          if (input === 'buttons') await page.locator(`[data-zoom="${direction}"]`).click();
          else if (input === 'keyboard') await page.keyboard.press(`Meta+${direction === '+' ? '=' : '-'}`);
          else {
            const target = await page.locator('body').getAttribute('data-mode') === 'guide' ? frame.locator('body') : page.locator('#map');
            await target.dispatchEvent('wheel', { ctrlKey: true, deltaY: direction === '+' ? -100 : 100, clientX: 600, clientY: 400 });
          }
        }
      };
      await zoom('+', 6);
      await settle(page, 100);
      const readingZoom = await frame.evaluate(() => Number(document.documentElement.style.zoom));
      assert.ok(readingZoom > 1.5);
      for (let trip = 0; trip < 2; trip++) {
        await page.click('#mode-tab-map');
        await zoom('-', 15);
        const camera = await page.evaluate(() => IvyMap._cam());
        await page.click('#mode-tab-guide');
        await settle(page, 100);
        assert.equal(await frame.evaluate(() => Number(document.documentElement.style.zoom)), readingZoom);
        assert.equal(await page.locator('#zoom-level').inputValue(), `${Math.round(readingZoom * 100)}%`);
        await page.click('#mode-tab-map');
        assert.deepEqual(await page.evaluate(() => IvyMap._cam()), camera);
        await page.click('#mode-tab-guide');
      }
      assert.deepEqual(errors, []);
    } finally { await close(); await server.close(); }
  });
}
