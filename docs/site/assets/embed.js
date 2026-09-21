/* Embed hook for the guide and its sub-pages, loaded by every one of
   them. Does nothing at all when a page is opened standalone. When a page is
   shown inside the documentation shell's Guide iframe (docs/site/index.html),
   it (a) hides that page's own .topbar, so the shell's top bar is the only
   one on screen, and (b) keeps this document's colour theme in sync with the
   shell's, in both directions, and (c) applies Guide zoom from the shell
   or a trackpad pinch, preserving the content under the gesture.

   Every value that reaches across the frame boundary travels by postMessage,
   never by reaching into the other document directly: on file:// each frame
   gets its own opaque origin, so contentDocument access across frames throws,
   even though postMessage (which was designed to cross origins) still works.

   Standalone pages keep their normal browser zoom behavior. */
(() => {
  if (window.self === window.top) return; // standalone: no-op

  const root = document.documentElement;
  root.classList.add("ivy-embedded");
  const style = document.createElement("style");
  style.textContent = `
    html.ivy-embedded .topbar { display: none; }
    html.ivy-embedded { scroll-padding-top: 12px; }
    html.ivy-embedded .rail { top: 0; padding-top: 12px; }
    /* CSS zoom does not change media queries. Fold the rail when the
       remaining reading width is narrow, just as on a small screen. */
    html.ivy-embedded[data-zoom-narrow] .rail { position: static; width: auto; max-height: none; padding: 12px; border-right: 0; }
    html.ivy-embedded[data-zoom-narrow] .rail nav { grid-template-columns: 1fr; }
    html.ivy-embedded[data-zoom-narrow] .rail-links { display: none; }
    html.ivy-embedded[data-zoom-narrow] .content,
    html.ivy-embedded[data-zoom-narrow] footer { margin-left: 0; padding-left: 12px; padding-right: 12px; }
    html.ivy-embedded[data-zoom-narrow] h1 { overflow-wrap: anywhere; }
  `;
  document.head.appendChild(style);

  // Tracks the last theme this frame itself applied or announced, so the
  // MutationObserver below can tell "the shell just told us to change" apart
  // from "our own theme button changed it" and only report the latter.
  let known = root.getAttribute("data-theme");
  let zoom = 1;
  let unfoldedContents = null;
  function updateZoomLayout(scale) {
    const narrow = scale > 1 && innerWidth / scale <= 760;
    const contents = document.getElementById("contents");
    if (contents && narrow && !root.hasAttribute("data-zoom-narrow")) {
      unfoldedContents = contents.open;
      contents.open = false;
    } else if (contents && !narrow && unfoldedContents !== null) {
      contents.open = unfoldedContents;
      unfoldedContents = null;
    }
    root.toggleAttribute("data-zoom-narrow", narrow);
  }
  addEventListener("resize", () => updateZoomLayout(zoom));
  function applyZoom(scale, { x = innerWidth / 2, y = innerHeight / 2, notify = true } = {}) {
    if (!Number.isFinite(scale) || scale <= 0) return;
    const next = Math.max(0.25, Math.min(16, scale));
    if (next !== zoom) {
      const anchor = document.elementFromPoint(x, y);
      const before = anchor?.getBoundingClientRect();
      const fraction = before?.height ? (y - before.top) / before.height : 0;
      root.style.zoom = String(next);
      updateZoomLayout(next);
      zoom = next;
      if (before && anchor) {
        const after = anchor.getBoundingClientRect();
        scrollBy(0, after.top + after.height * fraction - y);
      }
    }
    // Keep the explicit default observable too, including after navigation.
    root.style.zoom = String(zoom);
    if (notify) window.top.postMessage({ source: "ivy-guide", type: "zoom", scale: zoom }, "*");
  }
  document.addEventListener("wheel", (e) => {
    // Chromium emits Ctrl+wheel for a trackpad pinch. Ordinary wheel input
    // remains scrolling.
    if (!e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
    // Match Map sensitivity, including coarse wheel-event limits.
    const zoomDelta = Math.max(-0.1, Math.min(0.1, -delta * 0.002));
    applyZoom(zoom * Math.exp(zoomDelta), { x: e.clientX, y: e.clientY });
  }, { passive: false });
  document.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || !["+", "=", "-", "0"].includes(e.key)) return;
    e.preventDefault();
    applyZoom(e.key === "0" ? 1 : zoom * (e.key === "-" ? 1 / 1.2 : 1.2));
  });

  // Links back to the index remain inside the existing Guide frame. Loading
  // the shell here would nest another app and lose the visible Map toggle.
  document.addEventListener("click", (e) => {
    const link = e.target.closest("a[href]");
    if (!link || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || link.target === "_blank") return;
    const destination = new URL(link.href);
    const index = new URL("index.html", location.href);
    if (destination.origin !== index.origin || destination.pathname !== index.pathname) return;
    e.preventDefault();
    const guide = new URL("guide.html", location.href);
    guide.hash = destination.hash;
    location.href = guide.href;
  });
  function revealHeading() {
    const hash = location.hash;
    document.fonts.ready.then(() => requestAnimationFrame(() => {
      if (location.hash !== hash) return;
      if (!hash) { scrollTo({ top: 0, left: 0, behavior: "instant" }); return; }
      let id;
      try { id = decodeURIComponent(hash.slice(1)); } catch (_) { return; }
      const target = document.getElementById(id);
      if (!target) return;
      const headings = "h1,h2,h3,h4,h5,h6";
      const heading = target.matches(headings) ? target : target.querySelector(headings) || target;
      // Align after zoom and font layout, using screen pixels so a large
      // zoom does not also enlarge the gap above the destination heading.
      scrollTo({ top: scrollY + heading.getBoundingClientRect().top - 12, behavior: "instant" });
    }));
  }
  addEventListener("hashchange", revealHeading);
  const reportLocation = () => window.top.postMessage({ source: "ivy-guide", type: "location", url: location.href }, "*");
  addEventListener("hashchange", reportLocation);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", reportLocation);
  else reportLocation();

  function applyTheme(theme) {
    if (theme !== "light" && theme !== "dark") return;
    if (root.getAttribute("data-theme") === theme) return;
    known = theme;
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("ivy-theme", theme); } catch (_) {}
    // Mirrors docs.js's own labelTheme() text so this page's Theme button
    // (hidden, but still reachable if the reader tabs to it) doesn't read
    // stale after a theme change made from the shell.
    const btn = document.getElementById("themeToggle");
    if (btn) btn.textContent = `Theme · ${theme}`;
  }

  window.addEventListener("message", (e) => {
    const data = e.data;
    if (e.source !== window.top || !data || data.source !== "ivy-shell") return;
    if (data.type === "theme") applyTheme(data.theme);
    // Do not echo a shell command: a delayed reply could roll its readout
    // back while the reader is already issuing the next zoom command.
    if (data.type === "zoom") applyZoom(data.scale, { notify: false });
    if (data.type === "reveal-heading" && (!data.url || data.url === location.href)) revealHeading();
  });

  new MutationObserver(() => {
    const theme = root.getAttribute("data-theme");
    if (theme === known) return; // the shell told us; don't echo it back
    if (theme !== "light" && theme !== "dark") return;
    known = theme;
    window.top.postMessage({ source: "ivy-guide", type: "theme", theme }, "*");
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
})();
