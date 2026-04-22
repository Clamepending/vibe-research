const svg = document.querySelector("[data-node-background]");

if (svg) {
  const namespace = "http://www.w3.org/2000/svg";
  const nodes = [
    { id: "home", x: 98, y: 128, r: 5.5 },
    { id: "calendar", x: 244, y: 96, r: 4.5 },
    { id: "inbox", x: 382, y: 146, r: 6 },
    { id: "browser", x: 558, y: 92, r: 4.75 },
    { id: "memory", x: 746, y: 132, r: 5.75 },
    { id: "research", x: 920, y: 88, r: 5 },
    { id: "files", x: 1088, y: 154, r: 4.5 },
    { id: "planner", x: 148, y: 322, r: 6.5 },
    { id: "builder", x: 330, y: 306, r: 7.5 },
    { id: "agent-a", x: 514, y: 286, r: 5.25 },
    { id: "agent-b", x: 674, y: 342, r: 6 },
    { id: "agent-c", x: 856, y: 292, r: 5.25 },
    { id: "town", x: 1046, y: 348, r: 7 },
    { id: "automation", x: 218, y: 558, r: 5.5 },
    { id: "tests", x: 442, y: 596, r: 4.75 },
    { id: "terminal", x: 626, y: 536, r: 6.75 },
    { id: "publish", x: 808, y: 606, r: 5.5 },
    { id: "review", x: 1012, y: 552, r: 4.75 },
    { id: "archive", x: 578, y: 764, r: 4.5 },
  ];
  const edges = [
    ["home", "calendar"],
    ["home", "planner"],
    ["calendar", "inbox"],
    ["inbox", "browser"],
    ["browser", "memory"],
    ["memory", "research"],
    ["research", "files"],
    ["planner", "builder"],
    ["builder", "agent-a"],
    ["agent-a", "agent-b"],
    ["agent-b", "agent-c"],
    ["agent-c", "town"],
    ["files", "town"],
    ["builder", "automation"],
    ["automation", "tests"],
    ["tests", "terminal"],
    ["terminal", "publish"],
    ["publish", "review"],
    ["terminal", "archive"],
    ["memory", "agent-b"],
    ["inbox", "builder"],
    ["research", "agent-c"],
    ["planner", "terminal"],
    ["town", "review"],
  ];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const edgeElements = [];
  const nodeElements = [];
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let activeIndex = 8;
  let pointerFrame = 0;
  let intervalId = 0;

  const edgeGroup = document.createElementNS(namespace, "g");
  edgeGroup.setAttribute("class", "node-background-links");
  svg.append(edgeGroup);

  for (const [sourceId, targetId] of edges) {
    const source = nodeById.get(sourceId);
    const target = nodeById.get(targetId);
    if (!source || !target) {
      continue;
    }

    const line = document.createElementNS(namespace, "line");
    line.setAttribute("class", "node-background-link");
    line.setAttribute("x1", source.x);
    line.setAttribute("y1", source.y);
    line.setAttribute("x2", target.x);
    line.setAttribute("y2", target.y);
    line.dataset.source = sourceId;
    line.dataset.target = targetId;
    edgeGroup.append(line);
    edgeElements.push(line);
  }

  const nodeGroup = document.createElementNS(namespace, "g");
  nodeGroup.setAttribute("class", "node-background-points");
  svg.append(nodeGroup);

  for (const node of nodes) {
    const group = document.createElementNS(namespace, "g");
    const ring = document.createElementNS(namespace, "circle");
    const point = document.createElementNS(namespace, "circle");
    group.setAttribute("class", "node-background-point");
    group.setAttribute("transform", `translate(${node.x} ${node.y})`);
    group.dataset.nodeId = node.id;
    ring.setAttribute("class", "node-background-ring");
    ring.setAttribute("r", node.r + 9);
    point.setAttribute("r", node.r);
    group.append(ring, point);
    nodeGroup.append(group);
    nodeElements.push(group);
  }

  function activateNode(index) {
    activeIndex = (index + nodes.length) % nodes.length;
    const activeNode = nodes[activeIndex];
    const connectedIds = new Set([activeNode.id]);

    for (const edge of edgeElements) {
      const isActive = edge.dataset.source === activeNode.id || edge.dataset.target === activeNode.id;
      edge.classList.toggle("is-active", isActive);
      if (isActive) {
        connectedIds.add(edge.dataset.source);
        connectedIds.add(edge.dataset.target);
      }
    }

    for (const element of nodeElements) {
      const isActive = element.dataset.nodeId === activeNode.id;
      element.classList.toggle("is-active", isActive);
      element.classList.toggle("is-connected", !isActive && connectedIds.has(element.dataset.nodeId));
    }
  }

  function nearestNodeIndex(clientX, clientY) {
    const x = (clientX / Math.max(1, window.innerWidth)) * 1200;
    const y = (clientY / Math.max(1, window.innerHeight)) * 900;
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;

    nodes.forEach((node, index) => {
      const distance = Math.hypot(node.x - x, node.y - y);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    });

    return nearest;
  }

  activateNode(activeIndex);

  if (!reducedMotion) {
    intervalId = window.setInterval(() => {
      activateNode(activeIndex + 1);
    }, 2200);

    window.addEventListener(
      "pointermove",
      (event) => {
        if (pointerFrame) {
          return;
        }

        pointerFrame = window.requestAnimationFrame(() => {
          pointerFrame = 0;
          activateNode(nearestNodeIndex(event.clientX, event.clientY));
          window.clearInterval(intervalId);
          intervalId = window.setInterval(() => {
            activateNode(activeIndex + 1);
          }, 2600);
        });
      },
      { passive: true },
    );
  }
}
