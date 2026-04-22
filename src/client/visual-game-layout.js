const VISUAL_GAME_GRID_COLUMNS = 30;
const VISUAL_GAME_GRID_ROWS = 18;
const VISUAL_GAME_CELL_SIZE = 30;
const VISUAL_GAME_WORLD_WIDTH = VISUAL_GAME_GRID_COLUMNS * VISUAL_GAME_CELL_SIZE;
const VISUAL_GAME_WORLD_HEIGHT = VISUAL_GAME_GRID_ROWS * VISUAL_GAME_CELL_SIZE;
const BUILDING_INSET = 4;

function point(x, y) {
  return { x, y };
}

function gridCell(column, row, width = 1, height = 1) {
  return { column, row, width, height };
}

function rect(x, y, width, height) {
  return { x, y, width, height };
}

function cellRect(cell, inset = 0) {
  return rect(
    cell.column * VISUAL_GAME_CELL_SIZE + inset,
    cell.row * VISUAL_GAME_CELL_SIZE + inset,
    cell.width * VISUAL_GAME_CELL_SIZE - inset * 2,
    cell.height * VISUAL_GAME_CELL_SIZE - inset * 2,
  );
}

function cellCenter(column, row, offsetX = 0, offsetY = 0) {
  return point(
    column * VISUAL_GAME_CELL_SIZE + VISUAL_GAME_CELL_SIZE / 2 + offsetX,
    row * VISUAL_GAME_CELL_SIZE + VISUAL_GAME_CELL_SIZE / 2 + offsetY,
  );
}

function cellsInRect(column, row, width, height) {
  const cells = [];
  for (let y = row; y < row + height; y += 1) {
    for (let x = column; x < column + width; x += 1) {
      cells.push(gridCell(x, y));
    }
  }
  return cells;
}

function place(id, label, column, row, width, height, options = {}) {
  const cell = gridCell(column, row, width, height);
  return {
    id,
    label,
    cell,
    rect: cellRect(cell, BUILDING_INSET),
    ...options,
  };
}

