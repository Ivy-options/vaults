import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext, Script } from "node:vm";
import { buildDocs } from "./build-docs.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagePath = resolve(root, "docs/site/index.html");
const html = readFileSync(pagePath, "utf8");
const site = dirname(pagePath);
const generated = buildDocs({ check: true });
// The map page carries two generated regions (README fragments) that
// buildDocs fills in place; fail loudly if a region is missing or still empty.
const mapPath = resolve(
  site,
  existsSync(resolve(site, "index-map.html")) ? "index-map.html" : "index.html"
);
const mapHtml = readFileSync(mapPath, "utf8");
for (const name of ["project-setup", "operator-examples"]) {
  const open = `<!-- generated:${name} -->`;
  const close = `<!-- /generated:${name} -->`;
  const region = mapHtml.match(
    new RegExp(`<!-- generated:${name} -->([\\s\\S]*?)<!-- /generated:${name} -->`)
  );
  assert.ok(region, `Missing generated region ${name} in ${mapPath}`);
  assert.ok(
    /data-kind="tile"/.test(region[1]),
    `Generated region ${name} is empty. Run npm run docs:build.`
  );
  // A splice bug (e.g. using a string replacement where generated content
  // contains "$"-sequences that get reinterpreted as capture references) can
  // leave a stray copy of the marker comment inside the generated content
  // itself. Each marker must appear exactly once: at its region boundary.
  assert.equal(
    mapHtml.split(open).length - 1,
    1,
    `Marker ${open} appears more than once in ${mapPath} (a corrupted splice leaves a stray copy inside the generated content). Run npm run docs:build.`
  );
  assert.equal(
    mapHtml.split(close).length - 1,
    1,
    `Marker ${close} appears more than once in ${mapPath}. Run npm run docs:build.`
  );
}
// Reference pages are hand-maintained HTML; check every page in the site.
const pages = [
  ...new Set([
    pagePath,
    ...generated,
    ...readdirSync(site)
      .filter((name) => name.endsWith(".html"))
      .map((name) => resolve(site, name)),
  ]),
];
const pageIds = new Map(
  pages.map((path) => {
    const content = readFileSync(path, "utf8");
    const ids = [...content.matchAll(/\bid="([^"]+)"/g)].map(
      (match) => match[1]
    );
    assert.equal(new Set(ids).size, ids.length, `Duplicate IDs: ${path}`);
    assert.match(content, /<html lang="en"/);
    assert.equal((content.match(/<main\b/g) || []).length, 1, path);
    assert.equal((content.match(/<h1\b/g) || []).length, 1, path);
    return [path, ids];
  })
);
for (const path of pages) {
  const content = readFileSync(path, "utf8");
  for (const [, url] of content.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    assert.ok(!/^(?:https?:)?\/\//.test(url), `Page must work offline: ${url}`);
    assert.ok(!/\.md(?:$|#|\?)/i.test(url), `Markdown link: ${path}: ${url}`);
    const [target, anchor] = url.split("#");
    const destination = target
      ? resolve(dirname(path), decodeURIComponent(target))
      : path;
    assert.ok(
      destination.startsWith(site + "/"),
      `Link leaves standalone site: ${url}`
    );
    assert.ok(existsSync(destination), `Missing link: ${path}: ${url}`);
    if (anchor)
      assert.ok(
        pageIds.get(destination)?.includes(decodeURIComponent(anchor)),
        `Missing anchor: ${path}: ${url}`
      );
  }
}
for (const file of ["docs.css", "guide.css", "atlas.css", "roman.css", "reference.css"]) {
  const css = readFileSync(resolve(site, "assets", file), "utf8");
  for (const [, url] of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
    assert.ok(
      existsSync(resolve(site, "assets", url)),
      `Missing CSS asset: ${url}`
    );
  }
}
const ids = pageIds.get(pagePath);
const js = readFileSync(resolve(site, "assets/labs.js"), "utf8");
for (const file of ["docs.js", "guide.js", "reference.js", "vault-diagrams.js", "atlas.js", "labs.js", "map.js"]) {
  new Script(readFileSync(resolve(site, "assets", file), "utf8"));
}

// Exercise the display with a small DOM fixture. Expected amounts are independent
// worked examples, not a second implementation of the settlement formulas.
const elements = Object.fromEntries(
  ids.map((id) => [
    id,
    {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      addEventListener() {},
      setAttribute() {},
    },
  ])
);
const inputCallbacks = {};
for (const id of ["kind", "dep", "strike", "prem", "days", "entryPrice"]) {
  elements[id].addEventListener = (event, callback) => {
    inputCallbacks[id] = callback;
  };
}
Object.entries({
  kind: "call",
  dep: "10",
  strike: "3000",
  prem: "100",
  days: "30",
  entryPrice: "3000",
}).forEach(([id, value]) => (elements[id].value = value));
const attributes = new Map([["data-theme", "dark"]]);
const documentElement = {
  getAttribute: (key) => attributes.get(key),
  setAttribute: (key, value) => attributes.set(key, value),
};
// `window` is self-referential, as in a real browser, so that labs.js's closing
// `window.IvyLabs = {...}` also defines the bare `IvyLabs` global used below.
const sandbox = {
  document: { documentElement, addEventListener() {}, querySelector: () => null },
  scope: { querySelector: (s) => elements[s.replace(/^#/, "")] || null, querySelectorAll: () => [] },
  CSS: { escape: (s) => s },
  localStorage: { getItem: () => null, setItem() {} },
  getComputedStyle: () => ({ getPropertyValue: () => "#888" }),
  addEventListener() {},
  matchMedia: () => ({ matches: true, addEventListener() {} }),
};
sandbox.window = sandbox;
runInNewContext(js + "\nIvyLabs.payoff(scope);", sandbox);
function update(values) {
  for (const [id, value] of Object.entries(values)) elements[id].value = value;
  inputCallbacks.dep();
}
assert.equal(elements.premiumYield.textContent, "3.33%");
assert.equal(elements.premiumApr.textContent, "40.56%");
function resultRows() {
  return [...elements.rows.innerHTML.matchAll(/<tr>(.*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map(([, cell]) => cell.replace(/<[^>]+>/g, ""))
  );
}
const callRows = [
  ["Expired without exercise", "10", "1,000", "pays premium only"],
  ["Fully exercised", "0", "31,000", "pays 30,000 USDC, takes 10 WETH"],
];
assert.deepEqual(resultRows(), callRows);
update({ days: "365", entryPrice: "2000" });
assert.equal(elements.premiumApr.textContent, "5%");
assert.deepEqual(resultRows(), callRows, "Valuation and duration do not change physical token exchanges");
update({ days: "30", entryPrice: "3000" });
assert.equal(elements.notional.textContent, "10 WETH");
assert.equal(elements.premTotal.textContent, "1,000 USDC");
assert.doesNotMatch(elements.calcChart.innerHTML, /NaN|Infinity/);
update({ kind: "put", dep: "30000" });
assert.equal(elements.premiumApr.textContent, "40.56%");
assert.equal(elements.entryPriceField.hidden, true);
update({ entryPrice: "" });
assert.equal(elements.calcError.hidden, true, "Puts do not need a WETH entry price");
assert.deepEqual(resultRows(), [
  ["Expired without exercise", "0", "31,000", "pays premium only"],
  ["Fully exercised", "10", "1,000", "delivers 10 WETH, takes 30,000 USDC"],
]);
for (const invalid of ["", "0", "-1", "NaN"]) {
  update({ strike: invalid });
  assert.equal(elements.calcError.hidden, false);
  assert.equal(elements.strike.ariaInvalid, "true");
  assert.equal(elements.calcError.textContent, "Enter a strike price greater than zero.");
  assert.equal(elements.rows.innerHTML, "");
  assert.equal(elements.calcChart.innerHTML, "");
  assert.equal(elements.notional.textContent, "Unavailable");
}
update({ strike: "3000", prem: "0" });
assert.equal(elements.calcError.hidden, true);
assert.equal(elements.strike.ariaInvalid, "false");
assert.equal(elements.premTotal.textContent, "0 USDC");
assert.deepEqual(resultRows(), [
  ["Expired without exercise", "0", "30,000", "pays premium only"],
  ["Fully exercised", "10", "0", "delivers 10 WETH, takes 30,000 USDC"],
]);
assert.doesNotMatch(elements.calcChart.innerHTML, /NaN|Infinity/);
assert.equal(elements.premiumApr.textContent, "0%");
for (const field of ["days", "entryPrice"]) {
  for (const invalid of ["", "0", "-1", "NaN"]) {
    update({ kind: "call", days: "30", entryPrice: "3000", [field]: invalid });
    assert.equal(elements.calcError.hidden, false);
    assert.equal(elements.premiumApr.textContent, "Unavailable");
  }
}
update({ days: "30", entryPrice: "3000", prem: "100" });
assert.equal(elements.premiumApr.textContent, "40.56%");
console.log(
  `Docs checks passed: ${pages.length} HTML pages, generated content, standalone links, cross-page anchors, assets, JavaScript, call/put examples, invalid inputs and recovery.`
);
