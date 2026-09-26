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
    station: [480, 200], moment: [460, 170], action: [500, 150], custody: [360, 170], root: [720, 340],
    lab: [420, 100], gap: 100, tile: 460, tileGap: 32, columnPad: 100, bandGap: 180, rootGap: 180,
  };
  // Wider reading surfaces on desktop; reflow the text rather than shrink it on phones.
  const verticalBranches = () => innerWidth < 1120;
  const widthOf = (n) => Math.min(Array.isArray(G[n.kind]) ? G[n.kind][0] : G.tile, Math.max(296, innerWidth - 24));

  // Each stage is a tree. Siblings share a stem, never a false action-to-action
  // chain. Recursive subtree bounds allow any number of children at any depth.
  function layoutWorld(nodes, measure, expanded = null) {
    const lines = [], vertical = expanded !== null && verticalBranches();
    for (const n of nodes) {
      n.visible = (!n.parent || n.parent.visible) && (!expanded || !n.parent || expanded.has(n.id));
      n.x ??= 0; n.y ??= 0;
    }
    const childrenOf = n => n.children.filter(c => c.visible);
    const root = nodes.find((n) => n.kind === "root");
    const rootHeight = root ? Math.max(G.root[1], measure(root)) : 0;
    const size = (n) => {
      const preset = Array.isArray(G[n.kind]) ? G[n.kind] : null;
      n.w = widthOf(n);
      n.h = Math.max(preset ? preset[1] : 100, measure(n));
      if (n.kind === "action") n.headerH = n.h;
      n.children.forEach(size);
      const children = childrenOf(n);
      const childW = Math.max(0, ...children.map(c => c.treeW));
      const childH = children.reduce((h, c) => h + c.treeH, 0) + Math.max(0, children.length - 1) * G.tileGap;
      n.treeW = vertical ? Math.max(n.w, childW) : n.w + (children.length ? G.gap + childW : 0);
      n.treeH = vertical ? n.h + (children.length ? G.gap + childH : 0) : Math.max(n.h, childH);
    };
    const branch = (parent, child, stemX) => {
      if (vertical) {
        const x = parent.x + parent.w / 2, y = parent.y + parent.h, sy = child.y + child.h / 2;
        lines.push({kind: "branch", from: parent.id, to: child.id,
          d: `M ${x} ${y} C ${x} ${y + 42}, ${parent.x - 24} ${y + 18}, ${parent.x - 24} ${y + 60} L ${parent.x - 24} ${sy - 24} Q ${parent.x - 24} ${sy} ${child.x} ${sy}`,
          leafX: child.x - 8, leafY: sy, depth: child.depth});
        return;
      }
      const x = parent.x + parent.w, y = parent.y + parent.h / 2;
      const endY = child.y + child.h / 2;
      lines.push({ kind: "branch", from: parent.id, to: child.id,
        d: `M ${x} ${y} C ${stemX} ${y}, ${stemX} ${endY}, ${child.x} ${endY}`,
        leafX: child.x - 18, leafY: endY, depth: child.depth });
    };
    const place = (n, x, y) => {
      Object.assign(n, { x, y });
      let cursor = vertical ? y + n.h + G.gap : y;
      childrenOf(n).forEach(c => {
        place(c, vertical ? x : x + n.w + G.gap, cursor);
        branch(n, c, x + n.w + G.gap / 2);
        cursor += c.treeH + G.tileGap;
      });
      n.bottom = y + n.treeH;
    };
    const layoutBand = (band, y) => {
      let x = G.columnPad, bottom = y;
      nodes.filter(n => n.kind === "station" && n.band === band).forEach(st => {
        st.children.forEach(size);
        const stationWidth = widthOf(st);
        const w = Math.max(stationWidth, ...childrenOf(st).map(c => c.treeW));
        Object.assign(st, { x: x + (w - stationWidth) / 2, y, w: stationWidth, h: Math.max(G.station[1], measure(st)) });
        let cursor = y + st.h + G.gap;
        childrenOf(st).forEach(c => {
          place(c, x + 36, cursor);
          const stemX = x + 12, sy = st.y + st.h;
          lines.push({ kind: "bough", from: st.id, to: c.id,
            d: `M ${st.x + st.w / 2} ${sy} C ${st.x + st.w / 2} ${sy + 32}, ${stemX} ${sy + 24}, ${stemX} ${sy + 64} L ${stemX} ${c.y + c.h / 2 - 24} Q ${stemX} ${c.y + c.h / 2} ${c.x} ${c.y + c.h / 2}` });
          cursor += c.treeH + G.gap;
        });
        st.column = { x, w: w + 72, h: Math.max(st.h, cursor - y - G.gap) };
        st.bottom = y + st.column.h;
        bottom = Math.max(bottom, st.bottom);
        x += st.column.w + G.columnPad;
      });
      return { width: x, bottom };
    };
    const life = layoutBand("life", root ? rootHeight + G.rootGap : 0);
    const shelf = layoutBand("shelf", life.bottom + G.bandGap);
    const width = Math.max(life.width, shelf.width);
    if (root) {
      Object.assign(root, { x: life.width / 2 - widthOf(root) / 2, y: 0, w: widthOf(root), h: rootHeight });
      nodes.filter(n => n.kind === "station").forEach(st => {
        const sx = root.x + root.w / 2, sy = root.h, tx = st.x + st.w / 2;
        lines.push({ kind: "trunk", from: root.id, to: st.id,
          d: `M ${sx} ${sy} C ${sx} ${sy + 100}, ${tx} ${st.y - 100}, ${tx} ${st.y}` });
      });
    }
    return { width, height: Math.max(life.bottom, shelf.bottom) + 80, lines };
  }

  /* ---------- Cast ---------- */
  const CROPS = { owner: "24 76 477 580", lp: "504 76 425 580", buyer: "931 76 461 580", bid: "1394 76 533 580" };
  const ACTOR_NAMES = { owner: "Owner", lp: "LP", buyer: "Buyer", bid: "Bid master", anyone: "Anyone", publisher: "Price publisher", admin: "Admin", guardian: "Guardian", all: "All parties" };
  const GLYPHS = { anyone: "?", publisher: "$", admin: "A", guardian: "G", all: "∀" };
  let clipSeq = 0;
  function portrait(key) {
    if (key === "bid") {
      return `<span class="portrait"><svg viewBox="0 0 1219 1290" aria-hidden="true" focusable="false"><image href="${ASSET_BASE}roman-bid-master.png" width="1219" height="1290"/></svg></span>`;
    }
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
    const layers = contentLayers(n);
    if (n.children.length && n.kind !== "root") {
      const tier = Math.max(...Object.keys(layers).map(Number));
      layers[tier] += `<nav class="branch-links" aria-label="Branches of ${esc(n.label)}">${n.children.map(c => `<button type="button" data-expand="${c.id}" aria-expanded="false" aria-controls="map-card-${c.id}"><span>${esc(c.label)}</span><span class="branch-mark" aria-hidden="true">+</span></button>`).join("")}</nav>`;
    }
    if (n.parent) {
      const tier = Math.max(...Object.keys(layers).map(Number));
      layers[tier] += `<button type="button" class="fold-branch" data-fold="${n.id}" aria-label="Fold ${esc(n.label)} branch" title="Fold this branch">−</button>`;
    }
    return layers;
  }
  function contentLayers(n) {
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
        const more = "";
        const layers = { 0: head || `<h4>${t}</h4>`, 1: `${head}<h4>${t}</h4>`, 2: `${head}<h4>${t}</h4><div class="action-body">${n.bodyHtml}</div>${more}` };
        return layers;
      }
      case "tile": {
        const th = n.titleHtml; // trusted markup from the authored heading, e.g. <code>strikeLimit</code>
        return { 0: `<h5>${th}</h5>`, 2: `<h5>${th}</h5><div class="body">${n.bodyHtml}</div>` };
      }
      case "lab":
        return { 0: `<i class="more" aria-hidden="true"></i>`, 2: `<h5>${t}</h5><div class="lab-host">${n.bodyHtml}</div>` };
      case "custody":
        return { 1: `<h3>${t}</h3>`, 2: `<h3>${t}</h3><div class="body">${n.bodyHtml}</div>` };
    }
  }
  const lodOf = (s) => (s < 0.55 ? 0 : s < 1.1 ? 1 : s < 2.4 ? 2 : 3);

  // Roman olive reliefs sit in a reserved header band, clear of reading text.
  function reliefFor(n) {
    const sprig = `<path class="relief-stem" d="M 150 34 Q 128 32 106 12"/><path class="relief-leaf" d="M 137 30 Q 121 30 120 20 Q 132 18 137 30 M 127 24 Q 129 10 139 9 Q 141 20 127 24 M 118 18 Q 104 21 100 11 Q 110 7 118 18 M 111 14 Q 111 2 120 2 Q 123 10 111 14"/>`;
    const crown = n.kind === "root" || n.kind === "station";
    return `<svg class="card-relief${crown ? " canopy" : ""}" viewBox="0 0 300 42" aria-hidden="true" focusable="false"><path class="relief-rule" d="M 18 24 H 84 M 216 24 H 282 M 18 20 V 28 M 282 20 V 28"/>${sprig}<g transform="translate(300 0) scale(-1 1)">${sprig}</g>${crown ? `<path class="relief-stem" d="M 150 38 V 11 M 150 25 Q 143 18 140 14 M 150 25 Q 157 18 160 14"/><path class="relief-leaf" d="M 150 17 Q 140 7 150 1 Q 160 7 150 17"/>` : `<path class="relief-seed" d="M 150 24 L 154 29 L 150 34 L 146 29 Z"/>`}</svg>`;
  }

  function branchDrawing(world) {
    const lines = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    lines.setAttribute("class", "tree-branches");
    lines.setAttribute("width", world.width);
    lines.setAttribute("height", world.height);
    lines.setAttribute("aria-hidden", "true");
    world.lines.forEach(l => lines.append(edgeElement(l)));
    return lines;
  }

  function edgeElement(l) {
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.dataset.edge = l.to;
    g.innerHTML = `<path class="stem ${l.kind}" pathLength="1" d="${l.d}"/>${l.leafX !== undefined ? `<g class="branch-foliage" transform="translate(${l.leafX} ${l.leafY})"><path class="olive-leaf" d="M 0 0 Q -17 -25 -28 -16 Q -27 2 0 0"/><path class="olive-leaf" d="M 0 0 Q 8 -26 22 -23 Q 22 -6 0 0"/></g>` : ""}`;
    positionFoliage(g);
    return g;
  }

  function positionCard(n) {
    n.el.style.cssText = `left:${n.x}px;top:${n.y}px;width:${n.w}px;height:${n.h}px${n.headerH ? `;--header:${n.headerH}px` : ""}`;
  }

  function render(tree, world, worldEl, mapEl) {
    const lines = branchDrawing(world);
    worldEl.style.width = `${world.width}px`;
    worldEl.style.height = `${world.height}px`;
    worldEl.replaceChildren(lines);
    tree.nodes.forEach((n) => {
      const el = document.createElement("div");
      el.className = `card ${n.kind}${n.actor ? " " + n.actor : ""}${n.dim ? " dim" : ""}${n.children.length && n.kind === "action" ? " has-details" : ""}`;
      el.id = `map-card-${n.id}`;
      el.hidden = n.visible === false;
      el.inert = n.visible === false;
      el.dataset.id = n.id;
      el.dataset.kind = n.kind;
      el.tabIndex = -1;
      el.setAttribute("aria-label", n.label);
      const layers = layersFor(n);
      const watermark = n.kind === "action" && n.actor ? `<div class="watermark" aria-hidden="true">${portrait(n.actor)}</div>`
        : n.kind === "moment" && n.illustration ? `<div class="watermark painting" aria-hidden="true"><img src="${ASSET_BASE}${esc(n.illustration)}" alt="" loading="lazy" decoding="async"></div>` : "";
      el.innerHTML = reliefFor(n) + watermark + Object.entries(layers).map(([tier, html]) => `<div data-tier="${tier}"${tier === "3" && n.kind !== "tile" ? ' class="compact"' : ""}>${html}</div>`).join("");
      el.dataset.tiers = Object.keys(layers).join(",");
      n.el = el;
      positionCard(n);
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
      const selectedTier = { root: 1, station: 1, moment: 2, action: 2, lab: 2, custody: 2, tile: 2 };
      const openedDetail = M?.expanded?.has(el.dataset.id) && lod >= 1;
      const detail = el.dataset.id === target || openedDetail ? Math.max(lod, selectedTier[el.dataset.kind]) : lod;
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
      const tier = n.kind === "root" || n.kind === "station" ? 1 : 2;
      return heightOf(n, tier, widthOf(n));
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
    const expanded = new Set();
    const world = layoutWorld(tree.nodes, makeMeasurer(worldEl), expanded);
    render(tree, world, worldEl, mapEl);
    $(".probe", worldEl)?.remove();
    // Labs live in the cards now; the document keeps a placeholder so it still reads without JS.
    tree.nodes.filter((n) => n.kind === "lab").forEach((n) => { n.source.querySelectorAll(":scope > *:not(h5)").forEach((c) => c.remove()); });
    if (window.IvyLabs?.mountAll) window.IvyLabs.mountAll(worldEl);
    M = { tree, world, worldEl, mapEl, expanded, vertical: verticalBranches(), cam: { x: 0, y: 0, s: 1 }, W: world.width, H: world.height, atHome: true, target: null, revealed: null };
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
    // A compact folded tree still uses overview labels when fitted to the window.
    setLod(cam.s <= homeScale() * (1 + 1e-6) ? 0 : lodOf(cam.s), worldEl);
    // Recorded now, with the viewport size as it is at this exact moment,
    // because a "resize" event fires only after the browser has already
    // resized #map — by then vw()/vh() (and so homeScale()) already reflect
    // the NEW viewport, while cam.s is still the OLD fit scale, so comparing
    // them live in the resize handler produces false negatives. The resize
    // handler instead trusts this pre-resize snapshot (R9).
    M.atHome = here().length === 0;
    M.mapEl.classList.toggle("at-home", M.atHome);
    paintPath();
    syncHash();
    M.mapEl.dispatchEvent(new CustomEvent("map:moved"));
  }
  // Frame a world rect. minS forces at least that zoom so the next tier is readable.
  function fly(x, y, w, h, minS = 0, pad = 40, animate = true) {
    const both = Math.min(vw() / (w + pad * 2), vh() / (h + pad * 2));
    const s = clamp(Math.max(both, minS), homeScale(), DETAIL_SCALE);
    const fits = (h + pad * 2) * s <= vh();
    M.cam = { s, x: vw() / 2 - (x + w / 2) * s, y: fits ? vh() / 2 - (y + h / 2) * s : (pad - y) * s };
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
    let changed = false;
    for (let at = n; at; at = at.parent) {
      if (at.parent && !M.expanded.has(at.id)) { M.expanded.add(at.id); changed = true; }
    }
    if (changed) reflow(false);
    M.target = n;
    M.revealed = n;
    const readableScale = (desired) => Math.min(desired, (vw() - 24) / n.w);
    if (n.kind === "root") return fly(n.x, n.y, n.w, n.h, 0.6, 40, animate);
    if (n.kind === "station") return fly(n.x, n.y, n.w, n.h, readableScale(1), 12, animate);
    if (n.kind === "moment") return fly(n.x, n.y, n.w, n.h, readableScale(1.2), 12, animate);
    if (n.kind === "action") return fly(n.x, n.y, n.w, n.h, readableScale(1.3), 12, animate);
    if (n.kind === "custody") return fly(n.x, n.y, n.w, n.h, 1.3, 40, animate);
    if (n.kind === "lab") return fly(n.x, n.y, n.w, n.h, readableScale(1.2), 12, animate);
    return fly(n.x, n.y, n.w, n.h, readableScale(1.3), 12, animate);
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
    const target = [...tree.nodes].reverse().find(n => n.visible && hit(n));
    if (target) {
      path.length = 0;
      for (let node = target; node; node = node.parent) path.unshift(node);
    }
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
    const currentKey = items.at(-1).key;
    if (crumbs.dataset.current !== currentKey || Number(crumbs.dataset.width) !== crumbs.clientWidth) {
      crumbs.dataset.width = crumbs.clientWidth;
      crumbs.dataset.current = currentKey;
      crumbs.scrollLeft = crumbs.scrollWidth;
    }
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
    mapEl.addEventListener("click", e => {
      const button = e.target.closest("[data-expand], [data-fold]");
      if (!button) return;
      e.preventDefault();
      toggleBranch(M.tree.byId.get(button.dataset.expand || button.dataset.fold), e.detail !== 0);
    });
    document.addEventListener("click", (e) => {
      if (document.body.dataset.mode === "guide") return;
      const b = e.target.closest("[data-fly], [data-home], [data-zoom], [data-reset-zoom], [data-tree-expand], [data-tree-collapse]");
      if (!b) return;
      if (b.dataset.treeExpand !== undefined) setAllBranches(true);
      else if (b.dataset.treeCollapse !== undefined) setAllBranches(false);
      else if (b.dataset.home !== undefined) home();
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
      const shortcuts = $("#shortcuts");
      if (e.key === "?" && shortcuts) { e.preventDefault(); shortcuts.togglePopover(); return; }
      // Escape closes the open shortcuts list before it moves the camera.
      if (shortcuts?.matches(":popover-open")) return;
      if (e.key === "Escape") zoomOut();
      if (e.key === "+" || e.key === "=") zoomBy(ZOOM_STEP);
      if (e.key === "-") zoomBy(1 / ZOOM_STEP);
      if (e.key === "0") home();
    });
    addEventListener("resize", () => {
      const wasHome = M.atHome;
      if (M.tree.nodes.some(n => n.w !== widthOf(n)) || M.vertical !== verticalBranches()) {
        reflow(false);
        M.vertical = verticalBranches();
        if (!wasHome && M.target) return flyToNode(M.target, false);
      }
      if (wasHome) return home(false);
      clampCam();
      apply(false);
    });
  }

  // Keep both leaf petioles on the actual rendered curve, including during morphs.
  function positionFoliage(g) {
    const foliage = $(".branch-foliage", g);
    if (!foliage) return;
    const stem = $(".stem", g), length = stem.getTotalLength();
    const at = Math.max(0, length - 30), p = stem.getPointAtLength(at);
    const next = stem.getPointAtLength(Math.min(length, at + 1));
    const angle = Math.atan2(next.y - p.y, next.x - p.x) * 180 / Math.PI;
    foliage.setAttribute("transform", `translate(${p.x} ${p.y}) rotate(${angle})`);
    const remaining = parseFloat(getComputedStyle(stem).strokeDashoffset) || 0;
    foliage.style.visibility = remaining <= 30 / Math.max(1, length) ? "visible" : "hidden";
  }
  let foliageFrame = 0;
  function trackFoliage() {
    cancelAnimationFrame(foliageFrame);
    const tick = () => {
      let moving = false;
      $$("[data-edge]", M.worldEl).forEach(g => {
        if (g.style.display === "none") return;
        positionFoliage(g);
        moving ||= $(".stem", g).getAnimations().some(a => a.playState === "running");
      });
      foliageFrame = moving ? requestAnimationFrame(tick) : 0;
    };
    tick();
  }
  function shiftedPath(path, dx, dy) {
    let i = 0;
    return path.replace(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, value => String(Number(value) + (i++ % 2 ? dy : dx)));
  }

  /* ---------- Independently growing detail branches ---------- */
  const motions = new WeakMap();
  function motion(el, slot, from, to, duration, delay = 0, done) {
    let slots = motions.get(el);
    if (!slots) { slots = new Map(); motions.set(el, slots); }
    slots.get(slot)?.cancel();
    Object.assign(el.style, to);
    if (!duration || reduced()) { slots.delete(slot); done?.(); return; }
    const a = el.animate([from, to], {duration, delay, fill: "both", easing: "cubic-bezier(.22,.8,.22,1)"});
    slots.set(slot, a);
    a.onfinish = () => {
      if (slots.get(slot) !== a) return;
      slots.delete(slot); a.cancel(); done?.();
    };
  }
  function reflow(animate = false) {
    interruptMotion();
    const duration = animate && !reduced() ? 440 : 0;
    const anchor = M.target || M.revealed;
    const oldCards = new Map(M.tree.nodes.map(n => {
      const css = getComputedStyle(n.el), transform = new DOMMatrix(css.transform);
      return [n.id, {visible: !n.el.hidden, x: n.x + transform.e, y: n.y + transform.f, transform: css.transform, opacity: css.opacity}];
    }));
    const oldAnchor = anchor && oldCards.get(anchor.id);
    const world = layoutWorld(M.tree.nodes, makeMeasurer(M.worldEl), M.expanded);
    const dx = anchor ? anchor.x - oldAnchor.x : 0, dy = anchor ? anchor.y - oldAnchor.y : 0;
    $(".probe", M.worldEl)?.remove();
    M.world = world; M.W = world.width; M.H = world.height;
    M.worldEl.style.width = `${world.width}px`; M.worldEl.style.height = `${world.height}px`;
    M.tree.nodes.forEach(n => {
      const before = oldCards.get(n.id), el = n.el;
      positionCard(n);
      el.inert = !n.visible;
      if (n.visible) {
        el.hidden = false;
        const matrix = new DOMMatrix(before.transform);
        const from = before.visible ? `translate(${before.x + dx - n.x}px, ${before.y + dy - n.y}px) scale(${matrix.a}, ${matrix.d})` : `translate(${verticalBranches() ? 0 : -24}px, ${verticalBranches() ? -24 : 0}px) scale(.94)`;
        motion(el, "position", {transform: from, opacity: before.visible ? before.opacity : "0"}, {transform: "none", opacity: "1"}, before.visible ? duration : duration ? 440 : 0, !before.visible && duration ? 230 : 0);
      } else if (before.visible) {
        motion(el, "position", {transform: before.transform, opacity: before.opacity}, {transform: "translateX(-18px) scale(.96)", opacity: "0"}, duration ? 220 : 0, 0, () => { if (!n.visible) el.hidden = true; });
      }
    });
    const svg = $(".tree-branches", M.worldEl), active = new Set(world.lines.map(l => l.to));
    svg.setAttribute("width", world.width); svg.setAttribute("height", world.height);
    const existing = new Map($$("[data-edge]", svg).map(g => [g.dataset.edge, g]));
    world.lines.forEach(l => {
      let g = existing.get(l.to);
      const fresh = !g;
      const entering = fresh || g.dataset.closed === "true";
      if (!g) { g = edgeElement(l); svg.append(g); }
      g.style.display = ""; g.dataset.closed = "false";
      const stem = $(".stem", g), shape = fresh ? getComputedStyle(stem).d : shiftedPath(getComputedStyle(stem).d, dx, dy);
      const dash = entering ? g.dataset.drawn ? getComputedStyle(stem).strokeDashoffset : "1" : getComputedStyle(stem).strokeDashoffset;
      stem.setAttribute("d", l.d); stem.style.strokeDasharray = "1";
      motion(stem, "shape", {d: shape}, {d: `path("${l.d}")`}, duration);
      motion(stem, "draw", {strokeDashoffset: dash}, {strokeDashoffset: "0"}, entering && duration ? 520 : duration);
      g.dataset.drawn = "true";
      const foliage = $(".branch-foliage", g);
      if (foliage) {
        $$(".olive-leaf", foliage).forEach((leaf, i) => {
          const css = getComputedStyle(leaf);
          motion(leaf, "unfurl", {transform: fresh ? "scale(.12) rotate(" + (i ? 30 : -30) + "deg)" : css.transform, opacity: fresh ? "0" : css.opacity}, {transform: "none", opacity: ".8"}, duration ? 380 : 0, entering && duration ? 200 + i * 55 : 0);
        });
      }
    });
    existing.forEach((g, id) => {
      if (active.has(id)) return;
      g.dataset.closed = "true";
      const stem = $(".stem", g);
      motion(stem, "draw", {strokeDashoffset: getComputedStyle(stem).strokeDashoffset}, {strokeDashoffset: "1"}, duration ? 320 : 0, 0, () => { if (g.dataset.closed === "true") g.style.display = "none"; });
      $$(".olive-leaf", g).forEach(leaf => motion(leaf, "unfurl", {transform: getComputedStyle(leaf).transform, opacity: getComputedStyle(leaf).opacity}, {transform: "scale(.12)", opacity: "0"}, duration ? 200 : 0));
    });
    $$("[data-expand]", M.worldEl).forEach(button => {
      const open = M.expanded.has(button.dataset.expand);
      button.setAttribute("aria-expanded", String(open));
      $(".branch-mark", button).textContent = open ? "−" : "+";
    });
    if (anchor) {
      M.cam.x += (oldAnchor.x - anchor.x) * M.cam.s;
      M.cam.y += (oldAnchor.y - anchor.y) * M.cam.s;
    }
    trackFoliage();
    currentLod = -1;
  }
  function setAllBranches(opening) {
    let target = M.target || here().at(-1) || M.tree.nodes.find(n => n.kind === "root");
    if (!opening) while (target.parent) target = target.parent;
    M.target = target; M.revealed = target;
    M.expanded.clear();
    if (opening) M.tree.nodes.forEach(n => { if (n.parent) M.expanded.add(n.id); });
    reflow(true);
    // Frame the resulting tree after a global expand or collapse.
    M.worldEl.style.transition = "none";
    M.worldEl.style.transform = `translate(${M.cam.x}px, ${M.cam.y}px) scale(${M.cam.s})`;
    if (!reduced()) M.worldEl.getBoundingClientRect();
    home(true);
  }
  function toggleBranch(n, animate = true) {
    if (!n?.parent) return;
    const parent = n.parent, opening = !M.expanded.has(n.id);
    interruptMotion();
    M.target = parent; M.revealed = parent;
    const foldingFromLeaf = !opening && n.el.contains(document.activeElement);
    if (foldingFromLeaf) {
      M.branchFocus = true;
      parent.el.querySelector(`[data-expand="${n.id}"]`)?.focus({preventScroll: true});
      M.branchFocus = false;
    }
    if (opening) M.expanded.add(n.id); else M.expanded.delete(n.id);
    reflow(animate);
    // Commit the layout compensation before starting the pan to the new target.
    M.worldEl.style.transition = "none";
    M.worldEl.style.transform = `translate(${M.cam.x}px, ${M.cam.y}px) scale(${M.cam.s})`;
    if (animate && !reduced()) M.worldEl.getBoundingClientRect();
    const target = opening ? n : parent;
    centerNode(target, animate, !opening);
    if (opening) focusCard(target);
  }

  // Tree navigation pans at the reader's current zoom, including tall cards.
  function centerNode(target, animate = true, keepControl = false) {
    M.target = target; M.revealed = target;
    const {s} = M.cam;
    M.cam.x = vw() / 2 - (target.x + target.w / 2) * s;
    // Center the card at the reader's zoom. Tall cards start at their heading.
    M.cam.y = target.h * s <= vh() - 24
      ? vh() / 2 - (target.y + target.h / 2) * s
      : 12 - target.y * s;
    const control = document.activeElement;
    if (keepControl && control !== target.el && target.el.contains(control)) {
      let top = 0;
      for (let el = control; el && el !== target.el; el = el.offsetParent) top += el.offsetTop;
      const screenTop = M.cam.y + (target.y + top) * s;
      const screenBottom = screenTop + control.offsetHeight * s;
      if (screenBottom > vh() - 12) M.cam.y -= screenBottom - vh() + 12;
      else if (screenTop < 12) M.cam.y += 12 - screenTop;
    }
    clampCam(); apply(animate);
  }

  /* ---------- Hash and aliases ---------- */
  // Compatibility with the former reference-heavy map and classic Guide anchors.
  const ALIASES = {
    "tighten-open-terms": "how-bids-are-judged",
    "deposit-token-approval": "hub-and-vaults",
    "cash-expiration-reserve": "settle-at-expiry",
    "expire-the-vault": "settle-at-expiry",
    "buyer-reserve-sources": "buyer-claims-any-payout",
    "buyer-claim-recipient": "claim-payout",
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
    "expiry-date-arrives": "settle-at-expiry",
    "keep-exercising": "settle-at-expiry",
    "publish-the-final-price": "settle-at-expiry",
    "the-exact-second": "settle-at-expiry",
    "grace-window-closes": "settle-at-expiry",
    "who-may-expire": "settle-at-expiry",
    "physical-expiration": "settle-at-expiry",
    "cash-expiration": "settle-at-expiry",
    "expiration-result": "settle-at-expiry",
    "no-grace-for-cash": "settle-at-expiry",
    "too-late": "settle-at-expiry",
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
  function focusCard(n) { n.el.focus({ preventScroll: true }); }
  function visitBranch(n) {
    if (n.parent && !M.expanded.has(n.id)) return toggleBranch(n);
    interruptMotion();
    centerNode(n);
    focusCard(n);
  }
  function wireKeys() {
    const mapEl = M.mapEl;
    let pointerDown = false;
    mapEl.addEventListener("pointerdown", () => { pointerDown = true; }, true);
    const releasePointer = () => { pointerDown = false; };
    addEventListener("pointerup", releasePointer, true);
    addEventListener("pointercancel", releasePointer, true);
    addEventListener("blur", releasePointer);
    mapEl.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const branchControl = e.target.closest("[data-expand], [data-fold]");
      if (e.target.closest("input, select, textarea, [contenteditable=true], a") ||
          (e.target.closest("button") && !branchControl)) return;
      // Selection is authoritative: a previous DOM focus may belong to a card
      // left behind by a pointer, breadcrumb, or camera gesture.
      const path = here();
      const current = M.target || path.at(-1);
      const stations = M.tree.nodes.filter(n => n.kind === "station");
      const siblings = n => n.parent ? n.parent.children : stations;
      let next = null;
      if (e.key === "Home") next = stations[0];
      else if (e.key === "Enter" && !branchControl && current) {
        e.preventDefault(); flyToNode(current); focusCard(current); return;
      } else if (!e.key.startsWith("Arrow")) return;
      else if (!current) {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = stations[0];
      } else if (e.key === "ArrowRight") {
        next = branchControl?.closest(".card")?.dataset.id === current.id && branchControl.dataset.expand
          ? M.tree.byId.get(branchControl.dataset.expand)
          : current.children.find(c => c.kind !== "custody") || current.children[0];
        if (current.kind === "root") next = stations[0];
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (current.parent) {
          // Leaving this level folds every sibling in the same layout update.
          // Keep the current branch open until toggleBranch closes it.
          for (const sibling of current.parent.children) {
            if (sibling !== current) M.expanded.delete(sibling.id);
          }
          toggleBranch(current);
          // Arrow navigation returns to the parent tile. Native disclosure
          // buttons still restore focus to their trigger when activated.
          centerNode(current.parent);
          focusCard(current.parent);
        }
        return;
      } else {
        const list = siblings(current), index = list.indexOf(current);
        if (index >= 0) next = list[index + (e.key === "ArrowDown" ? 1 : -1)];
      }
      // Consume boundary arrows too: never wrap, scroll, or change levels.
      e.preventDefault();
      if (next) {
        if (!current) { flyToNode(next); focusCard(next); }
        else visitBranch(next);
      }
    });
    mapEl.addEventListener("focusin", (e) => {
      const card = e.target.closest(".card");
      if (!card) return;
      const node = M.tree.byId.get(card.dataset.id);
      // Tabbing to a card's native controls must use the camera, not an
      // independent scroll offset in the overflow-hidden canvas.
      mapEl.scrollTo(0, 0);
      if (!pointerDown && !M.branchFocus) {
        if (M.target !== node) flyToNode(node, false);
        // A newly grown sibling may have moved the camera below this control.
        // Keep keyboard focus visible even when its card is taller than the view.
        const control = e.target.getBoundingClientRect(), view = mapEl.getBoundingClientRect();
        if (e.target !== card && (control.top < view.top + 12 || control.bottom > view.bottom - 12)) {
          M.cam.y += control.top < view.top + 12 ? view.top + 12 - control.top : view.bottom - 12 - control.bottom;
          clampCam(); apply(false);
        }
      }
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
    if (/Mac|iPhone|iPad/.test(navigator.platform)) $$("#shortcuts [data-mod]").forEach(k => (k.textContent = "⌘"));
  }

  const state = () => ({ scale: M.cam.s, lod: currentLod, path: here().map((n) => n.id), expanded: [...M.expanded] });

  function boot() {
    document.fonts.ready.then(() => { window.IvyMap.mounted = mount(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.IvyMap = { readDocument, layoutWorld, render, setLod, lodOf, GEOMETRY: G, state, flyTo, home, zoomOut, zoomBy, zoomTo, paintZoom, here, _cam: () => ({ ...M.cam }), ALIASES, search, resolveHash };
})();
