import assert from "node:assert/strict"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { runInNewContext, Script } from "node:vm"

import { buildDocs } from "./build-docs.ts"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pagePath = resolve(root, "docs/site/index.html")
const guidePagePath = resolve(root, "docs/site/guide.html")
const v2PagePath = resolve(root, "docs/site/v2/index.html")
const site = dirname(pagePath)
const generated = buildDocs({ check: true })
// The map (docs/site/index.html?view=map) aliases old deep links to a node id at
// runtime (IvyMap.ALIASES in assets/map.js) rather than exposing them as DOM
// ids, so parse the keys out of that object literal for the anchor check below.
const mapJs = readFileSync(resolve(site, "assets/map.js"), "utf8")
const aliasBlock = mapJs.match(/const ALIASES = \{([\s\S]*?)\n  \};/)
assert.ok(aliasBlock, "Could not find ALIASES block in assets/map.js")
const mapAliasKeys = new Set([...aliasBlock[1].matchAll(/(?:^|[\s,{])(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)].map(match => match[1] ?? match[2]))

// Reference pages are hand-maintained HTML; check every page in the site,
// including the legacy redirect under v2/ (readdirSync below is not
// recursive, so it is listed explicitly).
const pages = [
	...new Set([
		pagePath,
		v2PagePath,
		...generated,
		...readdirSync(site)
			.filter(name => name.endsWith(".html"))
			.map(name => resolve(site, name)),
	]),
]
const pageIds = new Map(
	pages.map(path => {
		const content = readFileSync(path, "utf8")
		const ids = [...content.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
		assert.equal(new Set(ids).size, ids.length, `Duplicate IDs: ${path}`)
		assert.match(content, /<html lang="en"/)
		assert.equal((content.match(/<main\b/g) || []).length, 1, path)
		assert.equal((content.match(/<h1\b/g) || []).length, 1, path)
		return [path, ids]
	}),
)
for (const path of pages) {
	const content = readFileSync(path, "utf8")
	for (const [, url] of content.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
		assert.ok(!/^(?:https?:)?\/\//.test(url), `Page must work offline: ${url}`)
		assert.ok(!/\.md(?:$|#|\?)/i.test(url), `Markdown link: ${path}: ${url}`)
		const [address, anchor] = url.split("#")
		const target = address.split("?")[0]
		const destination = target ? resolve(dirname(path), decodeURIComponent(target)) : path
		assert.ok(destination.startsWith(site + "/"), `Link leaves standalone site: ${url}`)
		assert.ok(existsSync(destination), `Missing link: ${path}: ${url}`)
		if (anchor) {
			const decodedAnchor = decodeURIComponent(anchor)
			// A deep link into the map resolves at runtime through IvyMap.ALIASES
			// (assets/map.js). The index also hosts Guide anchors in its frame;
			// both sets of anchors are valid public destinations.
			const ok =
				pageIds.get(destination)?.includes(decodedAnchor) ||
				([pagePath, v2PagePath].includes(destination) && (mapAliasKeys.has(decodedAnchor) || pageIds.get(guidePagePath)!.includes(decodedAnchor)))
			assert.ok(ok, `Missing anchor: ${path}: ${url}`)
		}
	}
}
for (const file of ["docs.css", "guide.css", "atlas.css", "roman.css", "reference.css", "labs.css", "map.css", "shell.css"]) {
	const css = readFileSync(resolve(site, "assets", file), "utf8")
	for (const [, url] of css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)) {
		assert.ok(existsSync(resolve(site, "assets", url)), `Missing CSS asset: ${url}`)
	}
}
for (const file of ["docs.js", "guide.js", "reference.js", "vault-diagrams.js", "labs.js", "map.js", "shell.js", "embed.js"]) {
	new Script(readFileSync(resolve(site, "assets", file), "utf8"))
}

// Exercise the shared payoff calculator (labs.js, driven through a scoped
// querySelector) against both pages that carry it: the guide and the labs
// fixture. Expected amounts are independent worked examples, not a second
// implementation of the settlement formulas.
/** The few element properties labs.js reads and writes. */
interface FakeElement {
	value: string
	textContent: string
	innerHTML: string
	hidden: boolean
	ariaInvalid?: string
	addEventListener(event: string, callback: () => void): void
	setAttribute(): void
}
type Elements = Record<string, FakeElement>
function makeElements(ids: string[]): Elements {
	return Object.fromEntries(
		ids.map(id => [
			id,
			{
				value: "",
				textContent: "",
				innerHTML: "",
				hidden: false,
				addEventListener() {},
				setAttribute() {},
			},
		]),
	)
}
const CALC_INPUT_IDS = ["kind", "dep", "strike", "prem", "days", "entryPrice"]
const CALC_DEFAULTS = {
	kind: "call",
	dep: "10",
	strike: "3000",
	prem: "100",
	days: "30",
	entryPrice: "3000",
}
function verifyPayoffCalculator(elements: Elements, update: (values: Record<string, string>) => void) {
	assert.equal(elements.premiumYield.textContent, "3.33%")
	assert.equal(elements.premiumApr.textContent, "40.56%")
	function resultRows() {
		return [...elements.rows.innerHTML.matchAll(/<tr>(.*?)<\/tr>/g)].map(([, row]) =>
			[...row.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map(match => match[1].replace(/<[^>]+>/g, "")),
		)
	}
	const callRows = [
		["Expired without exercise", "10", "1,000", "pays premium only"],
		["Fully exercised", "0", "31,000", "pays 30,000 USDC, takes 10 WETH"],
	]
	assert.deepEqual(resultRows(), callRows)
	update({ days: "365", entryPrice: "2000" })
	assert.equal(elements.premiumApr.textContent, "5%")
	assert.deepEqual(resultRows(), callRows, "Valuation and duration do not change physical token exchanges")
	update({ days: "30", entryPrice: "3000" })
	assert.equal(elements.notional.textContent, "10 WETH")
	assert.equal(elements.premTotal.textContent, "1,000 USDC")
	assert.doesNotMatch(elements.calcChart.innerHTML, /NaN|Infinity/)
	update({ kind: "put", dep: "30000" })
	assert.equal(elements.premiumApr.textContent, "40.56%")
	assert.equal(elements.entryPriceField.hidden, true)
	update({ entryPrice: "" })
	assert.equal(elements.calcError.hidden, true, "Puts do not need a WETH entry price")
	assert.deepEqual(resultRows(), [
		["Expired without exercise", "0", "31,000", "pays premium only"],
		["Fully exercised", "10", "1,000", "delivers 10 WETH, takes 30,000 USDC"],
	])
	for (const invalid of ["", "0", "-1", "NaN"]) {
		update({ strike: invalid })
		assert.equal(elements.calcError.hidden, false)
		assert.equal(elements.strike.ariaInvalid, "true")
		assert.equal(elements.calcError.textContent, "Enter a strike price greater than zero.")
		assert.equal(elements.rows.innerHTML, "")
		assert.equal(elements.calcChart.innerHTML, "")
		assert.equal(elements.notional.textContent, "Unavailable")
	}
	update({ strike: "3000", prem: "0" })
	assert.equal(elements.calcError.hidden, true)
	assert.equal(elements.strike.ariaInvalid, "false")
	assert.equal(elements.premTotal.textContent, "0 USDC")
	assert.deepEqual(resultRows(), [
		["Expired without exercise", "0", "30,000", "pays premium only"],
		["Fully exercised", "10", "0", "delivers 10 WETH, takes 30,000 USDC"],
	])
	assert.doesNotMatch(elements.calcChart.innerHTML, /NaN|Infinity/)
	assert.equal(elements.premiumApr.textContent, "0%")
	for (const field of ["days", "entryPrice"]) {
		for (const invalid of ["", "0", "-1", "NaN"]) {
			update({ kind: "call", days: "30", entryPrice: "3000", [field]: invalid })
			assert.equal(elements.calcError.hidden, false)
			assert.equal(elements.premiumApr.textContent, "Unavailable")
		}
	}
	update({ days: "30", entryPrice: "3000", prem: "100" })
	assert.equal(elements.premiumApr.textContent, "40.56%")
}

// labs.js reads inputs through a scoped querySelector (IvyLabs.mountAll
// normally scopes it to one [data-lab] element) and window is
// self-referential, as in a real browser, so its closing `window.IvyLabs =
// {...}` also defines the bare `IvyLabs` global used below. Every id the
// widget reads must exist on the page, or the scoped lookup returns null.
function verifyLabsPayoff(ids: string[]) {
	const elements = makeElements(ids)
	const inputCallbacks: Record<string, () => void> = {}
	for (const id of CALC_INPUT_IDS) {
		elements[id].addEventListener = (_event, callback) => {
			inputCallbacks[id] = callback
		}
	}
	Object.entries(CALC_DEFAULTS).forEach(([id, value]) => (elements[id].value = value))
	const attributes = new Map([["data-theme", "dark"]])
	const documentElement = {
		getAttribute: (key: string) => attributes.get(key),
		setAttribute: (key: string, value: string) => attributes.set(key, value),
	}
	const labsJs = readFileSync(resolve(site, "assets/labs.js"), "utf8")
	const sandbox: Record<string, unknown> = {
		document: { documentElement, addEventListener() {}, querySelector: () => null },
		scope: { querySelector: (s: string) => elements[s.replace(/^#/, "")] || null, querySelectorAll: () => [] },
		CSS: { escape: (s: string) => s },
		MutationObserver: class {
			observe() {}
		},
		localStorage: { getItem: () => null, setItem() {} },
		getComputedStyle: () => ({ getPropertyValue: () => "#888" }),
		addEventListener() {},
		matchMedia: () => ({ matches: true, addEventListener() {} }),
	}
	sandbox.window = sandbox
	runInNewContext(labsJs + "\nIvyLabs.payoff(scope);", sandbox)
	verifyPayoffCalculator(elements, values => {
		for (const [id, value] of Object.entries(values)) elements[id].value = value
		inputCallbacks.dep()
	})
}
verifyLabsPayoff(pageIds.get(guidePagePath)!)
assert.match(readFileSync(guidePagePath, "utf8"), /class="calc" data-lab="payoff"/, "The guide mounts the shared payoff lab")
{
	const fixture = readFileSync(resolve(site, "test/fixtures/labs.html"), "utf8")
	verifyLabsPayoff([...fixture.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]))
}

console.log(
	`Docs checks passed: ${pages.length} HTML pages, generated content, standalone links, cross-page anchors, assets, JavaScript, the shared payoff calculator on both pages, invalid inputs and recovery.`,
)
