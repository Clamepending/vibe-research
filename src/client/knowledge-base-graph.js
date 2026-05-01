// WebGL renderer for the Library graph view.
//
// Renders via sigma.js (1 draw call per frame on a WebGL canvas) and lays
// the graph out with graphology-layout-forceatlas2 (Barnes-Hut O(n log n))
// running synchronously for a finite number of iterations.
//
// We deliberately do NOT run fa2 in a worker / continuous mode. fa2 in
// supervisor mode keeps writing micro-displacements forever, which sigma
// re-renders, producing visible jitter. Synchronous-with-finite-iterations
// settles the layout to a fixed point in one shot, sigma renders the
// settled state, and the GPU goes idle. The user can re-energize via
// `pulse()` (drag, button) and we run another finite settle.
//
// The module is mounted by main.js after the graph card is rendered. main.js
// keeps owning the source-of-truth `state.knowledgeBase.graphLayout` data;
// this module just consumes it via `setData`.

import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import { buildKnowledgeBaseGraph } from "./knowledge-base-graph-data.js";

// fa2 iteration counts. linLogMode + outboundAttractionDistribution converge
// slower than plain fa2 but produce dramatically clearer cluster structure
// instead of the hub-and-spoke / radial-spike look you get from defaults.
// We're running synchronously (not in a worker), so iterations are a fixed
// budget that we know completes in <500ms even for thousands of nodes
// thanks to Barnes-Hut.
function iterationsFor(order) {
  if (order <= 50) return 250;
  if (order <= 200) return 400;
  if (order <= 800) return 700;
  return 1000;
}