export const VISUAL_GAME_MAP_LAYOUT = Object.freeze({
  width: VISUAL_GAME_WORLD_WIDTH,
  height: VISUAL_GAME_WORLD_HEIGHT,
  grid: {
    columns: VISUAL_GAME_GRID_COLUMNS,
    rows: VISUAL_GAME_GRID_ROWS,
    cellSize: VISUAL_GAME_CELL_SIZE,
  },
  roads: [
    { id: "main", cells: cellsInRect(2, 8, 26, 1) },
    { id: "dormitory-spur", cells: cellsInRect(4, 4, 1, 4) },
    { id: "library-spur", cells: cellsInRect(4, 9, 1, 1) },
    { id: "workshop-spur", cells: cellsInRect(12, 6, 1, 2) },
    { id: "browser-spur", cells: cellsInRect(20, 6, 1, 2) },
    { id: "automations-spur", cells: cellsInRect(24, 6, 1, 2) },
    { id: "gpu-yard-spur", cells: cellsInRect(13, 9, 1, 3) },
    { id: "camera-spur", cells: cellsInRect(23, 9, 1, 1) },
    { id: "east-plaza", cells: cellsInRect(23, 9, 5, 1) },
    { id: "dock-spur", cells: cellsInRect(27, 10, 1, 3) },
  ],
  places: {
    dormitory: place("dormitory", "Dormitory", 1, 1, 6, 3, {
      entrance: { side: "bottom", offset: 0.5 },
      beds: [],
      spots: [
        cellCenter(2, 2, 0, 4),
        cellCenter(3, 2, 0, 4),
        cellCenter(4, 2, 0, 4),
        cellCenter(5, 2, 0, 4),
        cellCenter(6, 2, -8, 4),
      ],
    }),
    library: place("library", "Library", 1, 10, 6, 3, {
      entrance: { side: "top", offset: 0.5 },
      spots: [
        cellCenter(2, 11, -2, 2),
        cellCenter(3, 11, -1, 3),
        cellCenter(4, 11, 0, 2),
        cellCenter(3, 10, 0, 8),
      ],
    }),
    workshop: place("workshop", "Computer Lab", 9, 1, 6, 5, {
      entrance: { side: "bottom", offset: 0.5 },
      spots: [
        cellCenter(10, 3, 10, -9),
        cellCenter(11, 3, 20, -9),
        cellCenter(13, 3, 0, -9),
        cellCenter(10, 4, 10, -4),
        cellCenter(11, 4, 20, -4),
        cellCenter(13, 4, 0, -4),
      ],
    }),
    browser: place("browser", "Browser", 18, 1, 5, 5, {
      entrance: { side: "bottom", offset: 0.5 },
      spots: [
        cellCenter(18, 3, 14, -9),
        cellCenter(20, 3, 0, -9),
        cellCenter(21, 3, 8, -9),
        cellCenter(18, 4, 14, -4),
        cellCenter(20, 4, 0, -4),
        cellCenter(21, 4, 8, -4),
      ],
    }),
    automations: place("automations", "Automations", 23, 1, 3, 5, {
      entrance: { side: "bottom", offset: 0.5 },
      spots: [
        cellCenter(23, 5, 10, -5),
        cellCenter(24, 5, 0, -5),
        cellCenter(25, 5, -10, -5),
      ],
    }),
    ottoauth: place("ottoauth", "OttoAuth", 15, 6, 3, 2, {
      entrance: { side: "bottom", offset: 0.5 },
      spots: [
        cellCenter(15, 7, 10, -3),
        cellCenter(16, 7, 0, -3),
        cellCenter(17, 7, -10, -3),
      ],
    }),
    camera: place("camera", "Camera", 21, 10, 5, 3, {
      entrance: { side: "top", offset: 0.5 },
      spots: [
        cellCenter(22, 11, -6, 3),
        cellCenter(23, 11, -3, 3),
        cellCenter(24, 11, -3, 3),
        cellCenter(22, 10, -6, 15),
        cellCenter(23, 10, -3, 15),
      ],
    }),
    gpuYard: place("gpuYard", "GPU Yard", 9, 12, 8, 4, {
      entrance: { side: "top", offset: 0.5 },
      factory: {
        columns: 4,
        gap: 4,
        maxVisible: 8,
        padding: 8,
        size: { width: 54, height: 42 },
      },
    }),
    dock: place("dock", "Port Dock", 25, 13, 4, 3, {
      entrance: { side: "top", offset: 0.5 },
    }),
  },
  roamRoutes: [
    [cellCenter(4, 8), cellCenter(9, 8), cellCenter(13, 8), cellCenter(20, 8), cellCenter(27, 8), cellCenter(13, 8)],
    [cellCenter(4, 8), cellCenter(4, 6), cellCenter(4, 4), cellCenter(4, 6), cellCenter(4, 8)],
    [cellCenter(12, 8), cellCenter(12, 7), cellCenter(12, 6), cellCenter(12, 7), cellCenter(12, 8)],
    [cellCenter(20, 8), cellCenter(20, 7), cellCenter(20, 6), cellCenter(20, 7), cellCenter(20, 8)],
    [cellCenter(13, 8), cellCenter(13, 9), cellCenter(13, 11), cellCenter(13, 9), cellCenter(13, 8)],
    [cellCenter(23, 8), cellCenter(23, 9), cellCenter(27, 9), cellCenter(27, 12), cellCenter(27, 9), cellCenter(23, 9)],
  ],
});

export function getVisualGamePlace(layout, id) {
  return layout?.places?.[id] || null;
}

