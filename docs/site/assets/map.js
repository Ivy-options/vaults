/* Lifecycle map engine. Builds a zoomable world from the semantic document in #document. */
(() => {
  const $ = (s, scope = document) => scope.querySelector(s);
  const $$ = (s, scope = document) => [...scope.querySelectorAll(s)];
  const KINDS = ["station", "moment", "action", "tile", "lab", "custody"];
  // document.currentScript is only live during this synchronous run, so capture the
  // assets/ base now (relative to this script's own URL) for use inside later renders.
  const ASSET_BASE = document.currentScript ? new URL(".", document.currentScript.src).href : "assets/";

  // Walk nested <section data-kind> elements. Heading = label; data-* = tier text; body = everything else.
  function readDocument(root) {
    const nodes = [], byId = new Map();
    const bodyOf = (el) => $$(":scope > *", el).filter((c) => !/^H[1-6]$/.test(c.tagName) && c.tagName !== "SECTION");
    function visit(el, parent, band) {
      const kind = el.dataset.kind;
      if (!KINDS.includes(kind)) throw new Error(`Unknown data-kind on #${el.id}`);
      if (!el.id) throw new Error(`Section without id under ${parent?.id ?? "root"}`);
      const heading = $(":scope > h2, :scope > h3, :scope > h4, :scope > h5", el);
      const body = bodyOf(el);
      const firstP = body.find((c) => c.tagName === "P");
      const node = {
        id: el.id, kind, band, source: el, parent, children: [],
        depth: parent ? parent.depth + 1 : 0,
        label: heading ? heading.textContent.trim() : el.id,
        actor: el.dataset.actor || null,
        dim: el.hasAttribute("data-dim"),
        when: el.dataset.when || "",
        tagline: el.dataset.tagline || "",
        span: Number(el.dataset.span || 1),
        illustration: el.dataset.illustration || "",
        summary: firstP ? firstP.textContent.trim() : "",
        bodyHtml: body.map((c) => c.outerHTML).join(""),
      };
      node.path = parent ? `${parent.path}/${node.id}` : node.id;
      if (byId.has(node.id)) throw new Error(`Duplicate node id ${node.id}`);
      nodes.push(node); byId.set(node.id, node);
      if (parent) parent.children.push(node);
      $$(":scope > section[data-kind]", el).forEach((child) => visit(child, node, band));
      return node;
    }
    $$(":scope > section[data-kind]", root.querySelector("article") || root).forEach((el) =>
      visit(el, null, el.dataset.band === "shelf" ? "shelf" : "life"));
    return { nodes, byId };
  }

  const G = {
    station: [360, 200], moment: [300, 170], action: [300, 150], custody: [220, 170],
    gap: 40, momentY: 320, actionY: 560, actionGap: 20, tile: 132, tileGap: 12,
    columnPad: 80, bandGap: 260, minTile: 40,
  };
  const spanW = (span) => (span >= 2 ? 2 * G.tile + G.tileGap : G.tile);

  // Places every node. Stations left to right per band; moments in a centred row; actions stacked; tiles in a two-column grid.
  function layoutWorld(nodes, measure) {
    const lines = [];
    const line = (x, y, w, h, kind) => lines.push({ x, y, w, h, kind });
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
          Object.assign(m, { x: rowX + j * (G.moment[0] + G.gap), y: y0 + G.momentY, w: G.moment[0], h: G.moment[1] });
          let ay = y0 + G.actionY;
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
    const life = layoutBand("life", 0);
    const shelfY = life.bottom + G.bandGap;
    const shelf = layoutBand("shelf", shelfY);
    const width = Math.max(life.width, shelf.width);
    // Connectors: main line, shelf rule, drops, rows, gaps, pins. Drawn only where no card sits.
    const cx = (n) => n.x + n.w / 2;
    line(0, -40, life.width, 2, "main");
    if (shelf.width) { line(0, shelfY - 60, shelf.width, 1, "rule"); }
    nodes.filter((n) => n.kind === "station").forEach((st) => {
      const moments = st.children.filter((c) => c.kind === "moment");
      if (st.band === "life") line(cx(st), -40, 0, 0, "pin-main");
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
     A card must never show the same text at two consecutive tiers: each tier
     adds or removes information rather than just resizing it. */
  function layersFor(n) {
    const t = esc(n.label), when = n.when ? `<span class="when">${esc(n.when)}</span>` : "";
    switch (n.kind) {
      case "station": {
        const count = n.children.filter((c) => c.kind === "moment").length;
        return { 0: `<h2>${t}</h2>`, 1: `<h2>${t}</h2><p>${esc(n.tagline)}</p><small>${count} ${n.band === "shelf" ? "topics" : "moments"} · zoom in</small>`, 3: `<h2 class="compact">${t}</h2>` };
      }
      case "moment":
        return { 0: `<h3>${t}</h3>`, 2: `${when}<h3>${t}</h3><p>${esc(n.summary)}</p>`, 3: `${when}<h3>${t}</h3>` };
      case "action": {
        const head = n.actor ? badge(n) : "";
        const more = n.children.length ? `<small>${n.children.length} details · zoom in</small>` : "";
        const layers = { 0: head || `<h4>${t}</h4>`, 1: `${head}<h4>${t}</h4>`, 2: `${head}<h4>${t}</h4><p>${esc(n.summary)}</p>${more}` };
        if (n.children.length) layers[3] = `${head}<h4>${t}</h4>`; // the parent recedes to a badge + title only while its tiles are being read
        return layers;
      }
      case "tile":
        return { 0: `<i class="more" aria-hidden="true"></i>`, 2: `<h5>${t}</h5>`, 3: `<h5>${t}</h5><div class="body">${n.bodyHtml}</div>` };
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
  let currentLod = -1;
  function setLod(lod, worldEl = $("#world")) {
    if (lod === currentLod) return;
    currentLod = lod;
    worldEl.dataset.lod = lod;
    $$(".card", worldEl).forEach((el) => {
      const tiers = el.dataset.tiers.split(",").map(Number);
      el.dataset.show = String(Math.max(-1, ...tiers.filter((t) => t <= lod)));
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
      const h = probe.firstElementChild.offsetHeight + 2;
      probe.innerHTML = "";
      return h;
    };
    return (n) => {
      if (n.kind === "action") return Math.max(heightOf(n, 2, G.action[0]), heightOf(n, 3, G.action[0]));
      return heightOf(n, n.kind === "lab" ? 2 : 3, spanW(n.kind === "lab" ? 2 : n.span));
    };
  }

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
    setLod(0, worldEl);
    return { tree, world, worldEl, mapEl };
  }

  function boot() {
    document.fonts.ready.then(() => { window.IvyMap.mounted = mount(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  window.IvyMap = { readDocument, layoutWorld, render, setLod, lodOf, GEOMETRY: G };
})();
