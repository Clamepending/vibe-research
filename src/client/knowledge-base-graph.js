// WebGL renderer for the Library graph view.
//
// Layout is a live d3-force simulation rendered through sigma. The animation
// IS the physics: nodes start at scattered initial positions, glide toward
// equilibrium under springs (link force) + inverse-square repulsion
// (many-body) + collision (no-overlap) + soft center gravity, and the
// simulation cools to rest via d3's alpha decay. This matches Obsidian's
// graph view, which originally used d3-force directly and still uses the
// same conventions (velocityDecay ~0.4, alphaDecay ~0.0228) in its current
// custom implementation.
//
// We intentionally do NOT do BFS-reveal, scale tweens, or any non-physics
// "pop-in" animation. The Obsidian feel comes from velocity-Verlet
// integration on the actual force system, not from CSS-style easing on top
// of a settled layout.
//
// main.js owns `state.knowledgeBase.graphLayout` and feeds it via setData;
// this module just runs the simulation and renders.

import Graph from "graphology";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
} from "d3-force";
import Sigma from "sigma";
import { buildKnowledgeBaseGraph } from "./knowledge-base-graph-data.js";

export function createKnowledgeBaseGraphRenderer(container, options = {}) {
  if (!(container instanceof HTMLElement)) {
    throw new Error("createKnowledgeBaseGraphRenderer: container must be an HTMLElement");
  }

  const handlers = {
    onNodeClick: typeof options.onNodeClick === "function" ? options.onNodeClick : () => {},
    onNodeHover: typeof options.onNodeHover === "function" ? options.onNodeHover : () => {},
    onSurfaceClick: typeof options.onSurfaceClick === "function" ? options.onSurfaceClick : () => {},
  };

  let graph = new Graph({ multi: false, allowSelfLoops: false, type: "undirected" });
  let sigma = null;
  let selectedKey = "";
  let connectedKeys = new Set();
  let hoveredKey = "";
  let dragging = null;
  let labelsAlwaysVisibleThreshold = 26;

  // d3-force state. d3Nodes is the source of truth for positions; on every
  // tick we mirror x/y into graphology so sigma renders them.
  let simulation = null;
  let d3Nodes = [];
  let d3NodeById = new Map();
  let d3Links = [];
  let hasStartedSimulation = false;
  let cameraFitOnEnd = false;

  function recomputeConnected() {
    connectedKeys = new Set();
    if (selectedKey && graph.hasNode(selectedKey)) {
      connectedKeys.add(selectedKey);
      for (const neighbor of graph.neighbors(selectedKey)) {
        connectedKeys.add(neighbor);
      }
    }
    if (hoveredKey && graph.hasNode(hoveredKey)) {
      connectedKeys.add(hoveredKey);
      for (const neighbor of graph.neighbors(hoveredKey)) {
        connectedKeys.add(neighbor);
      }
    }
  }

  function nodeReducer(key, attrs) {
    const isSelected = key === selectedKey;
    const isHovered = key === hoveredKey;
    const isConnected = connectedKeys.has(key);
    const totalNodes = graph.order;
    const labelAlwaysOn = totalNodes <= labelsAlwaysVisibleThreshold;
    // Labels: only the directly active node(s) get a label by default, even
    // when "connected" highlighting is on. Showing labels for the entire
    // 1-hop neighbourhood floods the canvas at hub nodes.
    const showLabel = labelAlwaysOn || isSelected || isHovered;
    const baseSize = Number(attrs.size) || 5;
    const size = isSelected ? baseSize * 1.55 : isHovered ? baseSize * 1.3 : isConnected ? baseSize * 1.12 : baseSize;
    return {
      ...attrs,
      label: showLabel ? attrs.title : "",
      color: isSelected || isHovered || isConnected ? attrs.connectedColor : attrs.color,
      size,
      zIndex: isSelected ? 3 : isHovered ? 2 : isConnected ? 1 : 0,
      forceLabel: isSelected || isHovered,
    };
  }

  function edgeReducer(key, attrs) {
    const [source, target] = graph.extremities(key);
    const touchesActive =
      source === selectedKey || target === selectedKey || source === hoveredKey || target === hoveredKey;
    return {
      ...attrs,
      color: touchesActive ? attrs.connectedColor : attrs.color,
      size: touchesActive ? (attrs.size || 0.6) * 2.2 : attrs.size || 0.6,
      zIndex: touchesActive ? 1 : 0,
    };
  }

  function ensureSigma() {
    if (sigma) return sigma;
    sigma = new Sigma(graph, container, {
      nodeReducer,
      edgeReducer,
      renderEdgeLabels: false,
      enableEdgeEvents: false,
      defaultEdgeColor: "rgba(255, 255, 255, 0.16)",
      defaultNodeColor: "rgba(180, 200, 240, 0.85)",
      labelColor: { color: "rgba(232, 236, 240, 0.95)" },
      labelSize: 11,
      labelWeight: "500",
      labelDensity: 0.6,
      labelGridCellSize: 130,
      labelRenderedSizeThreshold: 6,
      zIndex: true,
      allowInvalidContainer: false,
    });

    sigma.on("clickNode", ({ node }) => {
      if (dragging?.moved) return; // suppress click after drag
      handlers.onNodeClick(node);
    });
    sigma.on("clickStage", () => {
      handlers.onSurfaceClick();
    });
    sigma.on("enterNode", ({ node }) => {
      hoveredKey = node;
      recomputeConnected();
      handlers.onNodeHover(node);
      sigma.refresh({ skipIndexation: true });
    });
    sigma.on("leaveNode", () => {
      hoveredKey = "";
      recomputeConnected();
      handlers.onNodeHover(null);
      sigma.refresh({ skipIndexation: true });
    });

    // Drag = pin a node via d3's fx/fy and keep the simulation warm so the
    // rest of the graph reacts in real time (the live-physics drag feel).
    sigma.on("downNode", ({ node, event }) => {
      const d3Node = d3NodeById.get(node);
      if (!d3Node) return;
      dragging = { key: node, node: d3Node, moved: false };
      d3Node.fx = d3Node.x;
      d3Node.fy = d3Node.y;
      simulation?.alphaTarget(0.3).restart();
      event.preventSigmaDefault?.();
    });

    const onMove = (rawEvent) => {
      if (!dragging || !sigma) return;
      const point = sigma.viewportToGraph({ x: rawEvent.x, y: rawEvent.y });
      dragging.node.fx = point.x;
      dragging.node.fy = point.y;
      dragging.moved = true;
      // Prevent sigma's default camera pan during a node drag — without
      // these three calls, mousemovebody also moves the viewport, so the
      // user feels like the whole map slides while they drag a node.
      rawEvent.preventSigmaDefault?.();
      rawEvent.original?.preventDefault?.();
      rawEvent.original?.stopPropagation?.();
    };
    const onUp = () => {
      if (!dragging) return;
      const node = dragging.node;
      node.fx = null;
      node.fy = null;
      simulation?.alphaTarget(0);
      dragging = null;
    };
    sigma.getMouseCaptor().on("mousemovebody", onMove);
    sigma.getMouseCaptor().on("mouseup", onUp);
    sigma.getMouseCaptor().on("mouseleave", onUp);

    return sigma;
  }

  // Spread nodes around a circle whose radius scales with sqrt(N) so the
  // simulation has room to settle without crushing everything together at
  // the origin. Density stays roughly constant as the graph grows.
  function spreadInitialPositions(nodes) {
    // Tight spread — enough room for the simulation to find structure,
    // but close enough to the eventual equilibrium that orphan nodes
    // aren't stranded out at the perimeter waiting for a weak gravity
    // to drag them home.
    const radius = 50 * Math.sqrt(Math.max(4, nodes.length));
    for (const node of nodes) {
      const angle = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      node.x = Math.cos(angle) * r;
      node.y = Math.sin(angle) * r;
      node.vx = 0;
      node.vy = 0;
    }
  }

  function buildD3Inputs({ spread } = {}) {
    const previousById = d3NodeById;
    d3NodeById = new Map();
    d3Nodes = [];
    graph.forEachNode((key, attrs) => {
      // Preserve positions across re-renders: if we've simulated this node
      // before, keep its current x/y/velocity so the layout doesn't snap
      // back to the spiral seed every time main.js calls setData.
      const previous = previousById.get(key);
      const node = {
        id: key,
        x: previous ? previous.x : Number.isFinite(attrs.x) ? attrs.x : 0,
        y: previous ? previous.y : Number.isFinite(attrs.y) ? attrs.y : 0,
        vx: previous?.vx ?? 0,
        vy: previous?.vy ?? 0,
        radius: Number(attrs.size) || 5,
      };
      d3Nodes.push(node);
      d3NodeById.set(key, node);
    });
    if (spread) spreadInitialPositions(d3Nodes);
    d3Links = [];
    graph.forEachEdge((_key, _attrs, source, target) => {
      d3Links.push({ source, target });
    });
  }

  function onSimulationTick() {
    for (const node of d3Nodes) {
      if (graph.hasNode(node.id)) {
        graph.setNodeAttribute(node.id, "x", node.x);
        graph.setNodeAttribute(node.id, "y", node.y);
      }
    }
    sigma?.refresh({ skipIndexation: true });
  }

  function onSimulationEnd() {
    if (cameraFitOnEnd) {
      cameraFitOnEnd = false;
      // Recompute the graph extent (skipped during ticks for performance)
      // before resetting the camera, so animatedReset's "fit to graph"
      // sees the settled positions instead of the stale initial extent.
      sigma?.refresh({ skipIndexation: false });
      sigma?.getCamera().animatedReset({ duration: 350 });
    }
  }

  function ensureSimulation() {
    if (simulation) return simulation;
    simulation = forceSimulation()
      // Cooling: alphaDecay 0.025 cools to alphaMin (0.001) in ~275 ticks
      // (~4.5s @ 60fps). velocityDecay 0.35 leaves slightly more glide than
      // d3's default 0.4 so the motion reads as physics rather than as
      // viscous goo.
      .alphaDecay(0.025)
      .velocityDecay(0.35)
      .alpha(0)
      .stop();
    simulation.on("tick", onSimulationTick);
    simulation.on("end", onSimulationEnd);
    return simulation;
  }

  function applyForces() {
    ensureSimulation();
    simulation.nodes(d3Nodes);

    // Pre-compute degrees so the link force can weaken its pull from the
    // hub side (otherwise every leaf has a full-strength rope tugging it
    // straight onto the hub, the hub has only one rope back, and you get
    // the smashed-leaves-on-hub look instead of an open flower).
    const degree = new Map();
    graph.forEachNode((key) => {
      degree.set(key, graph.degree(key));
    });

    const linkForce = forceLink(d3Links)
      .id((n) => n.id)
      // Distance scales with both endpoints' radii so a fat hub keeps its
      // satellites pushed out beyond its own visual edge.
      .distance((link) => 30 + (link.source.radius || 5) + (link.target.radius || 5))
      // Outbound-attraction-distribution: link strength = 1 / min(degree).
      // Leaf-to-leaf links keep full pull; hub-side links weaken so the
      // hub doesn't crush its neighborhood.
      .strength((link) => {
        const a = degree.get(link.source.id) || 1;
        const b = degree.get(link.target.id) || 1;
        return 1 / Math.max(1, Math.min(a, b));
      });

    const chargeForce = forceManyBody()
      // Stronger base + bigger size scaling so leaves actually have room
      // to spread around their hubs.
      .strength((n) => -260 - (n.radius || 5) * 18)
      .distanceMax(1400)
      .theta(0.9);

    const collideForce = forceCollide()
      // Generous collision radius prevents visual overlap; ~1.4x the
      // node radius leaves a comfortable gap.
      .radius((n) => (n.radius || 5) * 1.4 + 6)
      .strength(0.9)
      .iterations(2);

    // Center pull, plus separate forceX/forceY at higher strength to drag
    // disconnected orphans out of the initial-spread ring and toward the
    // middle. Pure forceCenter is too weak to overcome the velocityDecay
    // for nodes that have no links anchoring them.
    const centerForce = forceCenter(0, 0).strength(0.05);
    const xPull = (n) => -n.x * 0.02;
    const yPull = (n) => -n.y * 0.02;

    simulation
      .force("link", linkForce)
      .force("charge", chargeForce)
      .force("collide", collideForce)
      .force("center", centerForce)
      // Custom drift toward origin: like forceX(0).strength(0.02) but
      // applied by hand so we don't need an extra import.
      .force("xCenter", (alpha) => {
        for (const n of d3Nodes) n.vx += xPull(n) * alpha;
      })
      .force("yCenter", (alpha) => {
        for (const n of d3Nodes) n.vy += yPull(n) * alpha;
      });
  }

  function startInitialSimulation() {
    if (graph.order === 0) return;
    buildD3Inputs({ spread: true });
    applyForces();
    cameraFitOnEnd = true;
    simulation.alpha(1).restart();
    sigma?.getCamera().animatedReset({ duration: 0 });
  }

  function syncSimulationWithGraph() {
    if (graph.order === 0) {
      simulation?.nodes([]);
      return;
    }
    buildD3Inputs({ spread: false });
    applyForces();
    // Mild re-warm so the layout absorbs new nodes without snapping.
    simulation.alpha(0.4).restart();
  }

  function setData({ nodes, edges, labelsAlwaysThreshold }) {
    if (Number.isInteger(labelsAlwaysThreshold)) {
      labelsAlwaysVisibleThreshold = labelsAlwaysThreshold;
    }
    const newGraph = buildKnowledgeBaseGraph(Array.isArray(nodes) ? nodes : [], Array.isArray(edges) ? edges : []);
    if (sigma) {
      // Preserve current simulated positions across the rebuild so existing
      // nodes stay where the simulation put them; new nodes pick up the
      // spiral seed from buildKnowledgeBaseGraph.
      const positions = new Map();
      graph.forEachNode((key, attrs) => {
        if (Number.isFinite(attrs.x) && Number.isFinite(attrs.y)) {
          positions.set(key, { x: attrs.x, y: attrs.y });
        }
      });
      graph.clear();
      newGraph.forEachNode((key, attrs) => {
        const pos = positions.get(key);
        graph.addNode(key, pos ? { ...attrs, x: pos.x, y: pos.y } : attrs);
      });
      newGraph.forEachEdge((_key, attrs, src, tgt) => graph.addEdge(src, tgt, attrs));
    } else {
      graph = newGraph;
      ensureSigma();
    }
    selectedKey = selectedKey && graph.hasNode(selectedKey) ? selectedKey : "";
    hoveredKey = hoveredKey && graph.hasNode(hoveredKey) ? hoveredKey : "";
    recomputeConnected();

    if (!hasStartedSimulation && graph.order > 0) {
      hasStartedSimulation = true;
      startInitialSimulation();
    } else {
      syncSimulationWithGraph();
    }
  }

  function setSelected(path) {
    const next = path && graph.hasNode(path) ? String(path) : "";
    if (next === selectedKey) return;
    selectedKey = next;
    recomputeConnected();
    sigma?.refresh({ skipIndexation: true });
  }

  function fit() {
    if (!sigma) return;
    sigma.getCamera().animatedReset({ duration: 350 });
  }

  function focus(path) {
    if (!sigma || !path || !graph.hasNode(path)) return false;
    const attrs = graph.getNodeAttributes(path);
    sigma.getCamera().animate({ x: attrs.x, y: attrs.y, ratio: 0.45 }, { duration: 400 });
    return true;
  }

  function pulse() {
    if (graph.order === 0) return;
    // Re-energize the simulation; nodes glide back into equilibrium from
    // their current positions. Same effect as opening the graph view.
    simulation?.alpha(1).restart();
  }

  function unmount() {
    if (simulation) {
      simulation.stop();
      simulation.on("tick", null);
      simulation.on("end", null);
      simulation = null;
    }
    sigma?.kill();
    sigma = null;
    graph.clear();
    dragging = null;
    selectedKey = "";
    hoveredKey = "";
    connectedKeys.clear();
    d3Nodes = [];
    d3NodeById = new Map();
    d3Links = [];
    hasStartedSimulation = false;
  }

  ensureSigma();

  return { setData, setSelected, fit, focus, pulse, unmount };
}

// Exported for test coverage.
export { buildKnowledgeBaseGraph as __buildKnowledgeBaseGraph };