export function getVisualGamePlaceAnchor(place) {
  const placeCell = place?.cell;
  if (!placeCell) {
    return point(0, 0);
  }

  const side = place.entrance?.side || "bottom";
  const offset = Number.isFinite(Number(place.entrance?.offset)) ? Number(place.entrance.offset) : 0.5;
  if (side === "top") {
    return point((placeCell.column + placeCell.width * offset) * VISUAL_GAME_CELL_SIZE, placeCell.row * VISUAL_GAME_CELL_SIZE);
  }
  if (side === "left") {
    return point(placeCell.column * VISUAL_GAME_CELL_SIZE, (placeCell.row + placeCell.height * offset) * VISUAL_GAME_CELL_SIZE);
  }
  if (side === "right") {
    return point((placeCell.column + placeCell.width) * VISUAL_GAME_CELL_SIZE, (placeCell.row + placeCell.height * offset) * VISUAL_GAME_CELL_SIZE);
  }
  return point((placeCell.column + placeCell.width * offset) * VISUAL_GAME_CELL_SIZE, (placeCell.row + placeCell.height) * VISUAL_GAME_CELL_SIZE);
}

export function getVisualGameAgentIdentityKey(agent, index = 0) {
  const scopedIds = [
    ["browser", agent?.browserUseSessionId],
    ["ottoauth", agent?.ottoAuthSessionId || agent?.ottoAuthTaskId],
    ["videomemory", agent?.videoMemoryMonitorId || agent?.videoMemoryTaskId],
    ["subagent", agent?.subagentId],
    ["session", agent?.sessionId],
  ];

  for (const [scope, value] of scopedIds) {
    const normalized = normalizeIdentityKeyPart(value);
    if (normalized) {
      return `${scope}:${normalized}`;
    }
  }

  const agentId = normalizeIdentityKeyPart(agent?.agentId);
  if (agentId) {
    const parentSessionId = normalizeIdentityKeyPart(agent?.parentSessionId);
    return `subagent:${parentSessionId ? `${parentSessionId}:` : ""}${agentId}`;
  }

  const fallbackParts = [
    agent?.parentSessionId,
    agent?.kind,
    agent?.source,
    agent?.agentType,
    agent?.name,
    index,
  ].map(normalizeIdentityKeyPart).filter(Boolean);

  return `agent:${fallbackParts.join(":") || normalizeIdentityKeyPart(index) || "unknown"}`;
}

export function getVisualGameRoadRects(layout = VISUAL_GAME_MAP_LAYOUT) {
  return (layout.roads || []).flatMap((road) =>
    (road.cells || []).map((cell) => ({
      id: road.id,
      cell,
      rect: cellRect(cell),
    })),
  );
}

function normalizeIdentityKeyPart(value) {
  const text = String(value ?? "").trim();
  return text || "";
}

export function findVisualGameRoadRoute(start, target, roadRects, options = {}) {
  const startPoint = normalizeRoutePoint(start);
  const targetPoint = normalizeRoutePoint(target);
  if (!startPoint || !targetPoint) {
    return [];
  }

  const rects = (Array.isArray(roadRects) ? roadRects : [])
    .map((entry, index) => normalizeRouteRect(entry?.rect || entry, index))
    .filter(Boolean);

  if (!rects.length) {
    return compactVisualGameRoute([startPoint, targetPoint]);
  }

  const nodes = rects.map((road, index) => ({
    ...road,
    index,
    point: point(road.rect.x + road.rect.width / 2, road.rect.y + road.rect.height / 2),
    edges: [],
  }));
  const tolerance = Math.max(0, Number(options.tolerance ?? 1));

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      if (!routeRectsConnect(nodes[leftIndex].rect, nodes[rightIndex].rect, tolerance)) {
        continue;
      }

      const weight = pointDistance(nodes[leftIndex].point, nodes[rightIndex].point);
      nodes[leftIndex].edges.push({ index: rightIndex, weight });
      nodes[rightIndex].edges.push({ index: leftIndex, weight });
    }
  }

  const startIndex = getNearestRouteNodeIndex(startPoint, nodes);
  const targetIndex = getNearestRouteNodeIndex(targetPoint, nodes);
  if (startIndex < 0 || targetIndex < 0) {
    return compactVisualGameRoute([startPoint, targetPoint]);
  }

  const indexes = getShortestRouteNodeIndexes(nodes, startIndex, targetIndex);
  if (!indexes.length) {
    return compactVisualGameRoute([startPoint, targetPoint]);
  }

  return compactVisualGameRoute([
    startPoint,
    ...indexes.map((index) => nodes[index].point),
    targetPoint,
  ]);
}

