import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext, Script } from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagePath = resolve(root, "docs/site/index.html");
const html = readFileSync(pagePath, "utf8");
const css = readFileSync(resolve(root, "docs/site/assets/docs.css"), "utf8");
const js = readFileSync(resolve(root, "docs/site/assets/docs.js"), "utf8");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(new Set(ids).size, ids.length, "Duplicate page IDs");
assert.match(html, /<html lang="en"/);
assert.equal((html.match(/<main\b/g) || []).length, 1);
assert.equal((html.match(/<h1\b/g) || []).length, 1);
for (const [, url] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
  assert.ok(!/^https?:/.test(url), `Page must work offline: ${url}`);
  const [path, anchor] = url.split("#");
  if (path)
    assert.ok(
      existsSync(resolve(dirname(pagePath), path)),
      `Missing link: ${url}`
    );
  if (!path && anchor)
    assert.ok(ids.includes(anchor), `Missing anchor: ${url}`);
}
for (const [, url] of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
  assert.ok(
    existsSync(resolve(dirname(pagePath), "assets", url)),
    `Missing CSS asset: ${url}`
  );
}
new Script(js);

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
runInNewContext(js, {
  document: {
    documentElement,
    getElementById: (id) => elements[id],
    querySelectorAll: () => [],
  },
  window: {
    addEventListener() {},
    matchMedia: () => ({ matches: true, addEventListener() {} }),
  },
  localStorage: { getItem: () => null, setItem() {} },
  getComputedStyle: () => ({ getPropertyValue: () => "#888" }),
});
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
  assert.equal(elements.rows.innerHTML, "");
  assert.equal(elements.calcChart.innerHTML, "");
  assert.equal(elements.notional.textContent, "Unavailable");
}
update({ strike: "3000", prem: "0" });
assert.equal(elements.calcError.hidden, true);
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
  "Docs checks passed: local links, anchors, assets, JavaScript, call/put examples, invalid inputs and recovery."
);
