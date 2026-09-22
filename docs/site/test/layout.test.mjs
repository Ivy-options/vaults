import { test } from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./_server.mjs";
import { openPage } from "./_browser.mjs";

test("recursive branches give every node space and connect siblings to their actual parent", async () => {
  const server = await startServer();
  const { page, errors, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    const out = await page.evaluate(() => {
      const doc = document.querySelector('#document');
      const branch = document.createElement('section');
      branch.dataset.kind = 'tile'; branch.id = 'deep-branch';
      branch.innerHTML = '<h5>Nested detail</h5><p>A definition.</p><section data-kind="tile" id="deeper"><h5>Example</h5><p>A worked example.</p></section>';
      doc.querySelector('#who-may-deposit').append(branch);
      const { nodes } = IvyMap.readDocument(doc);
      const world = IvyMap.layoutWorld(nodes, n => n.id === 'deep-branch' ? 440 : 180);
      return { world, nodes: nodes.map(n => ({id:n.id, parent:n.parent?.id, x:n.x,y:n.y,w:n.w,h:n.h,depth:n.depth})) };
    });
    assert.ok(Number.isFinite(out.world.width) && Number.isFinite(out.world.height));
    for (const node of out.nodes) {
      assert.ok([node.x,node.y,node.w,node.h].every(Number.isFinite), node.id);
      assert.ok(node.x >= 0 && node.y >= 0 && node.x + node.w <= out.world.width && node.y + node.h <= out.world.height, node.id);
      if (node.parent) assert.equal(out.world.lines.filter(l => l.from === node.parent && l.to === node.id).length, 1, node.id);
      for (const other of out.nodes) {
        if (node.id === other.id) continue;
        assert.ok(node.x + node.w <= other.x || other.x + other.w <= node.x || node.y + node.h <= other.y || other.y + other.h <= node.y, `${node.id} overlaps ${other.id}`);
      }
    }
    assert.equal(out.nodes.find(n => n.id === 'deeper').depth, 5);
    assert.deepEqual(errors, []);
  } finally { await close(); await server.close(); }
});

test("empty stages and multiple top-level stages retain finite, disjoint bounds", async () => {
  const server = await startServer();
  const { page, close } = await openPage(server.url + "test/fixtures/tree.html");
  try {
    const nodes = await page.evaluate(() => {
      const root = document.createElement('div');
      root.innerHTML = '<section data-kind="station" id="empty"><h2>Empty</h2></section><section data-kind="station" id="next"><h2>Next</h2><section data-kind="moment" id="topic"><h3>Topic</h3></section></section>';
      const {nodes} = IvyMap.readDocument(root); IvyMap.layoutWorld(nodes, () => 180);
      return nodes.map(n => ({id:n.id,x:n.x,y:n.y,w:n.w,h:n.h,column:n.column}));
    });
    assert.ok(nodes.every(n => [n.x,n.y,n.w,n.h].every(Number.isFinite)));
    assert.ok(nodes[0].column.x + nodes[0].column.w <= nodes[1].column.x);
  } finally { await close(); await server.close(); }
});
