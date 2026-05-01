// Pure data → graphology Graph conversion. Split out from
// knowledge-base-graph.js so it can be unit-tested in Node (sigma's main
// entry references WebGL2RenderingContext at load time, so it can't be
// imported under `node --test`).
import Graph from "graphology";

const DEFAULT_NODE_COLOR = "rgba(190, 210, 245, 0.95)";
const DEFAULT_NODE_BRIGHT = "rgba(220, 235, 255, 1)";
const DEFAULT_EDGE_COLOR = "rgba(255, 255, 255, 0.18)";
const DEFAULT_EDGE_BRIGHT = "rgba(190, 220, 255, 0.7)";

const HSL_TO_RGB = (h, s, l) => {
  const sNorm = s / 100;
  const lNorm = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sNorm * Math.min(lNorm, 1 - lNorm);
  const f = (n) => lNorm - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [
    Math.round(f(0) * 255),
    Math.round(f(8) * 255),
    Math.round(f(4) * 255),
  ];
};

const HEX3_RE = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGBA_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i;
const HSLA_RE = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%(?:\s*,\s*([\d.]+))?\s*\)$/i;

// Parse any common CSS color string into {r, g, b, a} components, or null if
// unrecognized. Sigma's WebGL parser only understands rgb/rgba/hex/named
// colors — NOT hsla — so anything we feed it must be normalized first or
// project-group nodes silently render as pure black.
export function parseColor(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;

  let m;
  if ((m = text.match(HEX8_RE))) {
    return {
      r: parseInt(m[1], 16),
      g: parseInt(m[2], 16),
      b: parseInt(m[3], 16),
      a: parseInt(m[4], 16) / 255,
    };
  }
  if ((m = text.match(HEX6_RE))) {
    return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16), a: 1 };
  }
  if ((m = text.match(HEX3_RE))) {
    return {
      r: parseInt(m[1] + m[1], 16),
      g: parseInt(m[2] + m[2], 16),
      b: parseInt(m[3] + m[3], 16),
      a: 1,
    };
  }
  if ((m = text.match(RGBA_RE))) {
    return {
      r: Math.max(0, Math.min(255, Math.round(Number(m[1])))),
      g: Math.max(0, Math.min(255, Math.round(Number(m[2])))),
      b: Math.max(0, Math.min(255, Math.round(Number(m[3])))),
      a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4]))),
    };
  }
  if ((m = text.match(HSLA_RE))) {
    const [r, g, b] = HSL_TO_RGB(Number(m[1]) % 360, Number(m[2]), Number(m[3]));
    return {
      r,
      g,
      b,
      a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4]))),
    };
  }
  return null;
}

// Normalize any input color into an `rgba(r, g, b, a)` string that sigma's
// WebGL parser is guaranteed to accept. Lifts alpha to `alphaFloor` so dim
// fills (originally meant to be paired with a CSS stroke ring) don't render
// near-invisible against a dark background.
export function normalizeColor(value, alphaFloor = 0.92) {
  const parsed = parseColor(value);
  if (!parsed) return value; // pass through; sigma will fall back if it can't parse
  const a = Math.max(parsed.a, alphaFloor);
  return `rgba(${parsed.r}, ${parsed.g}, ${parsed.b}, ${a})`;
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
    // color. The dimmer `fill` was meant to be paired with a CSS stroke ring
    // which sigma's WebGL renderer doesn't draw — so without lifting it the
    // node would fade into a dark background. We also normalize hsla inputs
    // to rgba because sigma's parseColor doesn't recognize hsla and silently
    // returns black for it.
    const baseInput = node.color?.connectedFill || node.color?.fill || DEFAULT_NODE_COLOR;
    const brightInput = node.color?.connectedFill || node.color?.fill || DEFAULT_NODE_BRIGHT;
    graph.addNode(node.relativePath, {
      x,
      y,
      // sigma sizes are pixel-radii. The previous SVG model used radii ~8-22;
      // halving lands sigma in the same visual neighborhood.
      size: Math.max(3, (Number(node.radius) || 12) / 2),
      label: node.title || node.relativePath || "",
      title: node.title || node.relativePath || "",
      groupKey: node.groupKey || "",
      color: normalizeColor(baseInput, 0.92),
      connectedColor: normalizeColor(brightInput, 1),
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
      color: normalizeColor(edge.edgeColor || DEFAULT_EDGE_COLOR, 0.18),
      connectedColor: normalizeColor(edge.connectedColor || DEFAULT_EDGE_BRIGHT, 0.7),
    });
  }

  return graph;
}

// Backward-compat re-export. Previous tests imported `liftAlpha`; the new
// `normalizeColor` subsumes its behavior.
export { normalizeColor as liftAlpha };
