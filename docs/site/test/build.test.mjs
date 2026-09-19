import { test } from "node:test";
import assert from "node:assert/strict";
import { Marked } from "marked";
import { buildAction } from "../../../scripts/build-docs.mjs";

// buildAction turns the Markdown blocks under a README H2 into tile
// sections. A heading block landing among those blocks (e.g. an H3 the
// README author added inside a section) would render as an <h3> direct
// child of the tile <section>, alongside the tile's own <h5> title; map.js's
// readDocument (bodyOf) filters heading children out of a node's body, so
// that heading text would stay visible in the reading view but silently
// vanish from the map card, with nothing failing. buildAction now throws a
// clear build-time error instead.
function blocksOf(markdown) {
  return new Marked({ gfm: true }).lexer(markdown).filter((t) => t.type !== "space");
}
const render = (tokens) => new Marked({ gfm: true }).parser(tokens);

test("buildAction throws when a README heading would be silently dropped from a tile", () => {
  const blocks = blocksOf("Summary paragraph.\n\n### A stray heading\n\nMore text.\n");
  const shell = { id: "some-action", title: "Some action" };
  assert.throws(
    () => buildAction(shell, { title: "Some action", blocks }, render),
    /Heading "A stray heading" inside generated section #some-action/
  );
});

test("buildAction renders ordinary blocks (paragraph summary, list, code) without a heading", () => {
  const blocks = blocksOf("Summary paragraph.\n\n- one\n- two\n\n```\ncode\n```\n");
  const shell = { id: "some-action", title: "Some action" };
  const html = buildAction(shell, { title: "Some action", blocks }, render);
  assert.match(html, /<section data-kind="action" id="some-action">/);
  assert.match(html, /<p>Summary paragraph\.<\/p>/);
  assert.match(html, /data-kind="tile"/);
  assert.doesNotMatch(html, /<h3|<h4>[^<]*<\/h4><h4/); // no stray heading tile title leaked through
});