export function getVisualGamePlaceItemSlots(layout, placeId, count, options = {}) {
  const place = getVisualGamePlace(layout, placeId);
  if (!place) {
    return { slots: [], hiddenCount: 0 };
  }

  return getVisualGamePackedItemSlots(place.rect, count, options);
}

export function getVisualGamePackedItemSlots(area, count, options = {}) {
  const itemCount = Math.max(0, Math.floor(Number(count) || 0));
  const itemSize = options.itemSize || { width: 20, height: 20 };
  const itemWidth = Math.max(1, Number(itemSize.width || 1));
  const itemHeight = Math.max(1, Number(itemSize.height || 1));
  const maxColumns = Math.max(1, Math.floor(Number(options.maxColumns || itemCount || 1)));
  const maxVisible = Math.max(1, Math.floor(Number(options.maxVisible || itemCount || 1)));
  const visibleCount = Math.min(itemCount, maxVisible);
  const gap = Math.max(0, Number(options.gap ?? 4));
  const padding = Math.max(0, Number(options.padding ?? 0));
  const inner = rect(
    area.x + padding,
    area.y + padding,
    Math.max(1, area.width - padding * 2),
    Math.max(1, area.height - padding * 2),
  );

  if (!visibleCount) {
    return { slots: [], hiddenCount: 0 };
  }

  let best = null;
  for (let columns = 1; columns <= Math.min(maxColumns, visibleCount); columns += 1) {
    const rows = Math.ceil(visibleCount / columns);
    const scale = Math.min(
      1,
      (inner.width - gap * (columns - 1)) / (itemWidth * columns),
      (inner.height - gap * (rows - 1)) / (itemHeight * rows),
    );
    if (scale <= 0) {
      continue;
    }

    const usedWidth = columns * itemWidth * scale + (columns - 1) * gap;
    const usedHeight = rows * itemHeight * scale + (rows - 1) * gap;
    const fillsArea = (usedWidth * usedHeight) / (inner.width * inner.height);
    const score = scale + fillsArea * 0.025;
    if (!best || score > best.score) {
      best = { columns, rows, scale, usedWidth, usedHeight, score };
    }
  }

  if (!best) {
    best = { columns: 1, rows: visibleCount, scale: 0.25, usedWidth: itemWidth * 0.25, usedHeight: visibleCount * itemHeight * 0.25 + (visibleCount - 1) * gap };
  }

  const startX = inner.x + Math.max(0, (inner.width - best.usedWidth) / 2);
  const startY = inner.y + Math.max(0, (inner.height - best.usedHeight) / 2);
  const slots = [];
  for (let index = 0; index < visibleCount; index += 1) {
    const column = index % best.columns;
    const row = Math.floor(index / best.columns);
    slots.push({
      column,
      row,
      scale: best.scale,
      x: startX + column * (itemWidth * best.scale + gap),
      y: startY + row * (itemHeight * best.scale + gap),
      width: itemWidth * best.scale,
      height: itemHeight * best.scale,
    });
  }

  return {
    slots,
    hiddenCount: itemCount - visibleCount,
  };
}

