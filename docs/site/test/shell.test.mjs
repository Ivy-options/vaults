import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage, settle } from "./_browser.mjs";

const waitGuideLoaded = (page) => page.waitForFunction(() => window.IvyShell && IvyShell.state().guideLoaded);

test("switching Map ↔ Guide preserves the map's exact camera and the guide's scroll offset, with no re-fit and no re-mount", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);
    // Fly somewhere other than the fit view, so a stray home()/re-fit would be obvious.
    await page.evaluate(() => IvyMap.flyTo("lps-deposit-collateral", false));
    await settle(page, 200);
    const cameraBefore = await page.evaluate(() => IvyMap._cam());
    const pathBefore = await page.evaluate(() => IvyMap.here().map((n) => n.id));
    assert.notDeepEqual(pathBefore, [], "camera actually moved off the fit view before switching");

    // Map -> Guide: first switch mounts the iframe lazily.
    await page.click("#mode-tab-guide");
    await waitGuideLoaded(page);
    assert.equal(await page.evaluate(() => document.body.dataset.mode), "guide");
    assert.equal(await page.evaluate(() => document.querySelector("#panel-map").dataset.active), "false");
    assert.equal(await page.evaluate(() => document.querySelector("#panel-guide").dataset.active), "true");

    // Scroll the guide, then bounce back to Map and confirm the camera is
    // untouched to the pixel: no flyTo/home ran, because switching modes
    // never calls into IvyMap at all.
    await page.evaluate(() => document.querySelector("#panel-guide iframe").contentWindow.scrollTo(0, 1200));
    await settle(page, 100);
    const scrollBefore = await page.evaluate(() => document.querySelector("#panel-guide iframe").contentWindow.scrollY);
    assert.ok(scrollBefore > 0, "the guide iframe actually scrolled");

    await page.click("#mode-tab-map");
    await settle(page, 200);
    const cameraAfterReturn = await page.evaluate(() => IvyMap._cam());
    const pathAfterReturn = await page.evaluate(() => IvyMap.here().map((n) => n.id));
    assert.deepEqual(cameraAfterReturn, cameraBefore, "camera x/y/scale unchanged by a Guide round-trip");
    assert.deepEqual(pathAfterReturn, pathBefore, "camera path unchanged by a Guide round-trip");

    // Guide -> Map -> Guide: the iframe was never re-created, so its scroll
    // offset survives exactly, not merely approximately.
    await page.click("#mode-tab-guide");
    await settle(page, 200);
    const scrollAfterReturn = await page.evaluate(() => document.querySelector("#panel-guide iframe").contentWindow.scrollY);
    assert.equal(scrollAfterReturn, scrollBefore, "guide scroll offset survives a Map round-trip");

    // Only one iframe ever exists: proof the guide panel was never torn down and rebuilt.
    const guideIframeCount = await page.evaluate(() => document.querySelectorAll("#panel-guide iframe").length);
    assert.equal(guideIframeCount, 1);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("the guide iframe loads lazily, only once Guide is first shown", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#panel-guide iframe").length), 0, "no iframe before the reader ever asks for Guide");
    await page.click("#mode-tab-guide");
    await waitGuideLoaded(page);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#panel-guide iframe").length), 1);
    assert.equal(
      await page.evaluate(() => new URL(document.querySelector("#panel-guide iframe").src).pathname),
      "/index.html",
      "the guide iframe points at the untouched classic guide"
    );
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("?view=guide restores Guide mode on load, and switching modes round-trips the URL without disturbing the map's own #hash handling", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html?view=guide#open");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);
    assert.equal(await page.evaluate(() => IvyShell.state().mode), "guide", "?view=guide restores Guide mode on load");
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-guide").getAttribute("aria-selected")), "true");
    assert.equal(await page.evaluate(() => location.hash), "#open", "the map's own #hash is untouched by the shell");

    await waitGuideLoaded(page);
    await page.click("#mode-tab-map");
    await settle(page, 300);
    assert.equal(await page.evaluate(() => location.search), "", "switching to Map drops ?view from the URL");
    assert.equal(await page.evaluate(() => location.hash), "#open", "the hash survives the mode switch");
    // The map still frames the #open node it loaded with, even though it
    // spent the whole boot hidden behind the guide panel.
    assert.deepEqual(await page.evaluate(() => IvyMap.here().map((n) => n.id)), ["open"]);

    await page.click("#mode-tab-guide");
    await settle(page, 300);
    assert.equal(await page.evaluate(() => location.search), "?view=guide", "switching to Guide sets ?view=guide");
    assert.equal(await page.evaluate(() => location.hash), "#open", "the hash still survives");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("the mode toggle is a keyboard-operable tablist with correct ARIA state and a roving tab stop", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);

    const roles = await page.evaluate(() => ({
      tablist: document.querySelector("#modeToggle").getAttribute("role"),
      tabMapRole: document.querySelector("#mode-tab-map").getAttribute("role"),
      tabGuideRole: document.querySelector("#mode-tab-guide").getAttribute("role"),
      panelMapRole: document.querySelector("#panel-map").getAttribute("role"),
      panelGuideRole: document.querySelector("#panel-guide").getAttribute("role"),
      tabMapControls: document.querySelector("#mode-tab-map").getAttribute("aria-controls"),
      tabGuideControls: document.querySelector("#mode-tab-guide").getAttribute("aria-controls"),
      panelMapLabelledby: document.querySelector("#panel-map").getAttribute("aria-labelledby"),
      panelGuideLabelledby: document.querySelector("#panel-guide").getAttribute("aria-labelledby"),
    }));
    assert.equal(roles.tablist, "tablist");
    assert.equal(roles.tabMapRole, "tab");
    assert.equal(roles.tabGuideRole, "tab");
    assert.equal(roles.panelMapRole, "tabpanel");
    assert.equal(roles.panelGuideRole, "tabpanel");
    assert.equal(roles.tabMapControls, "panel-map");
    assert.equal(roles.tabGuideControls, "panel-guide");
    assert.equal(roles.panelMapLabelledby, "mode-tab-map");
    assert.equal(roles.panelGuideLabelledby, "mode-tab-guide");

    // Initial state: Map selected, only the selected tab in the tab order.
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-map").getAttribute("aria-selected")), "true");
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-guide").getAttribute("aria-selected")), "false");
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-map").tabIndex), 0);
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-guide").tabIndex), -1);

    // Arrow-key operable: focus the active tab, press ArrowRight, land on Guide.
    await page.focus("#mode-tab-map");
    await page.keyboard.press("ArrowRight");
    await settle(page, 200);
    assert.equal(await page.evaluate(() => document.activeElement.id), "mode-tab-guide", "focus follows the arrow key to the newly active tab");
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-guide").getAttribute("aria-selected")), "true");
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-map").getAttribute("aria-selected")), "false");
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-guide").tabIndex), 0);
    assert.equal(await page.evaluate(() => document.querySelector("#mode-tab-map").tabIndex), -1);
    assert.equal(await page.evaluate(() => document.body.dataset.mode), "guide");

    // ArrowLeft moves back.
    await page.keyboard.press("ArrowLeft");
    await settle(page, 200);
    assert.equal(await page.evaluate(() => document.activeElement.id), "mode-tab-map");
    assert.equal(await page.evaluate(() => document.body.dataset.mode), "map");

    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("the inactive panel is inert and the map's toolbar hides while the guide is showing", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);
    await page.click("#mode-tab-guide");
    await waitGuideLoaded(page);
    assert.equal(await page.evaluate(() => document.querySelector("#panel-map").hasAttribute("inert")), true);
    assert.equal(await page.evaluate(() => document.querySelector("#panel-guide").hasAttribute("inert")), false);
    assert.equal(await page.evaluate(() => document.querySelector("#toolbar").hasAttribute("inert")), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#toolbar")).display), "none", "the map's toolbar hides, not just dims, so the guide panel claims the full area under the top bar");
    await page.click("#mode-tab-map");
    await settle(page, 100);
    assert.equal(await page.evaluate(() => document.querySelector("#panel-map").hasAttribute("inert")), false);
    assert.equal(await page.evaluate(() => document.querySelector("#panel-guide").hasAttribute("inert")), true);
    assert.equal(await page.evaluate(() => document.querySelector("#toolbar").hasAttribute("inert")), false);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#toolbar")).display), "flex", "the toolbar returns when Map view is active again");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("prefers-reduced-motion switches views instantly instead of crossfading", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html");
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);
    const durations = await page.evaluate(() => {
      const panel = document.querySelector("#panel-map");
      const thumb = document.querySelector("#modeThumb");
      return {
        panel: getComputedStyle(panel).transitionDuration,
        thumb: getComputedStyle(thumb).transitionDuration,
      };
    });
    // Every listed duration is 0s under reduced motion (the property can list
    // more than one value if more than one property transitions).
    assert.ok(durations.panel.split(",").every((d) => parseFloat(d) === 0), `panel transition not instant: ${durations.panel}`);
    assert.ok(durations.thumb.split(",").every((d) => parseFloat(d) === 0), `thumb transition not instant: ${durations.thumb}`);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("a bare visit remembers the last mode from localStorage, but an explicit ?view always wins over it", async () => {
  const server = await startServer();
  {
    // No ?view at all, and a prior visit left it in Guide: bare visit opens in Guide.
    const { page, errors, close } = await openPage(server.url + "v2/index.html", {
      beforeNavigate: () => localStorage.setItem("ivy-view", "guide"),
    });
    try {
      await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
      await settle(page, 300);
      assert.equal(await page.evaluate(() => IvyShell.state().mode), "guide", "bare visit falls back to the remembered mode");
      assert.equal(await page.evaluate(() => location.search), "", "the remembered mode does not itself force a ?view into the URL");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  }
  {
    // Same remembered "guide", but this load has an explicit ?view=map: the URL wins.
    const { page, errors, close } = await openPage(server.url + "v2/index.html?view=map", {
      beforeNavigate: () => localStorage.setItem("ivy-view", "guide"),
    });
    try {
      await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
      await settle(page, 300);
      assert.equal(await page.evaluate(() => IvyShell.state().mode), "map", "an explicit ?view overrides the remembered mode");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  }
  {
    // Switching modes by hand updates what's remembered for the next bare visit.
    const { page, errors, close } = await openPage(server.url + "v2/index.html");
    try {
      await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
      await settle(page, 300);
      await page.click("#mode-tab-guide");
      await waitGuideLoaded(page);
      assert.equal(await page.evaluate(() => localStorage.getItem("ivy-view")), "guide");
      assert.deepEqual(errors, []);
    } finally {
      await close();
    }
  }
  await server.close();
});

test("while Guide view is active, the map's document-level shortcuts (Escape, +, -, 0) do nothing", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);
    await page.evaluate(() => IvyMap.flyTo("lps-deposit-collateral", false));
    await settle(page, 200);
    const cameraBefore = await page.evaluate(() => IvyMap._cam());
    const pathBefore = await page.evaluate(() => IvyMap.here().map((n) => n.id));

    await page.click("#mode-tab-guide");
    await waitGuideLoaded(page);
    // Focus sits on shell chrome (the tab itself), not inside #map, which is
    // exactly the case a listener scoped only to #map wouldn't catch.
    assert.equal(await page.evaluate(() => document.activeElement.id), "mode-tab-guide");

    for (const key of ["Escape", "+", "-", "0"]) {
      await page.keyboard.press(key);
      await settle(page, 100);
    }
    assert.deepEqual(await page.evaluate(() => IvyMap._cam()), cameraBefore, "camera untouched by shortcuts fired while Guide is active");
    assert.deepEqual(await page.evaluate(() => IvyMap.here().map((n) => n.id)), pathBefore);
    assert.equal(await page.evaluate(() => document.body.dataset.mode), "guide", "still in Guide view");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("the guide iframe's own top bar is hidden once embedded in the shell", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);
    await page.click("#mode-tab-guide");
    await waitGuideLoaded(page);
    const topbar = await page.evaluate(() => {
      const doc = document.querySelector("#panel-guide iframe").contentDocument;
      return {
        display: getComputedStyle(doc.querySelector(".topbar")).display,
        embedded: doc.documentElement.classList.contains("ivy-embedded"),
      };
    });
    assert.equal(topbar.display, "none", "embed.js hides the guide's own .topbar so only the shell's bar shows");
    assert.equal(topbar.embedded, true);
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});

test("theme sync: the shell's theme toggle drives the guide, and the guide's own toggle drives the shell back", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "v2/index.html");
  try {
    await page.waitForFunction(() => window.IvyMap && IvyMap.mounted && window.IvyShell);
    await settle(page, 300);
    await page.click("#mode-tab-guide");
    await waitGuideLoaded(page);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    assert.equal(
      await page.evaluate(() => document.querySelector("#panel-guide iframe").contentDocument.documentElement.getAttribute("data-theme")),
      "dark"
    );

    // Shell -> guide: the shell's own theme button (wired in map.js) flips
    // the shell's document; shell.js relays it into the already-loaded frame.
    await page.click("#themeToggle");
    await settle(page, 200);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
    assert.equal(
      await page.evaluate(() => document.querySelector("#panel-guide iframe").contentDocument.documentElement.getAttribute("data-theme")),
      "light",
      "the guide followed the shell into light mode"
    );

    // Guide -> shell: clicking the guide's own theme button (docs.js, inside
    // the frame) fires a native "storage" event on the parent, with no
    // change needed inside the classic guide.
    await page.evaluate(() => document.querySelector("#panel-guide iframe").contentDocument.getElementById("themeToggle").click());
    await settle(page, 200);
    assert.equal(
      await page.evaluate(() => document.querySelector("#panel-guide iframe").contentDocument.documentElement.getAttribute("data-theme")),
      "dark"
    );
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark", "the shell followed the guide back to dark mode");
    assert.deepEqual(errors, []);
  } finally {
    await close();
    await server.close();
  }
});
