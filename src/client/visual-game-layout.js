const VISUAL_GAME_GRID_COLUMNS = 16;
const VISUAL_GAME_GRID_ROWS = 9;
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
    { id: "main", cells: cellsInRect(2, 4, 14, 1) },
    { id: "dormitory-spur", cells: cellsInRect(2, 2, 1, 2) },
    { id: "gpu-yard-spur", cells: cellsInRect(8, 5, 1, 1) },
    { id: "dock-spur", cells: cellsInRect(15, 5, 1, 2) },
  ],
  places: {
    dormitory: place("dormitory", "Dormitory", 0, 0, 6, 2, {
      entrance: { side: "bottom", offset: 2.5 / 6 },
      beds: [
        point(29, 41),
        point(58, 41),
        point(87, 41),
        point(116, 41),
        point(145, 41),
      ],
      spots: [
        cellCenter(1, 1, 0, 2),
        cellCenter(2, 1, 0, 2),
        cellCenter(3, 1, 0, 2),
        cellCenter(4, 1, 0, 2),
        cellCenter(5, 1, -8, 2),
      ],
    }),
    library: place("library", "Library", 0, 5, 5, 2, {
      entrance: { side: "top", offset: 2.5 / 5 },
      spots: [
        cellCenter(1, 6, -2, 2),
        cellCenter(2, 6, -1, 3),
        cellCenter(3, 6, 0, 2),
        cellCenter(2, 5, 0, 8),
      ],
    }),
    workshop: place("workshop", "Computer Lab", 7, 0, 5, 4, {
      entrance: { side: "bottom", offset: 2.5 / 5 },
      spots: [
        cellCenter(7, 2, 10, -9),
        cellCenter(8, 2, 20, -9),
        cellCenter(10, 2, 0, -9),
        cellCenter(7, 3, 10, -4),
        cellCenter(8, 3, 20, -4),
        cellCenter(10, 3, 0, -4),
      ],
    }),
    browser: place("browser", "Browser", 13, 0, 3, 4, {
      entrance: { side: "bottom", offset: 1.5 / 3 },
      spots: [
        cellCenter(13, 2, 10, -9),
        cellCenter(14, 2, 10, -9),
        cellCenter(13, 3, 10, -4),
        cellCenter(14, 3, 10, -4),
      ],
    }),
    camera: place("camera", "Camera", 11, 5, 4, 2, {
      entrance: { side: "top", offset: 2 / 4 },
      spots: [
        cellCenter(12, 6, -6, 3),
        cellCenter(13, 6, -3, 3),
        cellCenter(12, 5, -6, 15),
        cellCenter(13, 5, -3, 15),
      ],
    }),
    gpuYard: place("gpuYard", "GPU Yard", 5, 6, 6, 3, {
      entrance: { side: "top", offset: 3.5 / 6 },
      factory: {
        columns: 4,
        gap: 4,
        maxVisible: 8,
        padding: 8,
        size: { width: 54, height: 42 },
      },
    }),
    dock: place("dock", "Port Dock", 13, 7, 3, 2, {
      entrance: { side: "top", offset: 2.5 / 3 },
    }),
  },
  roamRoutes: [
    [cellCenter(2, 4), cellCenter(5, 4), cellCenter(8, 4), cellCenter(11, 4), cellCenter(15, 4), cellCenter(8, 4)],
    [cellCenter(2, 4), cellCenter(2, 3), cellCenter(2, 2), cellCenter(4, 2), cellCenter(4, 4)],
    [cellCenter(9, 4), cellCenter(9, 3), cellCenter(11, 3), cellCenter(11, 4), cellCenter(14, 4)],
    [cellCenter(13, 4), cellCenter(13, 5), cellCenter(13, 6), cellCenter(15, 6), cellCenter(15, 4)],
    [cellCenter(8, 4), cellCenter(8, 5), cellCenter(8, 6), cellCenter(6, 6), cellCenter(6, 4)],
    [cellCenter(15, 4), cellCenter(15, 5), cellCenter(15, 6), cellCenter(14, 6), cellCenter(14, 4)],
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

export function getVisualGameRoadRects(layout = VISUAL_GAME_MAP_LAYOUT) {
  return (layout.roads || []).flatMap((road) =>
    (road.cells || []).map((cell) => ({
      id: road.id,
      cell,
      rect: cellRect(cell),
    })),
  );
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
