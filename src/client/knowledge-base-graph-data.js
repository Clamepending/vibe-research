// Pure data → graphology Graph conversion. Split out from
// knowledge-base-graph.js so it can be unit-tested in Node (sigma's main
// entry references WebGL2RenderingContext at load time, so it can't be
// imported under `node --test`).
import Graph from "graphology";

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
    graph.addNode(node.relativePath, {
      x,
      y,
      // sigma sizes are pixel-radii. The previous SVG model used radii ~8-22;
      // halving lands sigma in the same visual neighborhood.
      size: Math.max(3, (Number(node.radius) || 12) / 2),
      label: node.title || node.relativePath || "",
      title: node.title || node.relativePath || "",
      groupKey: node.groupKey || "",
      // Carry both base and connected-state colors so the reducer can swap on
      // selection/hover without rebuilding the graph.
      color: node.color?.fill || "rgba(180, 200, 240, 0.85)",
      connectedColor: node.color?.connectedFill || "rgba(180, 220, 255, 1)",
      labelColor: node.color?.label || "rgba(232, 236, 240, 0.9)",
    });
  });

  for (const edge of Array.isArray(edges) ? edges : []) {
    if (!edge?.source || !edge?.target) continue;
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    if (edge.source === edge.target) continue;
    if (graph.hasEdge(edge.source, edge.target)) continue;
    graph.addEdge(edge.source, edge.target, {
      size: 0.6,
      color: edge.edgeColor || "rgba(255, 255, 255, 0.18)",
      connectedColor: edge.connectedColor || "rgba(180, 220, 255, 0.55)",
    });
  }

  return graph;
}