export function validateVisualGameLayout(layout = VISUAL_GAME_MAP_LAYOUT) {
  const issues = [];
  const grid = layout.grid || {};
  const columns = Number(grid.columns);
  const rows = Number(grid.rows);
  const places = Object.values(layout.places || {});
  const occupiedPlaces = new Map();

  if (!Number.isInteger(columns) || columns <= 0 || !Number.isInteger(rows) || rows <= 0) {
    issues.push("grid dimensions must be positive integers");
  }

  for (const place of places) {
    const id = place.id || "unknown";
    if (!cellInsideGrid(place.cell, columns, rows)) {
      issues.push(`${id} escapes the grid`);
      continue;
    }

    for (const cell of cellsInRect(place.cell.column, place.cell.row, place.cell.width, place.cell.height)) {
      const key = getCellKey(cell);
      const previous = occupiedPlaces.get(key);
      if (previous) {
        issues.push(`${id} overlaps ${previous} at ${key}`);
      }
      occupiedPlaces.set(key, id);
    }

    if (Array.isArray(place.spots)) {
      for (const [index, spot] of place.spots.entries()) {
        if (!pointInsideWorld(spot, layout.width, layout.height)) {
          issues.push(`${id} spot ${index + 1} escapes the map bounds`);
        }
      }
    }

    if (place.factory) {
      const factory = place.factory;
      const packing = getVisualGamePackedItemSlots(place.rect, Number(factory.maxVisible || factory.columns || 1), {
        gap: factory.gap,
        itemSize: factory.size,
        maxColumns: factory.columns,
        maxVisible: factory.maxVisible,
        padding: factory.padding,
      });
      for (const [slotIndex, slot] of packing.slots.entries()) {
        if (!rectContainsRect(place.rect, slot, 1)) {
          issues.push(`${id} factory slot ${slotIndex + 1} does not fit inside its yard`);
        }
      }
    }
  }

  for (const road of layout.roads || []) {
    for (const cell of road.cells || []) {
      if (!cellInsideGrid(cell, columns, rows)) {
        issues.push(`${road.id} road cell escapes the grid`);
        continue;
      }
      const placeId = occupiedPlaces.get(getCellKey(cell));
      if (placeId) {
        issues.push(`${road.id} road overlaps ${placeId} at ${getCellKey(cell)}`);
      }
    }
  }

  const roadRects = getVisualGameRoadRects(layout);
  for (const place of places) {
    if (!place.entrance) {
      continue;
    }

    const anchor = getVisualGamePlaceAnchor(place);
    if (!roadRects.some((road) => pointInsideRect(anchor, road.rect))) {
      issues.push(`${place.id} entrance does not touch a road cell`);
    }
  }

  for (const [routeIndex, route] of (layout.roamRoutes || []).entries()) {
    for (const [pointIndex, entry] of route.entries()) {
      if (!pointInsideWorld(entry, layout.width, layout.height)) {
        issues.push(`roam route ${routeIndex + 1} point ${pointIndex + 1} escapes the map bounds`);
      }
      const previous = route[pointIndex - 1];
      if (previous && previous.x !== entry.x && previous.y !== entry.y) {
        issues.push(`roam route ${routeIndex + 1} segment ${pointIndex} is diagonal`);
      }
    }
  }

  return issues;
}

function getCellKey(cell) {
  return `${cell.column},${cell.row}`;
}

function normalizeRoutePoint(entry) {
  const x = Number(entry?.x ?? entry?.[0]);
  const y = Number(entry?.y ?? entry?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  return point(x, y);
}

function normalizeRouteRect(entry, index) {
  const x = Number(entry?.x);
  const y = Number(entry?.y);
  const width = Number(entry?.width);
  const height = Number(entry?.height);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }

  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    id: entry?.id || `road-${index}`,
    rect: { x, y, width, height },
  };
}

function routeRectsConnect(left, right, tolerance = 0) {
  const xOverlap = routeRangeOverlap(left.x, left.x + left.width, right.x, right.x + right.width);
  const yOverlap = routeRangeOverlap(left.y, left.y + left.height, right.y, right.y + right.height);
  if (xOverlap > tolerance && yOverlap > tolerance) {
    return true;
  }

  const horizontalTouch =
    yOverlap > tolerance
    && (
      Math.abs(left.x + left.width - right.x) <= tolerance
      || Math.abs(right.x + right.width - left.x) <= tolerance
    );
  const verticalTouch =
    xOverlap > tolerance
    && (
      Math.abs(left.y + left.height - right.y) <= tolerance
      || Math.abs(right.y + right.height - left.y) <= tolerance
    );

  return horizontalTouch || verticalTouch;
}

function routeRangeOverlap(leftMin, leftMax, rightMin, rightMax) {
  return Math.min(leftMax, rightMax) - Math.max(leftMin, rightMin);
}

function getNearestRouteNodeIndex(point, nodes) {
  let best = null;
  for (const node of nodes) {
    const rectDistance = pointToRectDistance(point, node.rect);
    const centerDistance = pointDistance(point, node.point);
    const score = rectDistance * 1000 + centerDistance;
    if (!best || score < best.score) {
      best = { index: node.index, score };
    }
  }

  return best?.index ?? -1;
}

