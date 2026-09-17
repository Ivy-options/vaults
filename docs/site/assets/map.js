/* Lifecycle map engine. Builds a zoomable world from the semantic document in #document. */
(() => {
  const $ = (s, scope = document) => scope.querySelector(s);
  const $$ = (s, scope = document) => [...scope.querySelectorAll(s)];
  const KINDS = ["station", "moment", "action", "tile", "lab", "custody"];

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

  window.IvyMap = { readDocument, layoutWorld, GEOMETRY: G };
})();
