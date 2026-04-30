// Unit tests for the data-mapping helper that converts main.js's
// `state.knowledgeBase.graphLayout` shape into a graphology Graph for sigma.
// The pure-data layer lives in knowledge-base-graph-data.js so it can be
// imported under `node --test` (the renderer module imports sigma, which
// touches WebGL2RenderingContext at load time and can't run in Node).

import assert from "node:assert/strict";
import test from "node:test";

import { buildKnowledgeBaseGraph as buildGraph } from "../src/client/knowledge-base-graph-data.js";

const colorOf = (path) => ({
  fill: `${path}-fill`,
  connectedFill: `${path}-connected`,
  label: `${path}-label`,
});

test("buildGraph adds every node with the expected attributes", () => {
  const nodes = [
    { relativePath: "a.md", title: "A", radius: 14, x: 10, y: -5, groupKey: "g1", color: colorOf("a") },
    { relativePath: "b.md", title: "B", radius: 9, x: 0, y: 7, groupKey: "g2", color: colorOf("b") },
  ];
  const graph = buildGraph(nodes, []);

  assert.equal(graph.order, 2);
  assert.deepEqual([...graph.nodes()].sort(), ["a.md", "b.md"]);

  const a = graph.getNodeAttributes("a.md");
  assert.equal(a.x, 10);
  assert.equal(a.y, -5);
  assert.equal(a.title, "A");
  assert.equal(a.label, "A");
  assert.equal(a.color, "a-fill");
  assert.equal(a.connectedColor, "a-connected");
  assert.equal(a.groupKey, "g1");
  // size is roughly half the radius (sigma units), with a floor.
  assert.ok(a.size >= 3 && a.size <= 14, `size out of range: ${a.size}`);
});

test("buildGraph seeds positions for nodes missing x/y", () => {
  const nodes = [
    { relativePath: "a.md", title: "A", radius: 12 },
    { relativePath: "b.md", title: "B", radius: 12 },
    { relativePath: "c.md", title: "C", radius: 12 },
  ];
  const graph = buildGraph(nodes, []);
  for (const key of graph.nodes()) {
    const attrs = graph.getNodeAttributes(key);
    assert.ok(Number.isFinite(attrs.x), `missing x on ${key}`);
    assert.ok(Number.isFinite(attrs.y), `missing y on ${key}`);
  }
  // Seeded positions should not all collapse to the same point.
  const xs = [...graph.nodes()].map((k) => graph.getNodeAttribute(k, "x"));
  assert.ok(new Set(xs).size > 1, "seeded x positions must vary");
});

test("buildGraph adds undirected edges and dedupes parallels", () => {
  const nodes = [
    { relativePath: "a.md", title: "A" },
    { relativePath: "b.md", title: "B" },
  ];
  const edges = [
    { source: "a.md", target: "b.md", edgeColor: "rgb(1,2,3)" },
    { source: "b.md", target: "a.md", edgeColor: "ignored-duplicate" },
    { source: "a.md", target: "a.md" }, // self-loop, must be dropped
    { source: "a.md", target: "missing.md" }, // unknown endpoint, must be dropped
  ];
  const graph = buildGraph(nodes, edges);
  assert.equal(graph.size, 1);
  const edgeKey = [...graph.edges()][0];
  const attrs = graph.getEdgeAttributes(edgeKey);
  assert.equal(attrs.color, "rgb(1,2,3)");
});

test("buildGraph drops edges whose endpoints aren't in the node set", () => {
  const graph = buildGraph(
    [{ relativePath: "x.md", title: "X" }],
    [{ source: "x.md", target: "y.md" }],
  );
  assert.equal(graph.size, 0);
});

test("buildGraph tolerates an empty input", () => {
  const graph = buildGraph([], []);
  assert.equal(graph.order, 0);
  assert.equal(graph.size, 0);
});
