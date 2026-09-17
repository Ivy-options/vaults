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

  window.IvyMap = { readDocument };
})();
