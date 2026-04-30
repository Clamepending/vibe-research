// WebGL renderer for the Library graph view.
//
// Replaces the previous SVG + custom O(n²) force simulation with:
//   - sigma.js for WebGL rendering (1 draw call per frame; scales to ~100k+
//     nodes at 60fps without blocking the main thread)
//   - graphology as the in-memory graph data structure (sigma reads from it)
//   - graphology-layout-forceatlas2 running in a Web Worker for layout, with
//     Barnes-Hut O(n log n) approximation auto-enabled past ~500 nodes
//
// The module is mounted by main.js after the graph card is rendered. main.js
// keeps owning the source-of-truth `state.knowledgeBase.graphLayout` data; this
// module just consumes it via `setData`.

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import FA2LayoutSupervisor from "graphology-layout-forceatlas2/worker.js";
import Sigma from "sigma";
import { buildKnowledgeBaseGraph } from "./knowledge-base-graph-data.js";

// How long the layout worker is allowed to run after a data change before we
// stop driving it. Sigma still renders smoothly while it's running; stopping
// just keeps the GPU + main thread idle once the graph has visually settled.
const LAYOUT_RUN_MS = 6000;
// On a `pulse()` we kick the worker for a fresh shake-out, even if it had
// previously settled.
const LAYOUT_PULSE_MS = 4000;

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
  let supervisor = null;
  let supervisorTimeout = 0;
  let selectedKey = "";
  let connectedKeys = new Set();
  let hoveredKey = "";
  let dragging = null;
  let labelsAlwaysVisibleThreshold = 26;

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

  // sigma reducers — called per-render frame, returning the visual attrs for
  // each node/edge. We do NOT mutate the underlying graphology data here; that
  // way the layout worker keeps its source of truth and we just decorate.
  function nodeReducer(key, attrs) {
    const isSelected = key === selectedKey;
    const isHovered = key === hoveredKey;
    const isConnected = connectedKeys.has(key);
    const totalNodes = graph.order;
    const labelAlwaysOn = totalNodes <= labelsAlwaysVisibleThreshold;
    const showLabel = labelAlwaysOn || isSelected || isHovered || isConnected;
    const baseSize = Number(attrs.size) || 5;
    const size = isSelected ? baseSize * 1.55 : isHovered ? baseSize * 1.3 : isConnected ? baseSize * 1.15 : baseSize;
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
      labelDensity: 0.9,
      labelGridCellSize: 90,
      labelRenderedSizeThreshold: 4,
      zIndex: true,
      allowInvalidContainer: false,
    });

    sigma.on("clickNode", ({ node }) => {
      if (dragging) return; // suppress click after drag
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

    // Node dragging: capture the sigma node, follow pointermove in graph
    // coordinates (viewportToGraph), fix the node so the layout worker doesn't
    // fight us until we release. Mirrors the previous SVG drag UX.
    sigma.on("downNode", ({ node, event }) => {
      dragging = { key: node, moved: false };
      graph.setNodeAttribute(node, "highlighted", true);
      // Suspend layout while dragging so positions don't fight the pointer.
      supervisor?.stop();
      event.preventSigmaDefault?.();
    });

    const onMove = (rawEvent) => {
      if (!dragging || !sigma) return;
      const point = sigma.viewportToGraph({ x: rawEvent.x, y: rawEvent.y });
      graph.setNodeAttribute(dragging.key, "x", point.x);
      graph.setNodeAttribute(dragging.key, "y", point.y);
      dragging.moved = true;
    };
    const onUp = () => {
      if (!dragging) return;
      const wasMoved = dragging.moved;
      graph.setNodeAttribute(dragging.key, "highlighted", false);
      dragging = null;
      if (wasMoved) {
        // Suppress the click that follows a drag-up.
        // (sigma fires clickNode after mouseup; the dragging guard handles it.)
      }
      // Resume the layout briefly so neighbors re-relax around the new spot.
      kickLayout(LAYOUT_PULSE_MS / 2);
    };
    sigma.getMouseCaptor().on("mousemovebody", onMove);
    sigma.getMouseCaptor().on("mouseup", onUp);
    sigma.getMouseCaptor().on("mouseleave", onUp);

    return sigma;
  }

  function kickLayout(durationMs) {
    if (graph.order < 2) return;
    if (supervisorTimeout) {
      window.clearTimeout(supervisorTimeout);
      supervisorTimeout = 0;
    }
    if (!supervisor) {
      const inferred = forceAtlas2.inferSettings(graph);
      supervisor = new FA2LayoutSupervisor(graph, {
        settings: {
          ...inferred,
          // Barnes-Hut is what makes >500 nodes tractable. inferSettings
          // already enables it past a threshold; we pin it on for safety.
          barnesHutOptimize: graph.order > 200,
          barnesHutTheta: 0.5,
          // A bit more breathing room than fa2 defaults so dense graphs don't
          // collapse into a single hairball.
          gravity: 1,
          scalingRatio: 8,
          slowDown: 4,
          // linLogMode produces clearer cluster separation for node-link
          // graphs that have natural communities (project groups in our
          // case).
          linLogMode: true,
          outboundAttractionDistribution: false,
          adjustSizes: false,
        },
      });
    }
    if (!supervisor.isRunning()) supervisor.start();
    supervisorTimeout = window.setTimeout(() => {
      supervisor?.stop();
      supervisorTimeout = 0;
    }, Math.max(500, durationMs));
  }

  function setData({ nodes, edges, labelsAlwaysThreshold }) {
    if (Number.isInteger(labelsAlwaysThreshold)) {
      labelsAlwaysVisibleThreshold = labelsAlwaysThreshold;
    }
    const newGraph = buildKnowledgeBaseGraph(Array.isArray(nodes) ? nodes : [], Array.isArray(edges) ? edges : []);
    if (sigma) {
      // Replace graphology underneath sigma. Sigma v3 owns the graph instance
      // it was constructed with; the cleanest swap is to clear+merge so we
      // don't have to recreate sigma (which would lose camera state).
      graph.clear();
      newGraph.forEachNode((key, attrs) => graph.addNode(key, attrs));
      newGraph.forEachEdge((key, attrs, src, tgt) => graph.addEdge(src, tgt, attrs));
    } else {
      graph = newGraph;
      ensureSigma();
    }
    selectedKey = selectedKey && graph.hasNode(selectedKey) ? selectedKey : "";
    hoveredKey = hoveredKey && graph.hasNode(hoveredKey) ? hoveredKey : "";
    recomputeConnected();
    sigma?.refresh({ skipIndexation: false });
    // Restart layout for the new data.
    if (supervisor) {
      supervisor.kill();
      supervisor = null;
    }
    kickLayout(LAYOUT_RUN_MS);
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
    sigma.getCamera().animate(
      { x: attrs.x, y: attrs.y, ratio: 0.45 },
      { duration: 400 },
    );
    return true;
  }

  function pulse() {
    kickLayout(LAYOUT_PULSE_MS);
  }

  function unmount() {
    if (supervisorTimeout) {
      window.clearTimeout(supervisorTimeout);
      supervisorTimeout = 0;
    }
    supervisor?.kill();
    supervisor = null;
    sigma?.kill();
    sigma = null;
    graph.clear();
    dragging = null;
    selectedKey = "";
    hoveredKey = "";
    connectedKeys.clear();
  }

  ensureSigma();

  return { setData, setSelected, fit, focus, pulse, unmount };
}

// Exported for test coverage.
export { buildKnowledgeBaseGraph as __buildKnowledgeBaseGraph };