let cachedSettings = null;
let cachedSettingsOrder = -1;
function fa2SettingsFor(graph) {
  if (cachedSettingsOrder === graph.order && cachedSettings) return cachedSettings;
  const inferred = forceAtlas2.inferSettings(graph);
  cachedSettings = {
    ...inferred,
    barnesHutOptimize: graph.order > 200,
    barnesHutTheta: 0.5,
    // linLogMode produces clear cluster grouping (communities pull tightly
    // together while distinct communities push apart strongly) instead of
    // the radial hub-and-spoke layout you get from default fa2. Combined
    // with outboundAttractionDistribution this gives the "natural Obsidian
    // graph" look the user is asking for.
    linLogMode: true,
    // Scale-free / power-law graphs (which a Library is — a few hub notes
    // with many backlinks, a long tail of leaf notes) benefit from
    // redistributing edge attraction proportional to degree. Without this,
    // hubs dominate and produce stars; with it, edges bring leaves into
    // their own community space.
    outboundAttractionDistribution: true,
    // Treat node sizes as repulsion radii so hubs don't overlap their
    // leaves. Cheap; only relevant in linLog mode.
    adjustSizes: true,
    // strongGravityMode keeps disconnected components on screen.
    strongGravityMode: true,
    gravity: 1,
    // The big spread knob in linLog mode. Higher = more separation between
    // clusters. inferSettings gives ~4 for our size; 12 produces visibly
    // grouped islands.
    scalingRatio: 12,
    // slowDown damps each step. With finite-iteration sync layout, lower is
    // fine — there's no continuous loop to oscillate.
    slowDown: 1,
  };
  cachedSettingsOrder = graph.order;
  return cachedSettings;
}

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
  let dragRafHandle = 0;
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

  // sigma reducers — called per-render frame. We do NOT mutate the underlying
  // graphology data here; that way fa2 can keep its source of truth and we
  // just decorate.
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
      // labelDensity controls how aggressively sigma decimates labels in the
      // current viewport. Lower = fewer overlapping labels.
      labelDensity: 0.6,
      labelGridCellSize: 130,
      // Only render labels for nodes that occupy at least this many pixels;
      // tiny nodes never get labels in a packed view.
      labelRenderedSizeThreshold: 6,
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

    // Node dragging: while the user holds a node, run a continuous loop on
    // requestAnimationFrame that does ~3 fa2 iterations per frame and pins
    // the dragged node to the latest pointer position. This is what produces
    // the "live physics" feel — dragging a hub causes its leaves to swarm
    // around it in real time, not just snap when you release. We don't run
    // fa2 in a worker (which caused jitter at rest); instead we explicitly
    // start the loop on `downNode` and stop it on mouseup.
    sigma.on("downNode", ({ node, event }) => {
      dragging = { key: node, moved: false, lastX: undefined, lastY: undefined };
      graph.setNodeAttribute(node, "highlighted", true);
      event.preventSigmaDefault?.();
      startDragLoop();
    });

    const onMove = (rawEvent) => {
      if (!dragging || !sigma) return;
      const point = sigma.viewportToGraph({ x: rawEvent.x, y: rawEvent.y });
      dragging.lastX = point.x;
      dragging.lastY = point.y;
      // Pin the dragged node directly so the renderer reflects the pointer
      // even if the RAF tick hasn't fired yet.
      graph.setNodeAttribute(dragging.key, "x", point.x);
      graph.setNodeAttribute(dragging.key, "y", point.y);
      dragging.moved = true;
    };
    const onUp = () => {
      if (!dragging) return;
      const wasMoved = dragging.moved;
      graph.setNodeAttribute(dragging.key, "highlighted", false);
      stopDragLoop();
      dragging = null;
      if (wasMoved) {
        // Final relaxation pass so the layout settles fully into a fixed
        // point after the drag — no continuous worker means no jitter.
        runLayout({ iterations: 80 });
      }
    };
    sigma.getMouseCaptor().on("mousemovebody", onMove);
    sigma.getMouseCaptor().on("mouseup", onUp);
    sigma.getMouseCaptor().on("mouseleave", onUp);

    return sigma;
  }

  function startDragLoop() {
    if (dragRafHandle) return;
    const tick = () => {
      if (!dragging) {
        dragRafHandle = 0;
        return;
      }
      // ~3 fa2 iterations per frame is enough for visible response without
      // burning the main thread. With Barnes-Hut on 300 nodes this is well
      // under 5ms per frame, comfortably 60fps.
      forceAtlas2.assign(graph, { iterations: 3, settings: fa2SettingsFor(graph) });
      // fa2 may have moved the dragged node — re-pin it to the last pointer
      // position so the user always sees the node tracking their cursor.
      if (dragging.lastX !== undefined && dragging.lastY !== undefined) {
        graph.setNodeAttribute(dragging.key, "x", dragging.lastX);
        graph.setNodeAttribute(dragging.key, "y", dragging.lastY);
      }
      sigma?.refresh({ skipIndexation: true });
      dragRafHandle = window.requestAnimationFrame(tick);
    };
    dragRafHandle = window.requestAnimationFrame(tick);
  }

  function stopDragLoop() {
    if (dragRafHandle) {
      window.cancelAnimationFrame(dragRafHandle);
      dragRafHandle = 0;
    }
  }

  // Synchronous fa2 settle. Runs `iterations` ticks on the main thread; for
  // a few hundred nodes with Barnes-Hut this is well under 200ms. Returns
  // when the graph is settled — sigma re-renders once and the canvas goes
  // idle (no continuous loop, no jitter).
  function runLayout({ iterations } = {}) {
    if (graph.order < 2) return;
    const iters = Number.isInteger(iterations) && iterations > 0 ? iterations : iterationsFor(graph.order);
    forceAtlas2.assign(graph, { iterations: iters, settings: fa2SettingsFor(graph) });
    sigma?.refresh({ skipIndexation: true });
  }

  function setData({ nodes, edges, labelsAlwaysThreshold }) {
    if (Number.isInteger(labelsAlwaysThreshold)) {
      labelsAlwaysVisibleThreshold = labelsAlwaysThreshold;
    }
    const newGraph = buildKnowledgeBaseGraph(Array.isArray(nodes) ? nodes : [], Array.isArray(edges) ? edges : []);
    if (sigma) {
      // Replace the graph underneath sigma. Sigma v3 holds onto the graph
      // instance it was constructed with, so we clear + re-merge into the
      // existing instance instead of recreating sigma (which would lose
      // camera state).
      graph.clear();
      newGraph.forEachNode((key, attrs) => graph.addNode(key, attrs));
      newGraph.forEachEdge((_key, attrs, src, tgt) => graph.addEdge(src, tgt, attrs));
    } else {
      graph = newGraph;
      ensureSigma();
    }
    selectedKey = selectedKey && graph.hasNode(selectedKey) ? selectedKey : "";
    hoveredKey = hoveredKey && graph.hasNode(hoveredKey) ? hoveredKey : "";
    recomputeConnected();

    // Settle the new layout, then fit the camera so the user sees the whole
    // graph regardless of where fa2 ended up.
    runLayout();
    sigma?.refresh({ skipIndexation: false });
    sigma?.getCamera().animatedReset({ duration: 0 });
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
    // A "shake-out": slightly perturb every node, then re-settle. Without
    // perturbation, fa2 starting from the previous fixed point would just
    // sit there.
    graph.forEachNode((key, attrs) => {
      const dx = (Math.random() - 0.5) * 30;
      const dy = (Math.random() - 0.5) * 30;
      graph.setNodeAttribute(key, "x", (attrs.x || 0) + dx);
      graph.setNodeAttribute(key, "y", (attrs.y || 0) + dy);
    });
    runLayout();
    sigma?.getCamera().animatedReset({ duration: 350 });
  }

  function unmount() {
    stopDragLoop();
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
