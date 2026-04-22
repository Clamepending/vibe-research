import assert from "node:assert/strict";
import test from "node:test";
import {
  VISUAL_GAME_MAP_LAYOUT,
  getVisualGamePlace,
  getVisualGamePlaceItemSlots,
  getVisualGameRoadRects,
  validateVisualGameLayout,
} from "../src/client/visual-game-layout.js";

test("visual game map layout has no overlapping spaces or diagonal roads", () => {
  assert.deepEqual(validateVisualGameLayout(VISUAL_GAME_MAP_LAYOUT), []);
});

test("visual game roads render as exact grid cells", () => {
  const roadRects = getVisualGameRoadRects(VISUAL_GAME_MAP_LAYOUT);
  const cellSize = VISUAL_GAME_MAP_LAYOUT.grid.cellSize;

  assert.ok(roadRects.length > 0);
  for (const road of roadRects) {
    assert.equal(road.rect.x % cellSize, 0);
    assert.equal(road.rect.y % cellSize, 0);
    assert.equal(road.rect.width % cellSize, 0);
    assert.equal(road.rect.height % cellSize, 0);
  }
});

test("visual game machine slots scale to stay inside the GPU yard", () => {
  const yard = getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "gpuYard");
  const factory = yard.factory;
  const packed = getVisualGamePlaceItemSlots(VISUAL_GAME_MAP_LAYOUT, "gpuYard", factory.maxVisible, {
    gap: factory.gap,
    itemSize: factory.size,
    maxColumns: factory.columns,
    maxVisible: factory.maxVisible,
    padding: factory.padding,
  });

  assert.equal(packed.slots.length, factory.maxVisible);
  assert.equal(packed.hiddenCount, 0);
  assert.ok(packed.slots.some((slot) => slot.scale < 1));
  for (const slot of packed.slots) {
    assert.ok(slot.x >= yard.rect.x);
    assert.ok(slot.y >= yard.rect.y);
    assert.ok(slot.x + slot.width <= yard.rect.x + yard.rect.width);
    assert.ok(slot.y + slot.height <= yard.rect.y + yard.rect.height);
  }
});

test("visual game machine slots summarize overflow devices", () => {
  const yard = getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "gpuYard");
  const factory = yard.factory;
  const packed = getVisualGamePlaceItemSlots(VISUAL_GAME_MAP_LAYOUT, "gpuYard", 20, {
    gap: factory.gap,
    itemSize: factory.size,
    maxColumns: factory.columns,
    maxVisible: factory.maxVisible,
    padding: factory.padding,
  });

  assert.equal(packed.slots.length, factory.maxVisible);
  assert.equal(packed.hiddenCount, 12);
});
