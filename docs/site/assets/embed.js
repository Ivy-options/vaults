/* Embed hook for the classic guide and its sub-pages, loaded by every one of
   them. Does nothing at all when a page is opened standalone. When a page is
   shown inside the map shell's Guide-view iframe (docs/site/v2/index.html),
   it (a) hides that page's own .topbar, so the shell's top bar is the only
   one on screen, and (b) keeps this document's colour theme in sync with the
   shell's, in both directions.

   Every value that reaches across the frame boundary travels by postMessage,
   never by reaching into the other document directly: on file:// each frame
   gets its own opaque origin, so contentDocument access across frames throws,
   even though postMessage (which was designed to cross origins) still works.

   This is the only script the classic pages load beyond their own; it does
   not alter anything else about them. */
(() => {
  if (window.self === window.top) return; // standalone: no-op

  const root = document.documentElement;
  root.classList.add("ivy-embedded");
  const style = document.createElement("style");
  style.textContent = "html.ivy-embedded .topbar{display:none}";
  document.head.appendChild(style);

  // Tracks the last theme this frame itself applied or announced, so the
  // MutationObserver below can tell "the shell just told us to change" apart
  // from "our own theme button changed it" and only report the latter.
  let known = root.getAttribute("data-theme");

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
    if (!data || data.source !== "ivy-shell" || data.type !== "theme") return;
    applyTheme(data.theme);
  });

  new MutationObserver(() => {
    const theme = root.getAttribute("data-theme");
    if (theme === known) return; // the shell told us; don't echo it back
    if (theme !== "light" && theme !== "dark") return;
    known = theme;
    window.top.postMessage({ source: "ivy-guide", type: "theme", theme }, "*");
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
})();
