import {
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { resolve, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, Renderer } from "marked";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = resolve(root, "docs/site");
const pages = [
  { source: "LICENSE.md", output: "license.html", title: "Business Source License 1.1" },
  { source: "README.md", output: "project-setup.html", title: "Project setup" },
  {
    source: "examples/operator/README.md",
    output: "operator-examples.html",
    title: "Operator request examples",
  },
];
const destinations = new Map(
  pages.map((page) => [resolve(root, page.source), page.output])
);
destinations.set(resolve(root, "docs/site/index.html"), "index.html");
destinations.set(resolve(root, "examples/operator"), "operator-examples.html");
const escape = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[
        char
      ])
  );
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/&[^;]+;/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");

// The renderer configuration (heading ids, link mapping to site pages, table
// wrapping, the download treatment of .json/.sol codespans) is shared between
// the standalone reference pages and the fragments spliced into the map.
function makeRenderer(page, requests) {
  const headings = [];
  const usedIds = new Map();
  const renderer = new Renderer();
  renderer.heading = function ({ tokens, depth }) {
    const content = this.parser.parseInline(tokens);
    const base = slug(content);
    const count = usedIds.get(base) || 0;
    usedIds.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    if (depth === 2 || depth === 3) headings.push({ id, content, depth });
    return `<h${depth} id="${id}">${
      depth === 1 ? escape(page.title) : content
    }</h${depth}>\n`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const [path, anchor] = href.split("#");
    let target = href;
    if (path && !/^[a-z]+:/i.test(path)) {
      const absolute = resolve(
        root,
        dirname(page.source),
        decodeURIComponent(path)
      );
      // Reference pages live in docs/site and are edited there directly.
      const mapped =
        destinations.get(absolute) ??
        (absolute.startsWith(site + "/") && absolute.endsWith(".html")
          ? relative(site, absolute)
          : undefined);
      if (!mapped)
        throw new Error(`No site destination for ${page.source}: ${href}`);
      target = mapped + (anchor ? `#${anchor}` : "");
    }
    if (/\.md(?:$|#|\?)/i.test(target))
      throw new Error(`Markdown link in site: ${target}`);
    const download = /\.(json|sol)$/.test(target) ? " download" : "";
    return `<a href="${escape(target)}"${
      title ? ` title="${escape(title)}"` : ""
    }${download}>${this.parser.parseInline(tokens)}</a>`;
  };
  const defaultTable = renderer.table;
  renderer.table = function (token) {
    return `<div class="tablewrap" tabindex="0" role="region" aria-label="${escape(
      page.title
    )} reference table">${defaultTable.call(this, token)}</div>\n`;
  };
  renderer.codespan = function ({ text }) {
    const code = `<code>${escape(text)}</code>`;
    return requests.includes(text)
      ? `<a href="assets/requests/${escape(text)}" download>${code}</a>`
      : code;
  };
  return { renderer, headings };
}

// A Markdown block becomes one map tile. A list with many items would render
// as one absurdly tall card, so long lists are split into several tiles of a
// few items each; every other block type stays whole.
const TILE_TITLES = {
  list: "Checklist",
  code: "Commands",
  table: "Table",
  paragraph: "Note",
};
// Tuned against docs/site/test/coverage.test.mjs's "no tile overflows" lint,
// which renders the map at every zoom tier and fails if a tile's visible
// layer scrolls. A tile is 132px wide (G.tile in map.js) or 276px at
// data-span="2"; past ~6 rendered list items the single-column card grows
// taller than its neighbours (not a scroll overflow, but the "absurdly tall
// tiles" this task calls out), so longer lists are chunked into more tiles
// instead of shrinking to fit. If a README grows a longer list, re-run
// docs:test — this constant is what the lint is guarding.
const MAX_LIST_ITEMS_PER_TILE = 6;
// A single-column tile (data-span 1, 132px wide, see G.tile in map.js) is too
// narrow to wrap a long inline <code> span, which the tile stylesheet sets to
// white-space: nowrap; that overflows the card's scrollWidth instead of
// wrapping, which is exactly what coverage.test.mjs's overflow check at every
// zoom tier catches. Widening to data-span="2" (276px) gives the span room to
// fit unwrapped. 30 was picked empirically against the two READMEs' longest
// inline code (URLs and file paths in backticks); docs:test will fail loudly
// if a future README paragraph needs a different cutoff.
const MAX_INLINE_CODE_LEN = 30;
function longestCodespan(token) {
  let max = 0;
  const walk = (t) => {
    if (!t || typeof t !== "object") return;
    if (t.type === "codespan") max = Math.max(max, t.text.length);
    if (Array.isArray(t.tokens)) t.tokens.forEach(walk);
    if (Array.isArray(t.items)) t.items.forEach(walk);
  };
  walk(token);
  return max;
}
function toChunks(block) {
  if (block.type === "list" && block.items.length > MAX_LIST_ITEMS_PER_TILE) {
    const groups = [];
    for (let i = 0; i < block.items.length; i += MAX_LIST_ITEMS_PER_TILE)
      groups.push(block.items.slice(i, i + MAX_LIST_ITEMS_PER_TILE));
    return groups.map((items) => ({ ...block, items }));
  }
  return [block];
}
function buildAction(shell, section, render) {
  const blocks = section.blocks;
  // Only the section's very first block, if it is a paragraph, becomes the
  // action's summary <p>. Reaching past it for a later paragraph would pull
  // that text ahead of whatever precedes it in the Markdown (e.g. a list),
  // reordering the section; every current shell's Markdown does start with a
  // paragraph, so this never needs to fall through in practice today.
  const summaryIndex = blocks.length && blocks[0].type === "paragraph" ? 0 : -1;
  const summary = summaryIndex >= 0 ? blocks[summaryIndex] : null;
  const rest = blocks.filter((_, i) => i !== summaryIndex);
  const titleSeq = new Map();
  let tileSeq = 0;
  const tiles = rest
    .flatMap(toChunks)
    .map((block) => {
      tileSeq += 1;
      const base = TILE_TITLES[block.type] || "Note";
      const count = (titleSeq.get(base) || 0) + 1;
      titleSeq.set(base, count);
      const title = count > 1 ? `${base} ${count}` : base;
      const span =
        block.type === "list" ||
        block.type === "code" ||
        block.type === "table" ||
        longestCodespan(block) > MAX_INLINE_CODE_LEN
          ? ' data-span="2"'
          : "";
      return `<section data-kind="tile" id="${shell.id}-${tileSeq}"${span}><h5>${escape(
        title
      )}</h5>${render([block])}</section>\n`;
    })
    .join("");
  return `<section data-kind="action" id="${shell.id}"><h4>${shell.title}</h4>${
    summary ? render([summary]) : "<p></p>"
  }${tiles}</section>\n`;
}

export function buildDocs({ check = false } = {}) {
  const outputs = new Map();
  const requests = readdirSync(resolve(root, "examples/operator"))
    .filter((name) => name.endsWith(".json"))
    .sort();
  for (const name of requests)
    outputs.set(
      `assets/requests/${name}`,
      readFileSync(resolve(root, "examples/operator", name), "utf8")
    );
  const rawSources = [
    "contracts/examples/ExampleSettlementPublisher.sol",
    "contracts/interfaces/IIvySettlementPricePublication.sol",
  ];
  for (const source of rawSources) {
    const target = `assets/source/${basename(source)}`;
    destinations.set(resolve(root, source), target);
    outputs.set(target, readFileSync(resolve(root, source), "utf8"));
  }
  for (const page of pages) {
    const source = readFileSync(resolve(root, page.source), "utf8");
    const { renderer, headings } = makeRenderer(page, requests);
    const body = new Marked({ renderer, gfm: true }).parse(source);
    const navigation = headings
      .map(
        (heading) =>
          `<a href="#${heading.id}"${
            heading.depth === 3 ? ' class="subsection-link"' : ""
          }>${heading.content}</a>`
      )
      .join("\n");
    outputs.set(
      page.output,
      `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(page.title)} · Ivy Vaults</title>
  <meta name="description" content="${escape(page.title)} for Ivy Vaults.">
  <script>try { if (localStorage.getItem("ivy-theme") === "light") document.documentElement.dataset.theme = "light"; } catch (_) {}</script>
  <link rel="icon" type="image/png" href="assets/ivy-logo.png">
  <link rel="stylesheet" href="assets/docs.css">
  <link rel="stylesheet" href="assets/guide.css">
  <link rel="stylesheet" href="assets/reference.css">
  <link rel="stylesheet" href="assets/atlas.css">
  <link rel="stylesheet" href="assets/roman.css">
  <script src="assets/reference.js" defer></script>
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="topbar"><a class="brand" href="index.html" aria-label="Ivy Vaults protocol guide"><img src="assets/ivy-logo.png" alt="" width="23" height="34">Ivy <span>Vaults</span></a><span class="breadcrumb">Documentation / ${escape(
    page.title
  )}</span><button class="theme" id="themeToggle" type="button" aria-label="Switch colour theme">Theme</button></header>
  <aside class="rail"><a class="back-guide" href="index.html">← Protocol guide</a>${
    navigation
      ? `<details id="contents" open><summary>In this document</summary><nav aria-label="Page sections">${navigation}</nav></details>`
      : ""
  }</aside>
  <main id="content" class="content doc-page" tabindex="-1"><article>${body}</article></main>
  <footer><a href="index.html">Ivy Vaults · Protocol guide</a> · <a href="license.html">License · BUSL-1.1</a></footer>
</body>
</html>
`
    );
  }

  // Fill the empty action shells left inside docs/site/index-map.html (Task 12)
  // with content rendered from the README markdown, so the guide's prose stays
  // the single source of truth. Shell ids and titles are untouched; only the
  // region between the marker comments is (re)written.
  const mapName = existsSync(resolve(site, "index-map.html"))
    ? "index-map.html"
    : "index.html";
  const mapPath = resolve(site, mapName);
  let mapHtml = readFileSync(mapPath, "utf8");
  const fragments = [
    { name: "project-setup", source: "README.md" },
    { name: "operator-examples", source: "examples/operator/README.md" },
  ];
  for (const fragment of fragments) {
    const page = pages.find((p) => p.source === fragment.source);
    const { renderer } = makeRenderer(page, requests);
    const render = (fragmentTokens) =>
      new Marked({ renderer, gfm: true }).parser(fragmentTokens);
    const tokens = new Marked({ gfm: true }).lexer(
      readFileSync(resolve(root, page.source), "utf8")
    );

    // Split the body at each H2 into sections; content before the first H2
    // (e.g. README's opening tagline) belongs to no shell and is dropped.
    const sections = [];
    let current = null;
    for (const t of tokens) {
      if (t.type === "space" || (t.type === "heading" && t.depth === 1))
        continue;
      if (t.type === "heading" && t.depth === 2) {
        current = { title: t.text, blocks: [] };
        sections.push(current);
        continue;
      }
      if (current) current.blocks.push(t);
    }
    // A source with no H2 (the operator README) puts its whole body, minus
    // the H1 and blank-line spacer tokens, into one section.
    if (!sections.length)
      sections.push({
        title: null,
        blocks: tokens.filter(
          (t) => t.type !== "space" && !(t.type === "heading" && t.depth === 1)
        ),
      });

    const marker = new RegExp(
      `(<!-- generated:${fragment.name} -->)([\\s\\S]*?)(<!-- /generated:${fragment.name} -->)`
    );
    const match = mapHtml.match(marker);
    if (!match)
      throw new Error(`Missing generated:${fragment.name} markers in ${mapName}`);
    // Match just the opening `<section id><h4>title</h4>` of each top-level
    // action, regardless of whether it is still an empty shell (freshly from
    // Task 12) or already carries generated content from a previous build,
    // so rebuilding is idempotent: the id and title always anchor the region.
    const shells = [
      ...match[2].matchAll(
        /<section data-kind="action" id="([^"]+)"><h4>([^<]*)<\/h4>/g
      ),
    ].map(([, id, title]) => ({ id, title }));
    if (!shells.length)
      throw new Error(
        `No empty action shells found for generated:${fragment.name} in ${mapName}`
      );

    const bySlug = new Map(
      sections.filter((s) => s.title).map((s) => [slug(s.title), s])
    );
    const whole = sections.length === 1 && sections[0].title === null;
    // The inverse of the shell-with-no-section error below: a heading whose
    // slug matches no shell would otherwise be silently dropped from the map.
    if (!whole) {
      const shellIds = new Set(shells.map((s) => s.id));
      for (const section of sections) {
        if (!section.title) continue;
        const key = slug(section.title);
        if (!shellIds.has(key))
          throw new Error(
            `README H2 "${section.title}" (slug ${key}) in ${page.source} has no matching shell; expected <section data-kind="action" id="${key}"> inside generated:${fragment.name} in ${mapName}.`
          );
      }
    }
    let out = "";
    for (const shell of shells) {
      const section = whole ? sections[0] : bySlug.get(shell.id);
      if (!section)
        throw new Error(
          `No Markdown H2 in ${page.source} maps to shell #${shell.id} (fragment ${fragment.name}); check the heading text and its slug.`
        );
      out += buildAction(shell, section, render);
    }
    // Use a replacer FUNCTION, not a template string: generated content can
    // itself contain "$"-sequences (e.g. a dollar amount like "$10,000" from
    // examples/operator/README.md), and String.replace() reinterprets "$n"
    // in a *string* replacement as a capture-group backreference. That once
    // silently corrupted the built page (a "$1" inside "$10,000" was replaced
    // by capture group 1, the opening marker comment, eating the digits). A
    // function's return value is inserted verbatim, with no such reparsing.
    mapHtml = mapHtml.replace(marker, (_match, open, _old, close) => `${open}\n${out}${close}`);
  }
  outputs.set(mapName, mapHtml);

  for (const [name, contents] of outputs) {
    const target = resolve(site, name);
    if (check) {
      if (!existsSync(target) || readFileSync(target, "utf8") !== contents)
        throw new Error(
          `Stale or missing ${relative(root, target)}. Run npm run docs:build.`
        );
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
  }
  return pages.map((page) => resolve(site, page.output));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const check = process.argv.includes("--check");
  const generated = buildDocs({ check });
  console.log(
    `${check ? "Verified" : "Built"} ${
      generated.length
    } generated HTML pages and their local downloads.`
  );
}
