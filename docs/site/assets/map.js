/* Lifecycle map engine. Builds a zoomable world from the semantic document in #document. */
(() => {
  const $ = (s, scope = document) => scope.querySelector(s);
  const $$ = (s, scope = document) => [...scope.querySelectorAll(s)];
  const KINDS = ["station", "moment", "action", "tile", "lab", "custody", "root"];
  // document.currentScript is only live during this synchronous run, so capture the
  // assets/ base now (relative to this script's own URL) for use inside later renders.
  const ASSET_BASE = document.currentScript ? new URL(".", document.currentScript.src).href : "assets/";

  // Walk nested <section data-kind> elements. Heading = label; data-* = tier text; body = everything else.
  function readDocument(root) {
    const nodes = [], byId = new Map();
    const bodyOf = (el) => $$(":scope > *", el).filter((c) => !/^H[1-6]$/.test(c.tagName) && c.tagName !== "SECTION");
    function visit(el, parent, band) {
      const kind = el.dataset.kind;
      // A <section> that never got a data-kind is invisible to the
      // ":scope > section[data-kind]" walk below, so without this check its
      // whole subtree would silently vanish from the map while staying
      // visible in the fallback document — the same class of authoring mistake as
      // an unknown kind or a missing id, so it gets the same treatment.
      if (kind === undefined) throw new Error(`Section without data-kind under ${parent?.id ?? "root"}`);
      if (!KINDS.includes(kind)) throw new Error(`Unknown data-kind on #${el.id}`);
      if (!el.id) throw new Error(`Section without id under ${parent?.id ?? "root"}`);
      const heading = $(":scope > h2, :scope > h3, :scope > h4, :scope > h5", el);
      const body = bodyOf(el);
      const firstP = body.find((c) => c.tagName === "P");
      const node = {
        id: el.id, kind, band, source: el, parent, children: [],
        depth: parent ? parent.depth + 1 : 0,
        label: heading ? heading.textContent.trim() : el.id,
        // Plain-text label drives search and breadcrumbs; titleHtml keeps a tile
        // heading's own markup (e.g. `<code>` around an identifier) so the card
        // doesn't flatten it back down to text.
        titleHtml: heading ? heading.innerHTML.trim() : el.id,
        actor: el.dataset.actor || null,
        dim: el.hasAttribute("data-dim"),
        when: el.dataset.when || "",
        tagline: el.dataset.tagline || "",
        span: Number(el.dataset.span || 1),
        illustration: el.dataset.illustration || "",
        summary: (firstP || body[0])?.textContent.trim() || "",
        bodyHtml: body.map((c) => c.outerHTML).join(""),
      };
      node.path = parent ? `${parent.path}/${node.id}` : node.id;
      if (byId.has(node.id)) throw new Error(`Duplicate node id ${node.id}`);
      nodes.push(node); byId.set(node.id, node);
      if (parent) parent.children.push(node);
      $$(":scope > section", el).forEach((child) => visit(child, node, band));
      return node;
    }
    $$(":scope > section", root.querySelector("article") || root).forEach((el) =>
      visit(el, null, el.dataset.band === "shelf" ? "shelf" : "life"));
    return { nodes, byId };
  }

  const G = {
    station: [360, 200], moment: [300, 170], action: [300, 150], custody: [220, 170], root: [640, 340],
    gap: 40, momentY: 320, actionY: 560, actionGap: 20, tile: 132, tileGap: 12,
    columnPad: 80, bandGap: 260, minTile: 40, rootGap: 120,
  };
  const spanW = (span) => (span >= 2 ? 2 * G.tile + G.tileGap : G.tile);

  // Places every node. Stations left to right per band; moments in a centred row; actions stacked; tiles in a two-column grid.
  // A root card (the apex, above every station) is optional: fixtures and tests
  // that omit it keep the exact geometry this had before roots existed.
  function layoutWorld(nodes, measure) {
    const lines = [];
    const line = (x, y, w, h, kind) => lines.push({ x, y, w, h, kind });
    const root = nodes.find((n) => n.kind === "root");
    // With a root, the life band's main line drops from G.rootGap below the
    // root card instead of sitting a fixed 40px above y0=0; rootOffset shifts
    // the whole life band down by exactly that much so the root, in turn,
    // sits at y=0. Without a root this is 0 and every coordinate below is
    // identical to the pre-root layout.
    const rootOffset = root ? G.root[1] + G.rootGap + 40 : 0;
    const layoutBand = (band, y0) => {
      let cursor = 0, bottom = y0;
      nodes.filter((n) => n.kind === "station" && n.band === band).forEach((st) => {
        const moments = st.children.filter((c) => c.kind === "moment");
        const custody = st.children.find((c) => c.kind === "custody");
        const rowW = moments.length ? moments.length * G.moment[0] + (moments.length - 1) * G.gap : 0;
        const colW = Math.max(rowW, G.station[0] + 2 * (G.gap + G.custody[0])) + 2 * G.columnPad;
        const rowX = cursor + (colW - rowW) / 2;
        const stX = cursor + (colW - G.station[0]) / 2;
        Object.assign(st, {
          x: moments.length ? rowX + rowW / 2 - G.station[0] / 2 : stX,
          y: y0, w: G.station[0], h: G.station[1], column: { x: cursor, w: colW },
        });
        if (custody) Object.assign(custody, { x: st.x + G.station[0] + G.gap, y: y0, w: G.custody[0], h: G.custody[1] });
        let colBottom = y0 + G.station[1];
        moments.forEach((m, j) => {
          Object.assign(m, { x: rowX + j * (G.moment[0] + G.gap), y: y0 + G.momentY, w: G.moment[0], h: Math.max(G.moment[1], measure(m)) });
          let ay = Math.max(y0 + G.actionY, m.y + m.h + G.gap);
          m.children.filter((c) => c.kind === "action").forEach((a) => {
            const headerH = Math.max(96, measure(a));
            Object.assign(a, { x: m.x, y: ay, w: G.action[0], headerH });
            let cursorY = headerH;
            const tiles = a.children.filter((c) => c.kind === "tile" || c.kind === "lab");
            for (let i = 0; i < tiles.length; ) {
              const row = [];
              let used = 0;
              while (i < tiles.length && used + (tiles[i].kind === "lab" ? 2 : tiles[i].span) <= 2) { used += tiles[i].kind === "lab" ? 2 : tiles[i].span; row.push(tiles[i++]); }
              if (!row.length) { row.push(tiles[i++]); }
              const rowH = Math.max(G.minTile, ...row.map(measure));
              let x = a.x + G.tileGap;
              row.forEach((t) => {
                const w = spanW(t.kind === "lab" ? 2 : t.span);
                Object.assign(t, { x, y: ay + cursorY + G.tileGap, w, h: rowH });
                x += w + G.tileGap;
              });
              cursorY += G.tileGap + rowH;
            }
            a.h = tiles.length ? cursorY + G.tileGap : headerH;
            ay += a.h + G.actionGap;
          });
          m.bottom = m.children.some((c) => c.kind === "action") ? ay - G.actionGap : m.y + m.h;
          colBottom = Math.max(colBottom, m.bottom);
        });
        st.column.h = colBottom - y0;
        bottom = Math.max(bottom, colBottom);
        cursor += colW;
      });
      return { width: cursor, bottom };
    };
    const life = layoutBand("life", rootOffset);
    const shelfY = life.bottom + G.bandGap;
    const shelf = layoutBand("shelf", shelfY);
    let width = Math.max(life.width, shelf.width);
    const cx = (n) => n.x + n.w / 2;
    // The life band's main line and its per-station pins: 40px above y0, same
    // as always — y0 is just rootOffset instead of 0 when a root exists.
    const mainY = rootOffset - 40;
    if (root) {
      Object.assign(root, { x: life.width / 2 - G.root[0] / 2, y: 0, w: G.root[0], h: G.root[1] });
      width = Math.max(width, root.x + root.w);
    }
    // Connectors: root drop, main line, shelf rule, drops, rows, gaps, pins. Drawn only where no card sits.
    line(0, mainY, life.width, 2, "main");
    if (shelf.width) { line(0, shelfY - 60, shelf.width, 1, "rule"); }
    nodes.filter((n) => n.kind === "station").forEach((st) => {
      const moments = st.children.filter((c) => c.kind === "moment");
      if (st.band === "life") line(cx(st), mainY, 0, 0, "pin-main");
      if (!moments.length) return;
      const rowLineY = st.y + G.momentY - 30;
      line(cx(st) - 1, st.y + st.h, 2, rowLineY - (st.y + st.h), "drop");
      line(cx(moments[0]), rowLineY - 1, cx(moments[moments.length - 1]) - cx(moments[0]), 2, "row");
      moments.forEach((m) => {
        line(cx(m), rowLineY, 0, 0, "pin");
        let prev = m.y + m.h;
        m.children.filter((c) => c.kind === "action").forEach((a) => { line(cx(m) - 1, prev, 2, a.y - prev, "gap"); prev = a.y + a.h; });
      });
    });
    if (root) {
      line(cx(root) - 1, root.y + root.h, 2, mainY - (root.y + root.h), "drop");
      line(cx(root), mainY, 0, 0, "pin-main");
    }
    return { width, height: Math.max(life.bottom, shelf.bottom) + 80, lines };
  }

  /* ---------- Cast ---------- */
  const CROPS = { owner: "24 76 477 580", lp: "504 76 425 580", buyer: "931 76 461 580", bid: "1394 76 533 580" };
  const ACTOR_NAMES = { owner: "Owner", lp: "LP", buyer: "Buyer", bid: "Bid master", anyone: "Anyone", publisher: "Price publisher", admin: "Admin", guardian: "Guardian", all: "All parties" };
  const GLYPHS = { anyone: "?", publisher: "$", admin: "A", guardian: "G", all: "∀" };
  let clipSeq = 0;
  function portrait(key) {
    if (!CROPS[key]) return `<span class="portrait generic" aria-hidden="true"><i>${GLYPHS[key] || "?"}</i></span>`;
    const [x, y, w, h] = CROPS[key].split(" ");
    const id = `map-clip-${clipSeq++}`;
    return `<span class="portrait"><svg viewBox="${CROPS[key]}" aria-hidden="true" focusable="false"><defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath></defs><image href="${ASSET_BASE}operator-portraits.webp" width="1942" height="809" clip-path="url(#${id})"/></svg></span>`;
  }
  const badge = (n) => `<span class="badge">${ACTOR_NAMES[n.actor] || n.actor}</span>`;
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  /* ---------- Tier layers per kind ----------
     Zoom reveals explanations and details, then keeps them readable. */
  function layersFor(n) {
    const t = esc(n.label), when = n.when ? `<span class="when">${esc(n.when)}</span>` : "";
    switch (n.kind) {
      case "root":
        return { 0: `<h2>${t}</h2>`, 1: `<h2>${t}</h2><p class="tagline">${esc(n.tagline)}</p><div class="body">${n.bodyHtml}</div>` };
      case "station": {
        const count = n.children.filter((c) => c.kind === "moment").length;
        return { 0: `<h2>${t}</h2>`, 1: `<h2>${t}</h2><p>${esc(n.tagline)}</p><small>${count} ${n.band === "shelf" ? "topics" : "moments"} · zoom in</small>` };
      }
      case "moment":
        return { 0: `<h3>${t}</h3>`, 2: `${when}<h3>${t}</h3><div class="moment-body">${n.bodyHtml}</div>` };
      case "action": {
        const head = n.actor ? badge(n) : "";
        const more = n.children.length ? `<small>${n.children.length} details · zoom in</small>` : "";
        const layers = { 0: head || `<h4>${t}</h4>`, 1: `${head}<h4>${t}</h4>`, 2: `${head}<h4>${t}</h4><div class="action-body">${n.bodyHtml}</div>${more}` };
        return layers;
      }
      case "tile": {
        const th = n.titleHtml; // trusted markup from the authored heading, e.g. <code>strikeLimit</code>
        return { 0: `<i class="more" aria-hidden="true"></i>`, 2: `<h5>${th}</h5>`, 3: `<h5>${th}</h5><div class="body">${n.bodyHtml}</div>` };
      }
      case "lab":
        return { 0: `<i class="more" aria-hidden="true"></i>`, 2: `<h5>${t}</h5><div class="lab-host">${n.bodyHtml}</div>` };
      case "custody":
        return { 1: `<h3>${t}</h3>`, 2: `<h3>${t}</h3><div class="body">${n.bodyHtml}</div>` };
    }
  }
  const lodOf = (s) => (s < 0.55 ? 0 : s < 1.1 ? 1 : s < 2.4 ? 2 : 3);

  function render(tree, world, worldEl, mapEl) {
    const lines = document.createElement("div");
    lines.className = "lines";
    lines.innerHTML = world.lines.map((l) => l.kind.startsWith("pin")
      ? `<i class="pin ${l.kind}" style="left:${l.x}px;top:${l.y}px"></i>`
      : `<i class="line ${l.kind}" style="left:${l.x}px;top:${l.y}px;width:${l.w}px;height:${l.h}px"></i>`).join("");
    worldEl.style.width = `${world.width}px`;
    worldEl.style.height = `${world.height}px`;
    worldEl.replaceChildren(lines);
    tree.nodes.forEach((n) => {
      const el = document.createElement("div");
      el.className = `card ${n.kind}${n.actor ? " " + n.actor : ""}${n.dim ? " dim" : ""}${n.children.length && n.kind === "action" ? " has-details" : ""}`;
      el.dataset.id = n.id;
      el.dataset.kind = n.kind;
      el.tabIndex = -1;
      el.setAttribute("aria-label", n.label);
      const layers = layersFor(n);
      const watermark = n.kind === "action" && n.actor ? `<div class="watermark" aria-hidden="true">${portrait(n.actor)}</div>`
        : n.kind === "moment" && n.illustration ? `<div class="watermark painting" aria-hidden="true"><img src="${ASSET_BASE}${esc(n.illustration)}" alt="" loading="lazy" decoding="async"></div>` : "";
      el.innerHTML = watermark + Object.entries(layers).map(([tier, html]) => `<div data-tier="${tier}"${tier === "3" && n.kind !== "tile" ? ' class="compact"' : ""}>${html}</div>`).join("");
      el.dataset.tiers = Object.keys(layers).join(",");
      el.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px${n.headerH ? `;--header:${n.headerH}px` : ""}`;
      n.el = el;
      worldEl.append(el);
    });
  }
  let currentLod = -1, shownTarget = null;
  function setLod(lod, worldEl = $("#world")) {
    const target = M?.revealed?.id || null;
    if (lod === currentLod && target === shownTarget) return;
    currentLod = lod;
    shownTarget = target;
    worldEl.dataset.lod = lod;
    $$(".card", worldEl).forEach((el) => {
      const tiers = el.dataset.tiers.split(",").map(Number);
      const selectedTier = { root: 1, station: 1, moment: 2, action: 2, lab: 2, custody: 2, tile: 3 };
      const detail = el.dataset.id === target ? Math.max(lod, selectedTier[el.dataset.kind]) : lod;
      el.dataset.show = String(Math.max(-1, ...tiers.filter((t) => t <= detail)));
    });
  }

  // Measure a tile or lab (its deepest layer) or an action header (its tallest reading layer) at the card width.
  function makeMeasurer(worldEl) {
    const probe = document.createElement("div");
    probe.className = "card probe";
    worldEl.append(probe);
    const heightOf = (n, tier, width) => {
      const html = layersFor(n)[tier];
      if (!html) return 0;
      probe.className = `card probe ${n.kind}`;
      probe.style.width = `${width}px`;
      probe.innerHTML = `<div data-tier="${tier}" class="measure">${html}</div>`;
      if (n.kind === "lab") window.IvyLabs?.mountAll(probe); // labs fill their DOM on mount; measure the rendered initial state
      const h = probe.firstElementChild.offsetHeight + 2;
      probe.innerHTML = "";
      return h;
    };
    return (n) => {
      if (n.kind === "moment") return heightOf(n, 2, G.moment[0]);
      if (n.kind === "action") return Math.max(heightOf(n, 2, G.action[0]), heightOf(n, 3, G.action[0]));
      return heightOf(n, n.kind === "lab" ? 2 : 3, spanW(n.kind === "lab" ? 2 : n.span));
    };
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const MAX = 16, DETAIL_SCALE = 3.2, ZOOM_STEP = 1.2;
  let M = null; // mounted state: { tree, world, worldEl, mapEl, cam, W, H }

  function mount() {
    // R1/R6: reveal the map and measure only after web fonts are ready, since
    // fonts change text heights; the caller awaits document.fonts.ready first.
    document.body.classList.add("map-ready");
    window.scrollTo(0, 0);
    const doc = $("#document"), worldEl = $("#world"), mapEl = $("#map");
    if (!doc || !worldEl) return null;
    const tree = readDocument(doc);
    const world = layoutWorld(tree.nodes, makeMeasurer(worldEl));
    render(tree, world, worldEl, mapEl);
    $(".probe", worldEl)?.remove();
    // Labs live in the cards now; the document keeps a placeholder so it still reads without JS.
    tree.nodes.filter((n) => n.kind === "lab").forEach((n) => { n.source.querySelectorAll(":scope > *:not(h5)").forEach((c) => c.remove()); });
    if (window.IvyLabs?.mountAll) window.IvyLabs.mountAll(worldEl);
    M = { tree, world, worldEl, mapEl, cam: { x: 0, y: 0, s: 1 }, W: world.width, H: world.height, atHome: true, target: null, revealed: null };
    wireInput();
    wireSearch(); wireKeys(); wireTouch(); wireChrome();
    document.body.dataset.mode === "guide" ? home(false) : followHash(false);
    addEventListener("hashchange", () => followHash(true));
    return M;
  }

  /* ---------- Camera ---------- */
  const vw = () => M.mapEl.clientWidth, vh = () => M.mapEl.clientHeight;
  const homeScale = () => Math.min(vw() / (M.W + 160), vh() / (M.H + 160));
  const clampCam = () => {
    const { cam, W, H } = M;
    cam.x = clamp(cam.x, Math.min(0, vw() - W * cam.s) - 200, Math.max(0, vw() - W * cam.s) + 200);
    cam.y = clamp(cam.y, Math.min(0, vh() - H * cam.s) - 200, Math.max(0, vh() - H * cam.s) + 200);
  };
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function apply(animate) {
    const { cam, worldEl } = M;
    worldEl.style.transition = animate && !reduced() ? "" : "none";
    worldEl.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.s})`;
    setLod(lodOf(cam.s), worldEl);
    // Recorded now, with the viewport size as it is at this exact moment,
    // because a "resize" event fires only after the browser has already
    // resized #map — by then vw()/vh() (and so homeScale()) already reflect
    // the NEW viewport, while cam.s is still the OLD fit scale, so comparing
    // them live in the resize handler produces false negatives. The resize
    // handler instead trusts this pre-resize snapshot (R9).
    M.atHome = here().length === 0;
    paintPath();
    syncHash();
    M.mapEl.dispatchEvent(new CustomEvent("map:moved"));
  }
  // Frame a world rect. minS forces at least that zoom so the next tier is readable.
  function fly(x, y, w, h, minS = 0, pad = 40, animate = true) {
    const both = Math.min(vw() / (w + pad * 2), vh() / (h + pad * 2));
    const s = clamp(Math.max(both, minS), homeScale(), DETAIL_SCALE);
    const fits = (h + pad * 2) * s <= vh();
    M.cam = { s, x: vw() / 2 - (x + w / 2) * s, y: fits ? vh() / 2 - (y + h / 2) * s : (pad - y + 40) * s };
    clampCam();
    apply(animate);
  }
  // Fits and centres the whole world directly from homeScale(), rather than
  // routing through fly() with its own pad/minS shape — fly()'s fit formula
  // (w+pad*2 / h+pad*2) and homeScale()'s (W+160 / H+160) disagree on a
  // width-bound map, so a scale computed via fly() never exactly equals
  // homeScale() and here()'s "am I at the fit view" gate never fires.
  function home(animate = true) {
    M.target = null;
    M.revealed = null;
    const s = homeScale();
    M.cam = { s, x: (vw() - M.W * s) / 2, y: (vh() - M.H * s) / 2 };
    clampCam();
    apply(animate);
  }
  function flyToNode(n, animate = true) {
    M.target = n;
    M.revealed = n;
    focused = n;
    const readableScale = (desired) => Math.min(desired, (vw() - 24) / n.w);
    if (n.kind === "root") return fly(n.x, n.y, n.w, n.h, 0.6, 40, animate);
    if (n.kind === "station") return fly(n.column.x, n.y - 60, n.column.w, n.column.h + 60, 0.62, 40, animate);
    if (n.kind === "moment") return fly(n.x, n.y - 40, n.w, (n.bottom ?? n.y + n.h) - n.y + 40, readableScale(1.2), 12, animate);
    if (n.kind === "action") return fly(n.x, n.y, n.w, n.h, readableScale(n.children.length ? 2.5 : 1.3), 12, animate);
    if (n.kind === "custody") return fly(n.x, n.y, n.w, n.h, 1.3, 40, animate);
    if (n.kind === "lab") return fly(n.x, n.y, n.w, n.h, readableScale(1.2), 12, animate);
    return fly(n.x, n.y, n.w, n.h, readableScale(DETAIL_SCALE), 12, animate);
  }
  const flyTo = (id, animate = true) => { const n = M.tree.byId.get(id); if (n) flyToNode(n, animate); return !!n; };

  // Where are we? Derived from the world point under the viewport centre.
  function here() {
    const { cam, tree } = M;
    const cx = (vw() / 2 - cam.x) / cam.s, cy = (vh() / 2 - cam.y) / cam.s;
    const hit = (n) => cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h;
    const path = [];
    // At (or below) the whole-map fit scale, no single station is "current" —
    // gate on homeScale() itself rather than a fixed constant, since the fit
    // scale depends on how much content there is. The tolerance is relative
    // (not a fixed epsilon): homeScale() is a few hundredths on the real map,
    // so a fixed 1e-6 absolute margin is meaningless noise either way, but a
    // relative margin scales with whatever the fit scale actually is.
    if (cam.s <= homeScale() * (1 + 1e-6)) return path;
    // Explicit navigation names the selected card, even if a narrow viewport
    // frames its header above the centre. Gestures release this selection.
    if (M.target) {
      for (let node = M.target; node; node = node.parent) path.unshift(node);
      return path;
    }
    const station = tree.nodes.find((n) => n.kind === "station" && cx >= n.column.x && cx < n.column.x + n.column.w && cy >= n.y - 80 && cy <= n.y + n.column.h + 80);
    if (!station) {
      // Not over any station: the root (the apex above the whole timeline) is
      // the one other thing that can be "current" between the fit view and a
      // station. It has no children of its own, so an exact hit test is enough.
      const root = tree.nodes.find((n) => n.kind === "root" && hit(n));
      if (root) path.push(root);
      return path;
    }
    path.push(station);
    const moment = station.children.find((n) => n.kind === "moment" && cx >= n.x - G.gap / 2 && cx < n.x + n.w + G.gap / 2 && cy >= n.y - 60);
    if (!moment || cam.s < 0.9) return path;
    path.push(moment);
    const action = moment.children.find((n) => n.kind === "action" && hit(n));
    if (!action || cam.s < 1.6) return path;
    path.push(action);
    const tile = action.children.find((n) => hit(n));
    if (tile && cam.s >= 2.6) path.push(tile);
    return path;
  }
  const crumbLabel = (n) => (n.kind === "action" && n.actor ? `${ACTOR_NAMES[n.actor]}: ${n.label}` : n.label);
  function paintPath() {
    const crumbs = $("#crumbs");
    if (!crumbs) return;
    const path = here();
    const items = [{ key: "home", label: "Whole map" }, ...path.map((n) => ({ key: n.id, label: crumbLabel(n) }))];
    // Patch existing buttons in place instead of rebuilding innerHTML: apply()
    // repaints the crumbs on every camera move, including the one a crumb
    // click itself just caused, so tearing down and recreating every button
    // would drop focus to <body> the instant the reader activates one. Only
    // the tail grows or shrinks; buttons that survive are relabelled in
    // place, never removed and recreated.
    const buttons = $$("#crumbs > button");
    while (buttons.length > items.length) {
      crumbs.removeChild(crumbs.lastElementChild); // trailing button
      crumbs.removeChild(crumbs.lastElementChild); // its separator
      buttons.pop();
    }
    while (buttons.length < items.length) {
      if (buttons.length) crumbs.append(Object.assign(document.createElement("i"), { textContent: "›" }));
      const btn = document.createElement("button");
      btn.type = "button";
      crumbs.append(btn);
      buttons.push(btn);
    }
    items.forEach((item, i) => {
      const btn = buttons[i];
      if (item.key === "home") { if (!("home" in btn.dataset)) btn.dataset.home = ""; delete btn.dataset.fly; }
      else { if (btn.dataset.fly !== item.key) btn.dataset.fly = item.key; delete btn.dataset.home; }
      if (btn.textContent !== item.label) btn.textContent = item.label;
      if (i === items.length - 1) btn.setAttribute("aria-current", "location");
      else btn.removeAttribute("aria-current");
    });
    paintZoom();
  }
  function paintZoom() {
    if (document.body.dataset.mode === "guide") return;
    const level = $("#zoom-level"), scale = M.cam.s;
    if (level) level[level.tagName === "INPUT" ? "value" : "textContent"] = `${Math.round(scale * 100)}%`;
  }
  function zoomOut() {
    const path = here();
    if (path.length < 2) {
      // Stepping out of a bare station reaches the root (the level above every
      // station), not the whole-map fit view directly — the root itself steps
      // out to the fit view, same as before roots existed.
      if (path.length === 1 && path[0].kind !== "root") {
        const root = M.tree.nodes.find((n) => n.kind === "root");
        if (root) return flyToNode(root);
      }
      return home();
    }
    flyToNode(path[path.length - 2]);
  }
  // A gesture takes over the picture currently on screen, not the stored
  // destination of a CSS camera flight that may still be in progress.
  function interruptMotion() {
    if (!M.worldEl.getAnimations().some((animation) => animation.transitionProperty === "transform" && animation.playState === "running")) return;
    const matrix = new DOMMatrix(getComputedStyle(M.worldEl).transform);
    M.cam = { x: matrix.e, y: matrix.f, s: matrix.a };
    M.worldEl.style.transition = "none";
    M.worldEl.style.transform = `translate(${matrix.e}px, ${matrix.f}px) scale(${matrix.a})`;
  }
  function zoomTo(scale) {
    if (!Number.isFinite(scale) || scale <= 0) return paintZoom();
    interruptMotion();
    M.target = null;
    const { cam } = M, px = vw() / 2, py = vh() / 2;
    const ns = clamp(scale, homeScale(), MAX);
    cam.x = px - (px - cam.x) * (ns / cam.s);
    cam.y = py - (py - cam.y) * (ns / cam.s);
    cam.s = ns;
    clampCam();
    apply(false);
  }
  function zoomBy(f) {
    interruptMotion();
    zoomTo(M.cam.s * f);
  }

  /* ---------- Input ---------- */
  // Active touch pointers, keyed by pointerId, holding each finger's latest
  // PointerEvent. Shared between wireInput (single-pointer drag) and wireTouch
  // (two-finger pinch) so a second finger touching down is never mistaken for
  // a continuation of a one-finger drag: a drag only ever follows the pointer
  // that started it, and stops the moment a second touch pointer joins.
  const touchPts = new Map();
  function wireInput() {
    const { mapEl } = M;
    mapEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      interruptMotion();
      M.target = null;
      const r = mapEl.getBoundingClientRect(), { cam } = M;
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? vh() : 1;
      if (!e.ctrlKey && !e.metaKey) {
        cam.x -= e.deltaX * unit;
        cam.y -= e.deltaY * unit;
        clampCam();
        apply(false);
        return;
      }
      // Keep fine input gentle and cap coarse mouse-wheel notches.
      const zoomDelta = clamp(-e.deltaY * unit * 0.002, -0.1, 0.1);
      const ns = clamp(cam.s * Math.exp(zoomDelta), homeScale(), MAX);
      cam.x = px - (px - cam.x) * (ns / cam.s);
      cam.y = py - (py - cam.y) * (ns / cam.s);
      cam.s = ns;
      clampCam();
      apply(false);
      document.body.classList.add("touched");
    }, { passive: false });
    let drag = null, swallowClick = false;
    mapEl.addEventListener("pointerdown", (e) => {
      interruptMotion();
      if (e.pointerType === "touch") {
        touchPts.set(e.pointerId, e);
        // A second finger starts a pinch, not a drag: drop any drag in
        // progress (and its "dragging" class) without swallowing the next click.
        if (touchPts.size > 1) { drag = null; mapEl.classList.remove("dragging"); return; }
      }
      if (e.button !== 0 || e.target.closest("input, a, select, button, label")) return;
      drag = { x: e.clientX, y: e.clientY, cx: M.cam.x, cy: M.cam.y, moved: false, id: e.pointerId };
    });
    mapEl.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") touchPts.set(e.pointerId, e);
      if (!drag || e.pointerId !== drag.id || touchPts.size > 1) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      if (!drag.moved) mapEl.setPointerCapture(drag.id); // capture only once it is really a drag, so plain clicks keep their target
      drag.moved = true;
      M.target = null;
      mapEl.classList.add("dragging");
      M.cam.x = drag.cx + dx; M.cam.y = drag.cy + dy;
      clampCam();
      apply(false);
    });
    const endDrag = (e) => {
      if (e.pointerType === "touch") touchPts.delete(e.pointerId);
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.moved) { swallowClick = true; document.body.classList.add("touched"); }
      drag = null; mapEl.classList.remove("dragging");
    };
    mapEl.addEventListener("pointerup", endDrag);
    mapEl.addEventListener("pointercancel", endDrag);
    mapEl.addEventListener("click", (e) => {
      if (swallowClick) { swallowClick = false; return; }
      if (e.target.closest("input, a, select, button, label, .lab-host")) return;
      const card = e.target.closest(".card");
      if (!card) return;
      const node = M.tree.byId.get(card.dataset.id);
      const path = here();
      if (path[path.length - 1] === node && node.kind !== "station") return zoomOut();
      flyToNode(node);
      document.body.classList.add("touched");
    });
    document.addEventListener("click", (e) => {
      if (document.body.dataset.mode === "guide") return;
      const b = e.target.closest("[data-fly], [data-home], [data-zoom], [data-reset-zoom]");
      if (!b) return;
      if (b.dataset.home !== undefined) home();
      else if (b.dataset.fly !== undefined) flyTo(b.dataset.fly);
      else if (b.dataset.resetZoom !== undefined) zoomTo(1);
      else zoomBy(b.dataset.zoom === "+" ? ZOOM_STEP : 1 / ZOOM_STEP);
    });
    const level = $("#zoom-level");
    level?.addEventListener("change", () => {
      if (document.body.dataset.mode !== "guide") zoomTo(Number(level.value.trim().replace(/%$/, "")) / 100);
    });
    level?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); level.blur(); }
      if (e.key === "Escape" && document.body.dataset.mode !== "guide") { paintZoom(); level.blur(); }
    });
    document.addEventListener("keydown", (e) => {
      // The app shell (shell.js) marks body[data-mode="guide"] while the
      // Guide view is showing. #map is inert then, which already stops
      // clicks and keydowns targeted at it, but this listener is on
      // document, so a key pressed while focus sits on shell chrome (e.g.
      // the mode toggle itself) would otherwise still reach the camera.
      if (document.body.dataset.mode === "guide" || e.altKey) return;
      if (e.metaKey || e.ctrlKey) {
        if (["+", "=", "-", "0"].includes(e.key)) {
          e.preventDefault(); // One zoom owner: never scale the browser and map together.
          if (e.key === "0") zoomTo(1);
          else zoomBy(e.key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP);
        }
        return;
      }
      if (e.target.closest("input, textarea, select")) return;
      if (e.key === "Escape") zoomOut();
      if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
      if (e.key === "-") zoomBy(1 / ZOOM_STEP);
      if (e.key === "0") home();
    });
    // R9: at the whole-map view, resizing re-fits; otherwise it clamps and
    // keeps the camera in place rather than moving the reader's viewpoint.
    // Uses M.atHome (set by the last apply(), before the viewport changed)
    // rather than recomputing here() here: by the time this handler runs the
    // browser has already resized #map, so a live here() would compare the
    // OLD cam.s against the NEW homeScale() and wrongly conclude we had
    // navigated away from home.
    addEventListener("resize", () => {
      if (M.atHome) return home(false);
      clampCam();
      apply(false);
    });
  }

  /* ---------- Hash and aliases ---------- */
  // Compatibility with the former reference-heavy map and classic Guide anchors.
  const ALIASES = {
    "overview": "before-the-vault",
    "participants": "who-is-around-a-vault",
    "execution-permissions": "executor-and-recipient",
    "admission-pause": "admission-pause-action",
    "lifecycle": "open",
    "token-roles-and-collateral": "token-roles",
    "admission-pause-and-stalled-auctions": "admission-pause-action",
    "makers": "market-makers-sign-bids-off-chain",
    "prepare-fund-and-activate": "sign-a-bid",
    "platform-fees": "buyer-has-paid-the-premium",
    "premium-treatment": "claim-premium",
    "platform-fee-and-share-transfer-administration": "claim-premium",
    "outcomes": "exercise",
    "exercise-and-expiration": "buyer-may-now-exercise",
    "exercise-windows": "exercise",
    "cash-settlement": "cash-the-vault-needs-a-price",
    "cash-availability": "cash-the-vault-needs-a-price",
    "expiry-price": "cash-the-vault-needs-a-price",
    "cash-exercise-windows": "cash-the-vault-needs-a-price",
    "cash-missing-reports": "missing-report",
    "reports-exercise-and-expiration": "cash-the-vault-needs-a-price",
    "enable-cash-after-physical-launch": "cash-the-vault-needs-a-price",
    "early-exit": "agreed-unwind",
    "unwind-recovery": "agreed-unwind",
    "prepare-and-execute-a-unanimous-unwind": "agreed-unwind",
    "worked-unwind-scenarios": "agreed-unwind",
    "cash-outcomes": "claim-payout",
    "premium-treatment-and-emergency-boundaries": "settled",
    "terms": "set-the-terms",
    "authoritative-cash-settlement-pricing": "cash-the-vault-needs-a-price",
    "owner-sets-the-terms": "who-is-around-a-vault",
    "lp-supplies-collateral": "who-is-around-a-vault",
    "market-maker-buys-the-option": "who-is-around-a-vault",
    "bid-master-selects": "who-is-around-a-vault",
    "protocol-administrator": "who-is-around-a-vault",
    "hub-holds-nothing": "hub-and-vaults",
    "approvals-target-the-vault": "hub-and-vaults",
    "pull-and-push": "hub-and-vaults",
    "deposit-routes": "hub-and-vaults",
    "who-may-act-for-the-buyer": "executor-and-recipient",
    "executor": "executor-and-recipient",
    "recipient": "executor-and-recipient",
    "only-the-buyer-changes-them": "executor-and-recipient",
    "swap-adapter-not-implemented": "executor-and-recipient",
    "what-a-pause-means": "admission-pause-action",
    "what-a-pause-blocks": "admission-pause-action",
    "what-a-pause-never-stops": "admission-pause-action",
    "deadlines-do-not-move": "admission-pause-action",
    "how-to-pause": "admission-pause-action",
    "open-custody": "hub-and-vaults",
    "calls-and-puts-pairs": "set-the-terms",
    "settlement-choice": "set-the-terms",
    "every-term": "set-the-terms",
    "owner-fixes-what-bids-may-propose": "set-the-terms",
    "price-limits": "set-the-terms",
    "strike-limit": "set-the-terms",
    "min-premium": "set-the-terms",
    "price-feed-and-max-in-the-money": "set-the-terms",
    "max-price-age": "set-the-terms",
    "max-settlement-price-age": "set-the-terms",
    "timing-and-exercise-rules": "set-the-terms",
    "min-collateral": "set-the-terms",
    "expiry": "set-the-terms",
    "allowed-exercise": "set-the-terms",
    "partial-exercise": "set-the-terms",
    "auction-starts-at": "set-the-terms",
    "tokens-and-pairs": "set-the-terms",
    "vault-token-choices": "set-the-terms",
    "allowed-settlement": "set-the-terms",
    "public-deposits-underlying-collateral": "set-the-terms",
    "who-may-deposit": "add-funds",
    "shares": "add-funds",
    "approve-then-deposit": "add-funds",
    "owner-may-tighten-the-terms": "set-the-terms",
    "tighten-terms": "set-the-terms",
    "hand-over-ownership": "set-the-terms",
    "opening-conditions": "open-or-schedule",
    "anyone-may-open-on-schedule": "open-or-schedule",
    "auction-custody": "lp-waits",
    "auction-opens-and-terms-lock": "lp-waits",
    "eip-712-domain": "sign-a-bid",
    "fields-auction-and-buyer": "sign-a-bid",
    "fields-tokens-and-price": "sign-a-bid",
    "fields-timing-and-rules": "sign-a-bid",
    "fields-use-and-execution": "sign-a-bid",
    "approve-the-premium": "sign-a-bid",
    "market-maker-role": "sign-a-bid",
    "cancel-a-bid": "sign-a-bid",
    "activation-checks-pass": "activate",
    "activation-checks-fail": "activate",
    "indicative-price-check": "activate",
    "inspect-then-activate": "activate",
    "cancel-after-timeout": "if-cancelled-back-to-open",
    "the-auction-timeout": "if-cancelled-back-to-open",
    "after-cancellation": "if-cancelled-back-to-open",
    "live-custody": "claim-premium",
    "worked-fee-example": "claim-premium",
    "earned-payments": "claim-premium",
    "fee-formula": "claim-premium",
    "rate-authority": "claim-premium",
    "treasury-authority": "claim-premium",
    "transfers-carry-unpaid-premium": "claim-premium",
    "fee-lab": "claim-premium",
    "nothing-to-do": "buyer-has-paid-the-premium",
    "done": "buyer-has-paid-the-premium",
    "when-it-is-allowed": "exercise",
    "who-may-call": "exercise",
    "what-changes-hands": "exercise",
    "call-or-put": "exercise",
    "part-or-all": "exercise",
    "partial-then-full": "exercise",
    "cash-settled": "exercise",
    "outcomes-lab": "exercise",
    "how-to-read-yield": "exercise",
    "exercise-assumption": "exercise",
    "rounding": "exercise",
    "income-is-not-total-return": "exercise",
    "agreed-unwind-pointer": "buyer-may-now-exercise",
    "enable-cash": "cash-the-vault-needs-a-price",
    "two-separate-controls": "cash-the-vault-needs-a-price",
    "when-disabled": "cash-the-vault-needs-a-price",
    "existing-obligations": "cash-the-vault-needs-a-price",
    "enable-procedure": "cash-the-vault-needs-a-price",
    "physical-only-launch-and-later-cash-activation": "cash-the-vault-needs-a-price",
    "publish-a-price": "cash-the-vault-needs-a-price",
    "exercise-observation": "cash-the-vault-needs-a-price",
    "final-expiry-price": "cash-the-vault-needs-a-price",
    "one-vault-per-report": "cash-the-vault-needs-a-price",
    "units-and-authority": "cash-the-vault-needs-a-price",
    "irreversible": "cash-the-vault-needs-a-price",
    "payment-authority-and-routing": "cash-the-vault-needs-a-price",
    "cash-exercise": "cash-the-vault-needs-a-price",
    "cash-windows": "cash-the-vault-needs-a-price",
    "zero-payout-rejected": "cash-the-vault-needs-a-price",
    "paid-from-collateral": "cash-the-vault-needs-a-price",
    "what-is-blocked": "missing-report",
    "still-available": "missing-report",
    "how-recovery-works": "missing-report",
    "failure-and-incident-procedure": "missing-report",
    "cash-settlement-interface-and-governance": "cash-the-vault-needs-a-price",
    "public-interface": "cash-the-vault-needs-a-price",
    "settlement-interface-code": "cash-the-vault-needs-a-price",
    "rejected-callers": "cash-the-vault-needs-a-price",
    "each-vault-stands-alone": "cash-the-vault-needs-a-price",
    "interchangeable-publishers": "cash-the-vault-needs-a-price",
    "hub-never-reads-the-helper": "cash-the-vault-needs-a-price",
    "an-example-helper-ships": "cash-the-vault-needs-a-price",
    "exercise-observations": "cash-the-vault-needs-a-price",
    "equal-timestamp-different-price": "cash-the-vault-needs-a-price",
    "exercise-consumption-check": "cash-the-vault-needs-a-price",
    "no-other-vaults-report-counts": "cash-the-vault-needs-a-price",
    "affects-only-later-exercises": "cash-the-vault-needs-a-price",
    "exact-expiry-and-finality": "cash-the-vault-needs-a-price",
    "final-prices-stay-readable": "cash-the-vault-needs-a-price",
    "late-publication-is-allowed": "cash-the-vault-needs-a-price",
    "never-substitute-a-price": "cash-the-vault-needs-a-price",
    "price-methodology-and-operational-approval": "cash-the-vault-needs-a-price",
    "contracts-attest-not-verify": "cash-the-vault-needs-a-price",
    "record-before-enabling-production": "cash-the-vault-needs-a-price",
    "physical-needs-none-of-it": "cash-the-vault-needs-a-price",
    "what-production-still-needs": "cash-the-vault-needs-a-price",
    "governance-rotation-and-trust": "cash-the-vault-needs-a-price",
    "no-outstanding-signatures": "cash-the-vault-needs-a-price",
    "stored-data-survives-revocation": "cash-the-vault-needs-a-price",
    "trust-for-the-life-of-the-position": "cash-the-vault-needs-a-price",
    "losing-admin-vs-publisher-keys": "cash-the-vault-needs-a-price",
    "deployment-and-tooling-notes": "cash-the-vault-needs-a-price",
    "manifest-v6-only": "cash-the-vault-needs-a-price",
    "a-default-deployment-is-empty": "cash-the-vault-needs-a-price",
    "distinct-request-shapes": "cash-the-vault-needs-a-price",
    "expiry-date-arrives": "expire-the-vault",
    "keep-exercising": "expire-the-vault",
    "publish-the-final-price": "expire-the-vault",
    "the-exact-second": "expire-the-vault",
    "grace-window-closes": "expire-the-vault",
    "who-may-expire": "expire-the-vault",
    "physical-expiration": "expire-the-vault",
    "cash-expiration": "expire-the-vault",
    "expiration-result": "expire-the-vault",
    "no-grace-for-cash": "expire-the-vault",
    "too-late": "expire-the-vault",
    "ending-early-by-agreement": "agreed-unwind",
    "four-steps": "agreed-unwind",
    "what-the-proposal-records": "agreed-unwind",
    "consent-changes": "agreed-unwind",
    "new-agreement": "agreed-unwind",
    "while-pending": "agreed-unwind",
    "funding": "agreed-unwind",
    "recover-before-execution": "agreed-unwind",
    "original-funder": "agreed-unwind",
    "recover-after-execution": "agreed-unwind",
    "execute-unwind": "agreed-unwind",
    "worked-scenarios": "agreed-unwind",
    "consent-lab": "agreed-unwind",
    "settled-custody": "claim",
    "the-option-is-over": "settled",
    "nothing-moves-by-itself": "settled",
    "claims-require-transactions": "settled",
    "a-different-token-mix": "settled",
    "premium-and-fees-are-kept": "settled",
    "the-only-emergency-control": "settled",
    "custody-lab": "settled",
    "proportional-claims": "claim",
    "reserves-are-excluded": "claim",
    "shares-are-burned": "claim",
    "reconciliation-getters": "claim",
    "cash-expiry-payout": "claim-payout",
    "unwind-refund-claim": "claim-payout",
    "physical-already-paid": "claim-payout",
    "pendingPayout-scope": "claim-payout",
    "what-each-side-ends-up-with": "claim",
    "outcomes-table": "claim",
    "expired-covered-call": "claim",
    "expired-cash-secured-put": "claim",
    "physical-covered-call": "claim",
    "physical-cash-secured-put": "claim",
    "worked-full-exercise": "claim",
    "cash-lab": "claim-payout",
    "call-payout-formula": "claim-payout",
    "put-payout-formula": "claim-payout",
    "worked-put-at-2700": "claim-payout",
    "historical-binding": "claim-payout",
    "payouts-round-down": "claim-payout"
  };
  const resolveHash = (hash) => { const id = decodeURIComponent((hash || "").replace(/^#/, "")); if (!id) return null; return M.tree.byId.get(id) || M.tree.byId.get(ALIASES[id]) || null; };
  let settingHash = false;
  function syncHash() {
    if (document.body.dataset.mode === "guide") return;
    const path = here();
    const id = path.length ? path[path.length - 1].id : "";
    if (location.hash.replace(/^#/, "") === id) return;
    settingHash = true;
    history.replaceState(null, "", id ? `#${id}` : location.pathname + location.search);
    settingHash = false;
  }
  function followHash(animate) {
    if (settingHash || document.body.dataset.mode === "guide") return;
    const n = resolveHash(location.hash);
    if (n) return flyToNode(n, animate);
    // A hash that names real page chrome (e.g. the "#map" the skip link
    // targets, or "#toolbar"/"#document") isn't a content node, but it isn't
    // nothing either: the browser already put it there on purpose. Treat it
    // as a navigation no-op and leave the camera exactly where it was, rather
    // than yanking a zoomed-in reader back to the whole map. Detected by rule
    // (an element with that id exists, just not a content node) rather than a
    // hard-coded id list, so any future page-chrome id is covered for free.
    const id = decodeURIComponent((location.hash || "").replace(/^#/, ""));
    if (id && document.getElementById(id)) return;
    // An empty hash and a hash matching nothing at all both land on the whole
    // map: falling through to home() unconditionally (instead of only for ""
    // and "#") means a stale or mistyped anchor still shows the reader
    // something, rather than leaving every card unshown because apply() never ran.
    home(animate);
  }

  /* ---------- Search ---------- */
  const textOf = (n) => `${n.label} ${n.when} ${n.tagline} ${n.summary} ${[...n.source.children].filter((el) => el.tagName !== "SECTION").map((el) => el.textContent).join(" ")}`.replace(/\s+/g, " ").toLowerCase();
  function search(query) {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const scored = M.tree.nodes.map((n) => {
      const label = n.label.toLowerCase(), text = textOf(n);
      const score = label === q ? 4 : label.includes(q) ? 3 : n.summary.toLowerCase().includes(q) ? 2 : text.includes(q) ? 1 : 0;
      return { node: n, score };
    }).filter((h) => h.score).sort((a, b) => b.score - a.score || a.node.depth - b.node.depth);
    return scored.slice(0, 8).map((h) => ({ node: h.node, path: pathLabels(h.node) }));
  }
  const pathLabels = (n) => { const out = []; for (let p = n.parent; p; p = p.parent) out.unshift(p.label); return out; };
  function wireSearch() {
    const input = $("#search-input"), list = $("#search-results");
    if (!input || !list) return;
    let hits = [];
    const paint = () => {
      hits = search(input.value);
      list.hidden = !hits.length;
      list.innerHTML = hits.map((h, i) => `<li><button type="button" data-hit="${i}">${esc(h.node.label)}<small>${esc(h.path.join(" › "))}</small></button></li>`).join("");
    };
    input.addEventListener("input", paint);
    input.addEventListener("focus", paint);
    input.closest("form").addEventListener("submit", (e) => { e.preventDefault(); if (hits[0]) go(hits[0]); });
    list.addEventListener("click", (e) => { const b = e.target.closest("[data-hit]"); if (b) go(hits[+b.dataset.hit]); });
    document.addEventListener("click", (e) => { if (!e.target.closest("#search")) list.hidden = true; });
    function go(hit) { list.hidden = true; input.blur(); flyToNode(hit.node); focusCard(hit.node); }
  }

  /* ---------- Keyboard navigation between cards ---------- */
  let focused = null;
  function focusCard(n) { focused = n; n.el.focus({ preventScroll: true }); }
  function wireKeys() {
    const mapEl = M.mapEl;
    let pointerDown = false;
    mapEl.addEventListener("pointerdown", () => { pointerDown = true; }, true);
    const releasePointer = () => { pointerDown = false; };
    addEventListener("pointerup", releasePointer, true);
    addEventListener("pointercancel", releasePointer, true);
    addEventListener("blur", releasePointer);
    mapEl.addEventListener("keydown", (e) => {
      if (e.target.closest("input, select, textarea, button, a")) return;
      const path = here();
      const current = focused && M.tree.byId.get(focused.id) ? focused : path[path.length - 1] || null;
      const siblings = (n) => (n.parent ? n.parent.children : M.tree.nodes.filter((s) => s.kind === "station" && s.band === n.band));
      let next = null;
      if (e.key === "Home") next = M.tree.nodes.find((s) => s.kind === "station");
      else if (!current) { if (e.key.startsWith("Arrow")) next = M.tree.nodes.find((s) => s.kind === "station"); }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const list = siblings(current), i = list.indexOf(current);
        next = list[(i + (e.key === "ArrowRight" ? 1 : list.length - 1)) % list.length];
      } else if (e.key === "ArrowDown") next = current.children.find((c) => c.kind !== "custody") || current.children[0] || null;
      else if (e.key === "ArrowUp") next = current.parent;
      else if (e.key === "Enter" && current) { e.preventDefault(); flyToNode(current); focusCard(current); return; }
      if (!next) return;
      e.preventDefault();
      flyToNode(next);
      focusCard(next);
    });
    mapEl.addEventListener("focusin", (e) => {
      const card = e.target.closest(".card");
      if (!card) return;
      const node = M.tree.byId.get(card.dataset.id);
      focused = node;
      // Tabbing to a card's native controls must use the camera, not an
      // independent scroll offset in the overflow-hidden canvas.
      mapEl.scrollTo(0, 0);
      if (!pointerDown && M.target !== node) flyToNode(node, false);
    });
  }

  /* ---------- Touch: one finger pans (via wireInput's pointer handlers), two fingers pinch ---------- */
  function wireTouch() {
    // touchPts (shared with wireInput) already tracks each finger's latest
    // event and drops a drag as soon as a second finger joins, so this only
    // has to read it — no separate pointer bookkeeping to fight over.
    const mapEl = M.mapEl;
    let pinch = null;
    mapEl.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "touch" || touchPts.size !== 2) return;
      const [a, b] = [...touchPts.values()];
      const r = mapEl.getBoundingClientRect();
      const mid = { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top };
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      if (!pinch) { pinch = { dist, s: M.cam.s }; return; }
      const { cam } = M;
      M.target = null;
      const ns = clamp(pinch.s * (dist / pinch.dist), homeScale(), MAX);
      cam.x = mid.x - (mid.x - cam.x) * (ns / cam.s);
      cam.y = mid.y - (mid.y - cam.y) * (ns / cam.s);
      cam.s = ns;
      clampCam();
      apply(false);
    });
    const lift = () => { if (touchPts.size < 2) pinch = null; };
    mapEl.addEventListener("pointerup", lift);
    mapEl.addEventListener("pointercancel", lift);
  }

  /* ---------- Theme ---------- */
  function wireChrome() {
    const theme = $("#themeToggle"), root = document.documentElement;
    if (theme) {
      const label = () => (theme.textContent = `Theme · ${root.dataset.theme}`);
      theme.addEventListener("click", () => { root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"; try { localStorage.setItem("ivy-theme", root.dataset.theme); } catch (_) {} label(); M.mapEl.dispatchEvent(new CustomEvent("map:theme")); });
      label();
    }
  }

  const state = () => ({ scale: M.cam.s, lod: currentLod, path: here().map((n) => n.id) });

  function boot() {
    document.fonts.ready.then(() => { window.IvyMap.mounted = mount(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.IvyMap = { readDocument, layoutWorld, render, setLod, lodOf, GEOMETRY: G, state, flyTo, home, zoomOut, zoomBy, zoomTo, paintZoom, here, _cam: () => ({ ...M.cam }), ALIASES, search, resolveHash };
})();
