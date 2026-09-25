import { Marked, Renderer } from "marked"
import type { Tokens } from "marked"
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve, dirname, basename, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const site = resolve(root, "docs/site")
const pages = [
	{ source: "docs/frontend-integration.md", output: "frontend-integration.html", title: "Frontend integration" },
	{ source: "LICENSE.md", output: "license.html", title: "Business Source License 1.1" },
	{ source: "README.md", output: "project-setup.html", title: "Project setup" },
]
const destinations = new Map<string, string>(pages.map(page => [resolve(root, page.source), page.output]))
destinations.set(resolve(root, "docs/site/index.html"), "index.html")
const escape = (text: unknown) =>
	String(text).replace(
		/[&<>"']/g,
		char => (({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }) as Record<string, string>)[char],
	)
const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/<[^>]*>/g, "")
		.replace(/&[^;]+;/g, "")
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.trim()
		.replace(/\s/g, "-")

export function buildDocs({ check = false } = {}) {
	const outputs = new Map<string, string>()
	const rawSources = ["contracts/examples/ExampleSettlementPublisher.sol", "contracts/interfaces/IIvySettlementPricePublication.sol"]
	for (const source of rawSources) {
		const target = `assets/source/${basename(source)}`
		destinations.set(resolve(root, source), target)
		outputs.set(target, readFileSync(resolve(root, source), "utf8"))
	}
	for (const page of pages) {
		const source = readFileSync(resolve(root, page.source), "utf8")
		const headings: { id: string; content: string; depth: number }[] = []
		const usedIds = new Map<string, number>()
		const renderer = new Renderer()
		renderer.heading = function ({ tokens, depth }) {
			const content = this.parser.parseInline(tokens)
			const base = slug(content)
			const count = usedIds.get(base) || 0
			usedIds.set(base, count + 1)
			const id = count ? `${base}-${count}` : base
			if (depth === 2 || depth === 3) headings.push({ id, content, depth })
			return `<h${depth} id="${id}">${depth === 1 ? escape(page.title) : content}</h${depth}>\n`
		}
		renderer.link = function ({ href, title, tokens }) {
			const [path, anchor] = href.split("#")
			let target = href
			if (path && !/^[a-z]+:/i.test(path)) {
				const absolute = resolve(root, dirname(page.source), decodeURIComponent(path))
				// Reference pages live in docs/site and are edited there directly.
				const mapped =
					destinations.get(absolute) ?? (absolute.startsWith(site + "/") && absolute.endsWith(".html") ? relative(site, absolute) : undefined)
				if (!mapped) throw new Error(`No site destination for ${page.source}: ${href}`)
				target = mapped + (anchor ? `#${anchor}` : "")
			}
			if (/\.md(?:$|#|\?)/i.test(target)) throw new Error(`Markdown link in site: ${target}`)
			const download = /\.(json|sol)$/.test(target) ? " download" : ""
			return `<a href="${escape(target)}"${title ? ` title="${escape(title)}"` : ""}${download}>${this.parser.parseInline(tokens)}</a>`
		}
		const defaultTable = renderer.table
		renderer.table = function (token: Tokens.Table) {
			return `<div class="tablewrap" tabindex="0" role="region" aria-label="${escape(
				page.title,
			)} reference table">${defaultTable.call(this, token)}</div>\n`
		}
		const body = new Marked({ renderer, gfm: true }).parse(source)
		const navigation = headings
			.map(heading => `<a href="#${heading.id}"${heading.depth === 3 ? ' class="subsection-link"' : ""}>${heading.content}</a>`)
			.join("\n")
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
  <script src="assets/embed.js"></script>
</head>
<body>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="topbar"><a class="brand" href="index.html" aria-label="Ivy Vaults protocol guide"><img src="assets/ivy-logo.png" alt="" width="23" height="34">Ivy <span>Vaults</span></a><span class="breadcrumb">Documentation / ${escape(
		page.title,
	)}</span><button class="theme" id="themeToggle" type="button" aria-label="Switch colour theme">Theme</button></header>
  <aside class="rail"><a class="back-guide" href="index.html">← Protocol guide</a>${
		navigation ? `<details id="contents" open><summary>In this document</summary><nav aria-label="Page sections">${navigation}</nav></details>` : ""
	}</aside>
  <main id="content" class="content doc-page" tabindex="-1"><article>${body}</article></main>
  <footer><a href="index.html">Ivy Vaults · Protocol guide</a> · <a href="license.html">License · BUSL-1.1</a></footer>
</body>
</html>
`,
		)
	}
	for (const [name, contents] of outputs) {
		const target = resolve(site, name)
		if (check) {
			if (!existsSync(target) || readFileSync(target, "utf8") !== contents)
				throw new Error(`Stale or missing ${relative(root, target)}. Run npm run docs:build.`)
		} else {
			mkdirSync(dirname(target), { recursive: true })
			writeFileSync(target, contents)
		}
	}
	return pages.map(page => resolve(site, page.output))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes("--check")
	const generated = buildDocs({ check })
	console.log(`${check ? "Verified" : "Built"} ${generated.length} generated HTML pages and their local downloads.`)
}
