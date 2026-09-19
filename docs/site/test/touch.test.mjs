import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

// Reproduces the regression: a one-finger drag was already live when the second
// finger touched down, so wireInput's pointerdown/pointermove (no pointerId
// filtering) kept steering the camera from the "wrong" pointer while wireTouch's
// pinch handler wrote to the same camera in the same event — pan and pinch
// fought each other and the pinch anchor jumped. The fix: a drag only follows
// the pointer that started it, and a second touch pointer ends the drag outright.
test("two-finger pinch zooms about its midpoint even when a one-finger drag was already in progress", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    await page.waitForFunction(() => IvyMap.mounted);
    await settle(page, 300);

    const result = await page.evaluate(() => {
      const mapEl = document.querySelector("#map");
      const r = mapEl.getBoundingClientRect();
      const midX = r.left + r.width / 2, midY = r.top + r.height / 2;
      const midRelX = midX - r.left, midRelY = midY - r.top;
      const worldOfMid = () => {
        const cam = IvyMap._cam();
        return { x: (midRelX - cam.x) / cam.s, y: (midRelY - cam.y) / cam.s };
      };
      const fire = (type, id, x, y) => mapEl.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0,
        bubbles: true, cancelable: true, isPrimary: id === 1,
      }));

      const initialScale = IvyMap._cam().s;

      // Finger 1 touches down and starts a one-finger drag (moves past the
      // 5px threshold), exactly as if the reader began panning with one finger.
      let half = 40;
      fire("pointerdown", 1, midX - half, midY);
      fire("pointermove", 1, midX - half - 12, midY - 6);
      const draggingAfterOneFinger = mapEl.classList.contains("dragging");

      // Finger 2 joins for a pinch. The drag must end right here: no more
      // camera writes from the (now stale) one-finger drag, and no swallowed click.
      fire("pointerdown", 2, midX + half, midY);
      const draggingAfterSecondFinger = mapEl.classList.contains("dragging");
      const pinchStartWorld = worldOfMid();

      // Move both fingers apart symmetrically about the midpoint, in many
      // small steps (each step moves both fingers, so the midpoint itself
      // never moves — real touch hardware reports similarly fine-grained,
      // near-simultaneous moves per finger rather than large jumps),
      // sampling the camera after every step.
      const drifts = [];
      for (let i = 0; i < 40; i++) {
        half += 2;
        fire("pointermove", 1, midX - half, midY);
        fire("pointermove", 2, midX + half, midY);
        drifts.push(Math.hypot(worldOfMid().x - pinchStartWorld.x, worldOfMid().y - pinchStartWorld.y));
      }

      fire("pointerup", 1, midX - half, midY);
      fire("pointerup", 2, midX + half, midY);
      const finalScale = IvyMap._cam().s;
      const finalWorld = worldOfMid();

      return {
        initialScale, finalScale,
        draggingAfterOneFinger, draggingAfterSecondFinger,
        maxDrift: Math.max(...drifts),
        finalDrift: Math.hypot(finalWorld.x - pinchStartWorld.x, finalWorld.y - pinchStartWorld.y),
      };
    });

    assert.equal(result.draggingAfterOneFinger, true, "one-finger movement starts a drag");
    assert.equal(result.draggingAfterSecondFinger, false, "a second touch pointer ends the drag immediately");
    assert.ok(result.finalScale > result.initialScale, `pinching out should increase scale (was ${result.initialScale}, now ${result.finalScale})`);
    assert.ok(result.maxDrift <= 2, `pinch midpoint's world point drifted ${result.maxDrift}px mid-gesture, more than 2px`);
    assert.ok(result.finalDrift <= 2, `pinch midpoint's world point drifted ${result.finalDrift}px by the end, more than 2px`);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

// Reproduces the regression: the wheel and zoomBy paths were moved from
// homeScale() * 0.8 to homeScale() (a reader should never be able to zoom out
// past "the whole map fits"), but the two-finger pinch path still had the old
// floor, so a pinch-in gesture could zoom 20% past the fit scale.
test("two-finger pinch cannot zoom out past the fit scale", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    await page.waitForFunction(() => IvyMap.mounted);
    await settle(page, 300);

    const result = await page.evaluate(() => {
      const mapEl = document.querySelector("#map");
      const r = mapEl.getBoundingClientRect();
      const midX = r.left + r.width / 2, midY = r.top + r.height / 2;
      const fire = (type, id, x, y) => mapEl.dispatchEvent(new PointerEvent(type, {
        pointerId: id, pointerType: "touch", clientX: x, clientY: y, button: 0,
        bubbles: true, cancelable: true, isPrimary: id === 1,
      }));
      // Start zoomed in well past the fit scale, then pinch fingers together
      // hard enough that, at the old homeScale() * 0.8 floor, the camera
      // would land visibly below homeScale().
      IvyMap.zoomBy(3);
      let half = 300;
      fire("pointerdown", 1, midX - half, midY);
      fire("pointerdown", 2, midX + half, midY);
      for (let i = 0; i < 60; i++) {
        half -= 4;
        fire("pointermove", 1, midX - half, midY);
        fire("pointermove", 2, midX + half, midY);
      }
      fire("pointerup", 1, midX - half, midY);
      fire("pointerup", 2, midX + half, midY);
      return { finalScale: IvyMap._cam().s };
    });
    // Read the true homeScale() the same way camera.test.mjs's "cannot zoom
    // out past the home/fit scale" assertion does: fly home and read the
    // resulting scale, independently of the pinch gesture above.
    await page.evaluate(() => IvyMap.home(false));
    const homeScale = await page.evaluate(() => IvyMap._cam().s);
    assert.ok(result.finalScale >= homeScale - 1e-6, `pinch zoomed out to ${result.finalScale}, below the fit scale ${homeScale}`);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