function getShortestRouteNodeIndexes(nodes, startIndex, targetIndex) {
  if (startIndex === targetIndex) {
    return [startIndex];
  }

  const distances = Array.from({ length: nodes.length }, () => Infinity);
  const previous = Array.from({ length: nodes.length }, () => -1);
  const unvisited = new Set(nodes.map((node) => node.index));
  distances[startIndex] = 0;

  while (unvisited.size) {
    let currentIndex = -1;
    let currentDistance = Infinity;
    for (const index of unvisited) {
      if (distances[index] < currentDistance) {
        currentDistance = distances[index];
        currentIndex = index;
      }
    }

    if (currentIndex < 0 || !Number.isFinite(currentDistance)) {
      break;
    }

    unvisited.delete(currentIndex);
    if (currentIndex === targetIndex) {
      break;
    }

    for (const edge of nodes[currentIndex].edges) {
      if (!unvisited.has(edge.index)) {
        continue;
      }

      const distance = currentDistance + edge.weight;
      if (distance < distances[edge.index]) {
        distances[edge.index] = distance;
        previous[edge.index] = currentIndex;
      }
    }
  }

  if (!Number.isFinite(distances[targetIndex])) {
    return [];
  }

  const route = [];
  for (let index = targetIndex; index >= 0; index = previous[index]) {
    route.unshift(index);
    if (index === startIndex) {
      return route;
    }
  }

  return [];
}

function compactVisualGameRoute(route) {
  const points = [];
  for (const entry of route) {
    const routePoint = normalizeRoutePoint(entry);
    if (!routePoint) {
      continue;
    }

    const previous = points[points.length - 1];
    if (previous && pointDistance(previous, routePoint) < 0.001) {
      continue;
    }

    while (
      points.length >= 2
      && routePointsAreCollinear(points[points.length - 2], points[points.length - 1], routePoint)
    ) {
      points.pop();
    }

    points.push(routePoint);
  }

  return points;
}

function routePointsAreCollinear(left, middle, right) {
  const tolerance = 0.001;
  return (
    Math.abs(left.x - middle.x) <= tolerance && Math.abs(middle.x - right.x) <= tolerance
  ) || (
    Math.abs(left.y - middle.y) <= tolerance && Math.abs(middle.y - right.y) <= tolerance
  );
}

function pointDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function pointToRectDistance(entry, area) {
  const dx = entry.x < area.x ? area.x - entry.x : entry.x > area.x + area.width ? entry.x - (area.x + area.width) : 0;
  const dy = entry.y < area.y ? area.y - entry.y : entry.y > area.y + area.height ? entry.y - (area.y + area.height) : 0;
  return Math.hypot(dx, dy);
}

function cellInsideGrid(cell, columns, rows) {
  return (
    Number.isInteger(Number(cell?.column))
    && Number.isInteger(Number(cell?.row))
    && Number.isInteger(Number(cell?.width))
    && Number.isInteger(Number(cell?.height))
    && cell.column >= 0
    && cell.row >= 0
    && cell.width > 0
    && cell.height > 0
    && cell.column + cell.width <= columns
    && cell.row + cell.height <= rows
  );
}

function pointInsideWorld(entry, width, height) {
  return Number(entry?.x) >= 0 && Number(entry?.x) <= width && Number(entry?.y) >= 0 && Number(entry?.y) <= height;
}

function rectContainsRect(outer, inner, padding = 0) {
  return (
    inner.x >= outer.x - padding
    && inner.y >= outer.y - padding
    && inner.x + inner.width <= outer.x + outer.width + padding
    && inner.y + inner.height <= outer.y + outer.height + padding
  );
}

function pointInsideRect(entry, area, padding = 0) {
  return (
    Number(entry?.x) >= area.x - padding
    && Number(entry?.x) <= area.x + area.width + padding
    && Number(entry?.y) >= area.y - padding
    && Number(entry?.y) <= area.y + area.height + padding
  );
}
