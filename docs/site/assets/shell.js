/* App shell: the Map/Guide mode toggle in the top bar, and the lazy iframe
   that holds the guide. Both views stay mounted for the whole
   session — switching only changes which panel is visible — so the map's
   camera and the guide's scroll position are never disturbed by a switch.
   The shared zoom controls address the visible view. Guide zoom and theme
   cross the iframe boundary by message, including on file:// pages. */
(() => {
  const $ = (s) => document.querySelector(s);
  const body = document.body;
  const tablist = $("#modeToggle"), thumb = $("#modeThumb");
  const tabMap = $("#mode-tab-map"), tabGuide = $("#mode-tab-guide");
  const panelMap = $("#panel-map"), panelGuide = $("#panel-guide");
  const toolbar = $("#toolbar"), mapEl = $("#map");
  // Fixtures and other pages that don't carry the shell markup (e.g.
  // test/fixtures/tree.html) simply don't run this module.
  if (!tablist || !thumb || !tabMap || !tabGuide || !panelMap || !panelGuide) return;

  const currentTheme = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

  /* ---------- Guide iframe: created once, on first switch to Guide ----------
     Theme reaches the frame only by postMessage, never by touching its
     document directly: on file:// each frame is its own opaque origin, so
     contentDocument access across frames throws, while postMessage still
     works. The guide's own embed.js (docs/site/assets/embed.js) is the
     other half of this handshake. */
  const params = new URLSearchParams(location.search);
  const initialMode = params.get("view") === "map" ? "map" : "guide";
  let mapHash = initialMode === "map" ? location.hash : "";
  let guideLocation = new URL("guide.html", location.href);
  // Any sibling page syncUrl can write: a bare file name, never a path, another origin or the shell itself.
  const isReferencePage = (doc) => /^[a-z0-9-]+\.html$/.test(doc ?? "") && doc !== "index.html";
  if (initialMode === "guide") {
    if (isReferencePage(params.get("doc"))) guideLocation = new URL(params.get("doc"), location.href);
    guideLocation.hash = location.hash;
  }
  const guideUrl = (href) => {
    const url = new URL(href, location.href);
    if (url.pathname.endsWith("/index.html") || url.pathname.endsWith("/")) url.pathname = new URL("guide.html", location.href).pathname;
    return url;
  };
  let guideFrame = null;
  let guideZoom = 1;
  const zoomLevel = $("#zoom-level");
  function paintGuideZoom(force = false) {
    if (body.dataset.mode === "guide" && zoomLevel && (force || document.activeElement !== zoomLevel)) zoomLevel.value = `${Math.round(guideZoom * 100)}%`;
  }
  function setGuideZoom(scale) {
    if (Number.isFinite(scale) && scale > 0) guideZoom = Math.max(0.25, Math.min(16, scale));
    paintGuideZoom(true);
    guideFrame?.contentWindow?.postMessage({ source: "ivy-shell", type: "zoom", scale: guideZoom }, "*");
  }
  toolbar?.addEventListener("click", (e) => {
    if (body.dataset.mode !== "guide") return;
    const button = e.target.closest("[data-zoom], [data-reset-zoom]");
    if (button) setGuideZoom(button.hasAttribute("data-reset-zoom") ? 1 : guideZoom * (button.dataset.zoom === "+" ? 1.2 : 1 / 1.2));
  });
  zoomLevel?.addEventListener("change", () => {
    if (body.dataset.mode === "guide") setGuideZoom(Number(zoomLevel.value.trim().replace(/%$/, "")) / 100);
  });
  zoomLevel?.addEventListener("keydown", (e) => {
    if (body.dataset.mode === "guide" && e.key === "Escape") { paintGuideZoom(true); zoomLevel.blur(); }
  });
  document.addEventListener("keydown", (e) => {
    if (body.dataset.mode !== "guide" || !(e.metaKey || e.ctrlKey) || e.altKey || !["+", "=", "-", "0"].includes(e.key)) return;
    e.preventDefault();
    setGuideZoom(e.key === "0" ? 1 : guideZoom * (e.key === "-" ? 1 / 1.2 : 1.2));
  });
  function syncThemeToFrame(theme) {
    if (!guideFrame || !guideFrame.contentWindow) return;
    guideFrame.contentWindow.postMessage({ source: "ivy-shell", type: "theme", theme }, "*");
  }
  function ensureGuideFrame() {
    if (guideFrame) return guideFrame;
    guideFrame = document.createElement("iframe");
    guideFrame.title = "Ivy Vaults · Protocol guide";
    // Fires on the initial load and again on every in-frame navigation (e.g.
    // a reader following a link to another guide page), so the theme is
    // re-posted each time rather than assumed to persist.
    guideFrame.addEventListener("load", () => {
      // Belt and braces against the classic double-load-event trap: if src
      // is ever set after insertion, the DOM briefly holds an implicit
      // about:blank document, which some browsers fire a "load" for in
      // addition to the real navigation. Setting src below, before this
      // element is connected to the document, avoids that in evergreen
      // Chrome, but this guard keeps a stray about:blank event from marking
      // the guide "loaded" a beat early regardless.
      try {
        if (guideFrame.contentWindow.location.href === "about:blank") return;
      } catch (_) {}
      panelGuide.classList.add("is-loaded");
      syncThemeToFrame(currentTheme());
      setGuideZoom(guideZoom);
      guideFrame.contentWindow.postMessage({ source: "ivy-shell", type: "reveal-heading" }, "*");
    });
    // Least-invasive theme handoff: the guide's own inline head
    // script reads this key on first parse, so setting it before assigning
    // src means the guide opens in the right theme without any postMessage
    // protocol or edit to the guide itself.
    try { localStorage.setItem("ivy-theme", currentTheme()); } catch (_) {}
    // src is set before the frame is connected to the document (the next
    // line), so the browser navigates straight to it instead of first
    // loading about:blank and then the real page.
    guideFrame.src = guideLocation.href;
    panelGuide.appendChild(guideFrame);
    const loading = document.createElement("div");
    loading.className = "guide-loading";
    loading.setAttribute("role", "status");
    loading.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span>Loading guide…</span>';
    panelGuide.appendChild(loading);
    return guideFrame;
  }

  /* ---------- Sliding/morphing indicator ---------- */
  function positionThumb() {
    const active = tabGuide.getAttribute("aria-selected") === "true" ? tabGuide : tabMap;
    const cRect = tablist.getBoundingClientRect(), aRect = active.getBoundingClientRect();
    if (!aRect.width) return; // not laid out yet
    thumb.style.width = `${aRect.width}px`;
    thumb.style.transform = `translateX(${aRect.left - cRect.left}px)`;
  }

  // The index owns the public URL. Map and Guide keep separate locations.
  function syncUrl(mode) {
    const url = new URL(location.href);
    if (mode === "map") {
      url.searchParams.set("view", "map");
      url.searchParams.delete("doc");
      url.hash = mapHash;
    } else {
      url.searchParams.delete("view");
      const page = guideLocation.pathname.split("/").at(-1);
      if (page === "guide.html") url.searchParams.delete("doc");
      else url.searchParams.set("doc", page);
      url.hash = guideLocation.hash;
    }
    history.replaceState(null, "", url.pathname + url.search + url.hash);
  }

  /* ---------- Mode switch: both panels stay mounted; only visibility,
     inert and the crossfade class move. Neither the map nor the guide is
     ever re-created, so neither loses its state. ---------- */
  function setMode(mode, { updateUrl = true, focus = false } = {}) {
    const toMap = mode !== "guide";
    // Map zoom is for navigation; Guide zoom is a reading preference.
    // Switching views preserves both independently.
    // Map has a different toolbar height. Keep the hidden Guide viewport
    // stable so its browser scroll anchoring cannot move the reading position.
    if (toMap && body.dataset.mode === "guide") panelGuide.style.height = `${panelGuide.getBoundingClientRect().height}px`;
    if (body.dataset.mode === "map") mapHash = location.hash;
    if (toMap) body.setAttribute("data-map-visited", "");
    tabMap.setAttribute("aria-selected", String(toMap));
    tabGuide.setAttribute("aria-selected", String(!toMap));
    tabMap.tabIndex = toMap ? 0 : -1;
    tabGuide.tabIndex = toMap ? -1 : 0;
    panelMap.dataset.active = String(toMap);
    panelGuide.dataset.active = String(!toMap);
    panelMap.toggleAttribute("inert", !toMap);
    panelGuide.toggleAttribute("inert", toMap);
    body.dataset.mode = toMap ? "map" : "guide";
    if (!toMap) panelGuide.style.height = "";
    positionThumb();
    if (!toMap) ensureGuideFrame();
    if (toMap && window.IvyMap?.mounted) {
      window.IvyMap.paintZoom();
    }
    else paintGuideZoom();
    $(".skip-link").href = toMap ? "#map" : "#panel-guide";
    if (updateUrl) syncUrl(toMap ? "map" : "guide");
    if (focus) (toMap ? tabMap : tabGuide).focus();
  }

  // A map reference opens at its canonical location in Guide. The camera
  // stays mounted so returning to Map continues from the same place.
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[data-guide]");
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    guideLocation = guideUrl(link.href);
    setMode("guide", { focus: true });
    const frame = ensureGuideFrame();
    // Reapply explicit references even after the reader navigated inside
    // Guide. A fragment-only jump need not fire load, so keep a loaded panel.
    frame.src = guideLocation.href;
    // Same-document and repeated links may not fire load or hashchange.
    frame.contentWindow.postMessage({ source: "ivy-shell", type: "reveal-heading", url: guideLocation.href }, "*");
  });

  $("#back-to-map")?.addEventListener("click", () => {
    setMode("map");
    mapEl?.focus({ preventScroll: true });
  });
  tabMap.addEventListener("click", () => setMode("map"));
  tabGuide.addEventListener("click", () => setMode("guide"));
  tablist.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Home") return setMode("guide", { focus: true });
    if (e.key === "End") return setMode("map", { focus: true });
    const goingGuide = tabMap.getAttribute("aria-selected") === "true";
    setMode(goingGuide ? "guide" : "map", { focus: true });
  });
  window.addEventListener("resize", positionThumb);

  /* ---------- Theme sync, both directions ----------
     Shell → guide: map.js's own theme button dispatches "map:theme" on #map
     after it flips document.documentElement's data-theme; forward that to
     the live frame by postMessage (see syncThemeToFrame above).
     Guide → shell: the guide's embed.js watches its own document's
     data-theme for changes not caused by an incoming postMessage (i.e. the
     reader used the guide's own Theme button) and posts them back here. The
     "storage" listener below is kept as a harmless second path: on hosts
     where file:// origins happen to share localStorage, the guide's own
     write of "ivy-theme" (docs.js) also fires a native "storage" event on
     this window, but nothing depends on it firing. */
  function applyIncomingTheme(next) {
    if (next !== "light" && next !== "dark") return;
    if (document.documentElement.dataset.theme === next) return;
    document.documentElement.dataset.theme = next;
    const themeBtn = $("#themeToggle");
    if (themeBtn) themeBtn.textContent = `Theme · ${next}`;
  }
  mapEl?.addEventListener("map:theme", () => syncThemeToFrame(currentTheme()));
  window.addEventListener("storage", (e) => {
    if (e.key === "ivy-theme") applyIncomingTheme(e.newValue);
  });
  window.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || data.source !== "ivy-guide") return;
    if (!guideFrame || e.source !== guideFrame.contentWindow) return;
    if (data.type === "theme") applyIncomingTheme(data.theme);
    if (data.type === "location") {
      guideLocation = guideUrl(data.url);
      if (body.dataset.mode === "guide") syncUrl("guide");
    }
    if (data.type === "zoom" && Number.isFinite(data.scale) && data.scale >= 0.25 && data.scale <= 16) {
      guideZoom = data.scale;
      paintGuideZoom();
    }
  });

  // Plain visits always open Guide. An explicit Map URL selects Map.
  addEventListener("hashchange", () => {
    if (body.dataset.mode !== "guide" || ["#panel-guide", "#map"].includes(location.hash)) return;
    guideLocation.hash = location.hash;
    ensureGuideFrame().src = guideLocation.href;
  });
  setMode(initialMode, { updateUrl: false });
  // JetBrains Mono swaps in after the fallback font first paints the tabs
  // (font-display: swap), which can change their width; re-measure once it
  // has, so the indicator doesn't sit fractionally off until the next resize.
  document.fonts?.ready?.then(positionThumb);

  window.IvyShell = { setMode, state: () => ({ mode: body.dataset.mode, guideLoaded: !!guideFrame && panelGuide.classList.contains("is-loaded") }) };
})();
