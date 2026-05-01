// Pure data → graphology Graph conversion. Split out from
// knowledge-base-graph.js so it can be unit-tested in Node (sigma's main
// entry references WebGL2RenderingContext at load time, so it can't be
// imported under `node --test`).
import Graph from "graphology";

const DEFAULT_NODE_COLOR = "rgba(190, 210, 245, 0.95)";
const DEFAULT_NODE_BRIGHT = "rgba(220, 235, 255, 1)";
const DEFAULT_EDGE_COLOR = "rgba(255, 255, 255, 0.18)";
const DEFAULT_EDGE_BRIGHT = "rgba(190, 220, 255, 0.7)";

// Force the color's alpha up to at least `floor`. The original SVG palette
// drew dim fills (alpha ~0.6) intentionally, paired with a bright stroke
// ring. WebGL has no stroke, so dim fills come out near-invisible against a
// dark background. We brighten them by lifting alpha — preserves the hue +
// saturation, just renders at full visibility.
export function liftAlpha(color, floor = 0.92) {
  const value = String(color || "").trim();
  if (!value) return color;
  // rgba(R, G, B, A)
  const rgba = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgba) {
    const r = rgba[1];
    const g = rgba[2];
    const b = rgba[3];
    const a = rgba[4] === undefined ? 1 : Number(rgba[4]);
    const next = Math.max(a, floor);
    return `rgba(${r}, ${g}, ${b}, ${next})`;
  }
  // hsla(H, S%, L%, A) — same idea
  const hsla = value.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+%)\s*,\s*([\d.]+%)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (hsla) {
    const h = hsla[1];
    const s = hsla[2];
    const l = hsla[3];
    const a = hsla[4] === undefined ? 1 : Number(hsla[4]);
    const next = Math.max(a, floor);
    return `hsla(${h}, ${s}, ${l}, ${next})`;
  }
  return value;
}

export function buildKnowledgeBaseGraph(nodes, edges) {
  const graph = new Graph({ multi: false, allowSelfLoops: false, type: "undirected" });

  // Initial positions. Re-use whatever positions main.js seeded so the
  // group-anchored unfold animation has a sensible starting layout, and fall
  // back to a unit-radius spiral for nodes with missing positions.
  const fallbackRadius = 100;
  const list = Array.isArray(nodes) ? nodes : [];
  list.forEach((node, index) => {
    if (!node || !node.relativePath) return;
    const seedAngle = (index / Math.max(list.length, 1)) * Math.PI * 2;
    const x = Number.isFinite(node.x) ? node.x : Math.cos(seedAngle) * fallbackRadius;
    const y = Number.isFinite(node.y) ? node.y : Math.sin(seedAngle) * fallbackRadius;
    // Use the brighter "connected" variant of the palette as the base render
    // color. The dimmer `fill` was meant to be paired with a CSS stroke ring,
    // which sigma's WebGL renderer doesn't draw — so without lifting it the
    // node would fade into a dark background.
    const baseColor = liftAlpha(node.color?.connectedFill || node.color?.fill || DEFAULT_NODE_COLOR);
    const brightColor = liftAlpha(node.color?.connectedFill || node.color?.fill || DEFAULT_NODE_BRIGHT, 1);
    graph.addNode(node.relativePath, {
      x,
      y,
      // sigma sizes are pixel-radii. The previous SVG model used radii ~8-22;
      // halving lands sigma in the same visual neighborhood.
      size: Math.max(3, (Number(node.radius) || 12) / 2),
      label: node.title || node.relativePath || "",
      title: node.title || node.relativePath || "",
      groupKey: node.groupKey || "",
      color: baseColor,
      connectedColor: brightColor,
      labelColor: node.color?.label || "rgba(232, 236, 240, 0.95)",
    });
  });

  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge?.source || !edge?.target) continue;
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    if (edge.source === edge.target) continue;
    if (graph.hasEdge(edge.source, edge.target)) continue;
    graph.addEdge(edge.source, edge.target, {
      size: 0.6,
      color: edge.edgeColor || DEFAULT_EDGE_COLOR,
      connectedColor: edge.connectedColor || DEFAULT_EDGE_BRIGHT,
    });
  }

  return graph;
}
