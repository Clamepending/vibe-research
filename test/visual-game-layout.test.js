import assert from "node:assert/strict";
import test from "node:test";
import {
  VISUAL_GAME_MAP_LAYOUT,
  findVisualGameRoadRoute,
  getVisualGameAgentIdentityKey,
  getVisualGamePlace,
  getVisualGamePlaceAnchor,
  getVisualGamePlaceItemSlots,
  getVisualGameRoadRects,
  validateVisualGameLayout,
} from "../src/client/visual-game-layout.js";

test("visual game map layout has no overlapping spaces or diagonal roads", () => {
  assert.deepEqual(validateVisualGameLayout(VISUAL_GAME_MAP_LAYOUT), []);
});

test("visual game agent identity keys stay stable across wake-up reorderings", () => {
  const sleepingSession = getVisualGameAgentIdentityKey(
    { sessionId: "session-1", kind: "chat", name: "Quiet Agent" },
    7,
  );
  const awakeSession = getVisualGameAgentIdentityKey(
    { sessionId: "session-1", kind: "chat", name: "Renamed Agent" },
    0,
  );

  assert.equal(awakeSession, sleepingSession);
});

test("visual game agent identity keys prefer child agent ids over parent session ids", () => {
  assert.equal(
    getVisualGameAgentIdentityKey({
      sessionId: "parent-session",
      browserUseSessionId: "browser-child",
      kind: "browser",
      name: "Browser task",
    }),
    "browser:browser-child",
  );
  assert.equal(
    getVisualGameAgentIdentityKey({
      sessionId: "parent-session",
      subagentId: "claude-parent:agent-123",
      agentId: "display-123",
      kind: "helper",
      name: "Read docs",
    }),
    "subagent:claude-parent:agent-123",
  );
  assert.equal(
    getVisualGameAgentIdentityKey({
      parentSessionId: "parent-session",
      agentId: "display-123",
      kind: "helper",
      name: "Read docs",
    }),
    "subagent:parent-session:display-123",
  );
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

test("visual game map gives the town a larger build area", () => {
  assert.ok(VISUAL_GAME_MAP_LAYOUT.width >= 900);
  assert.ok(VISUAL_GAME_MAP_LAYOUT.height >= 540);
});

test("visual game pathfinding routes destination walks through connected roads", () => {
  const roadRects = getVisualGameRoadRects(VISUAL_GAME_MAP_LAYOUT);
  const route = findVisualGameRoadRoute(
    getVisualGamePlaceAnchor(getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "workshop")),
    getVisualGamePlaceAnchor(getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "library")),
    roadRects,
  );

  assert.deepEqual(route[0], getVisualGamePlaceAnchor(getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "workshop")));
  assert.deepEqual(route.at(-1), getVisualGamePlaceAnchor(getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "library")));
  assert.ok(route.length > 2);

  const roadSegments = route.slice(1, -1);
  assert.ok(roadSegments.some((point) => point.y === 255));
  for (let index = 1; index < roadSegments.length; index += 1) {
    const previous = roadSegments[index - 1];
    const current = roadSegments[index];
    assert.ok(previous.x === current.x || previous.y === current.y);
  }
});

test("visual game map has an OttoAuth building reachable from town roads", () => {
  const ottoauth = getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "ottoauth");
  const workshop = getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "workshop");
  const roadRects = getVisualGameRoadRects(VISUAL_GAME_MAP_LAYOUT);
  const route = findVisualGameRoadRoute(
    getVisualGamePlaceAnchor(workshop),
    getVisualGamePlaceAnchor(ottoauth),
    roadRects,
  );

  assert.equal(ottoauth.label, "OttoAuth");
  assert.ok(route.length > 2);
  assert.deepEqual(route[0], getVisualGamePlaceAnchor(workshop));
  assert.deepEqual(route.at(-1), getVisualGamePlaceAnchor(ottoauth));
});

test("visual game map has a Campanile-style Automations tower reachable from town roads", () => {
  const automations = getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "automations");
  const workshop = getVisualGamePlace(VISUAL_GAME_MAP_LAYOUT, "workshop");
  const roadRects = getVisualGameRoadRects(VISUAL_GAME_MAP_LAYOUT);
  const route = findVisualGameRoadRoute(
    getVisualGamePlaceAnchor(workshop),
    getVisualGamePlaceAnchor(automations),
    roadRects,
  );

  assert.equal(automations.label, "Automations");
  assert.ok(automations.rect.height > automations.rect.width);
  assert.ok(route.length > 2);
  assert.deepEqual(route[0], getVisualGamePlaceAnchor(workshop));
  assert.deepEqual(route.at(-1), getVisualGamePlaceAnchor(automations));
});

test("visual game pathfinding falls back to direct routes without roads", () => {
  const route = findVisualGameRoadRoute({ x: 5, y: 6 }, { x: 40, y: 44 }, []);

  assert.deepEqual(route, [
    { x: 5, y: 6 },
    { x: 40, y: 44 },
  ]);
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
