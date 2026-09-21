/* App shell: the Map/Guide mode toggle in the top bar, and the lazy iframe
   that holds the classic guide. Both views stay mounted for the whole
   session — switching only changes which panel is visible — so the map's
   camera and the guide's scroll position are never disturbed by a switch.
   This file knows nothing about how the map or the guide work internally; it
   only toggles panels, an inert attribute, a query-string flag and, for
   theme, a shared localStorage key. */
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
  let guideFrame = null;
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
    });
    // Least-invasive theme handoff: the classic guide's own inline head
    // script reads this key on first parse, so setting it before assigning
    // src means the guide opens in the right theme without any postMessage
    // protocol or edit to the guide itself.
    try { localStorage.setItem("ivy-theme", currentTheme()); } catch (_) {}
    // src is set before the frame is connected to the document (the next
    // line), so the browser navigates straight to it instead of first
    // loading about:blank and then the real page.
    guideFrame.src = "../index.html";
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

  /* ---------- URL: ?view=guide round-trips the mode; the map's own #hash
     handling (assets/map.js) is untouched and always wins the fragment. ---------- */
  function syncUrl(mode) {
    const url = new URL(location.href);
    if (mode === "guide") url.searchParams.set("view", "guide");
    else url.searchParams.delete("view");
    const next = url.pathname + url.search + url.hash;
    if (next !== location.pathname + location.search + location.hash) history.replaceState(null, "", next);
  }
  // A bare visit (no ?view in the URL at all) has no query to read, so the
  // last mode is remembered here instead, separately from the URL itself.
  const MODE_KEY = "ivy-view";
  function rememberMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode); } catch (_) {}
  }

  /* ---------- Mode switch: both panels stay mounted; only visibility,
     inert and the crossfade class move. Neither the map nor the guide is
     ever re-created, so neither loses its state. ---------- */
  function setMode(mode, { updateUrl = true, focus = false } = {}) {
    const toMap = mode !== "guide";
    tabMap.setAttribute("aria-selected", String(toMap));
    tabGuide.setAttribute("aria-selected", String(!toMap));
    tabMap.tabIndex = toMap ? 0 : -1;
    tabGuide.tabIndex = toMap ? -1 : 0;
    panelMap.dataset.active = String(toMap);
    panelGuide.dataset.active = String(!toMap);
    panelMap.toggleAttribute("inert", !toMap);
    panelGuide.toggleAttribute("inert", toMap);
    if (toolbar) toolbar.toggleAttribute("inert", !toMap);
    body.dataset.mode = toMap ? "map" : "guide";
    positionThumb();
    if (!toMap) ensureGuideFrame();
    rememberMode(toMap ? "map" : "guide");
    if (updateUrl) syncUrl(toMap ? "map" : "guide");
    if (focus) (toMap ? tabMap : tabGuide).focus();
  }

  tabMap.addEventListener("click", () => setMode("map"));
  tabGuide.addEventListener("click", () => setMode("guide"));
  tablist.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Home") return setMode("map", { focus: true });
    if (e.key === "End") return setMode("guide", { focus: true });
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
    if (!data || data.source !== "ivy-guide" || data.type !== "theme") return;
    if (!guideFrame || e.source !== guideFrame.contentWindow) return;
    applyIncomingTheme(data.theme);
  });

  /* ---------- Boot: restore mode from the URL, never re-fitting the map to
     do it. A bare visit (no ?view param either way) falls back to the mode
     remembered in localStorage from the last visit; the URL, when present,
     always wins over it. Guide load is lazy — first switch only — so it
     never competes with the map's first paint. ---------- */
  const params = new URLSearchParams(location.search);
  let initialMode = "map";
  if (params.get("view") === "guide") initialMode = "guide";
  else if (!params.has("view")) {
    let remembered = null;
    try { remembered = localStorage.getItem(MODE_KEY); } catch (_) {}
    if (remembered === "guide") initialMode = "guide";
  }
  setMode(initialMode, { updateUrl: false });
  // JetBrains Mono swaps in after the fallback font first paints the tabs
  // (font-display: swap), which can change their width; re-measure once it
  // has, so the indicator doesn't sit fractionally off until the next resize.
  document.fonts?.ready?.then(positionThumb);

  window.IvyShell = { setMode, state: () => ({ mode: body.dataset.mode, guideLoaded: !!guideFrame && panelGuide.classList.contains("is-loaded") }) };
})();
