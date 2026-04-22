import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getBuildingAgentGuidePath,
  getBuildingAgentGuidesDir,
  renderBuildingAgentGuide,
  writeBuildingAgentGuides,
} from "../src/building-agent-guides.js";
import { BUILDING_CATALOG } from "../src/client/building-registry.js";
import { defineBuilding } from "../src/client/building-sdk.js";

test("writeBuildingAgentGuides writes an index and one guide per catalog building", async () => {
  const systemRootPath = await mkdtemp(path.join(os.tmpdir(), "vr-building-guides-"));
  const duplicateTailscale = defineBuilding({
    id: "tailscale",
    name: "Fake Tailscale",
    description: "This duplicate should not replace the core guide.",
  });

  try {
    const guidesDir = getBuildingAgentGuidesDir(systemRootPath);
    await mkdir(guidesDir, { recursive: true });
    await writeFile(path.join(guidesDir, "stale.md"), "old guide\n", "utf8");

    const result = await writeBuildingAgentGuides({
      buildings: [...BUILDING_CATALOG, duplicateTailscale],
      generatedAt: "2026-04-22T00:00:00.000Z",
      systemRootPath,
    });

    assert.equal(result.count, BUILDING_CATALOG.length);
    assert.equal(result.dir, guidesDir);
    assert.equal(result.guidePaths.length, BUILDING_CATALOG.length);

    const entries = await readdir(guidesDir);
    assert.ok(entries.includes("README.md"));
    assert.ok(!entries.includes("stale.md"));

    const index = await readFile(result.indexPath, "utf8");
    assert.match(index, /# Vibe Research Building Guides/);
    assert.match(index, /\$VIBE_RESEARCH_BUILDING_GUIDES_INDEX/);
    assert.match(index, /\[Tailscale\]\(\.\/tailscale\.md\)/);

    for (const building of BUILDING_CATALOG) {
      const guide = await readFile(getBuildingAgentGuidePath(systemRootPath, building.id), "utf8");
      assert.match(guide, new RegExp(`id: \`${building.id}\``));
      assert.match(guide, /## Agent Rules/);
    }

    const tailscaleGuide = await readFile(getBuildingAgentGuidePath(systemRootPath, "tailscale"), "utf8");
    assert.match(tailscaleGuide, /Tailnet portal/);
    assert.match(tailscaleGuide, /tailscale status/);
    assert.match(tailscaleGuide, /Tailscale Serve docs/);
    assert.doesNotMatch(tailscaleGuide, /This duplicate should not replace the core guide/);
  } finally {
    await rm(systemRootPath, { recursive: true, force: true });
  }
});

test("renderBuildingAgentGuide gives agents a usable fallback from core manifest fields", () => {
  const building = defineBuilding({
    id: "Example Docs",
    name: "Example Docs",
    category: "Knowledge",
    description: "Search a documentation archive.",
    onboarding: {
      variables: [
        {
          label: "API key",
          setting: "exampleDocsApiKey",
          configuredSetting: "exampleDocsApiKeyConfigured",
          required: true,
          secret: true,
        },
      ],
      steps: [
        {
          title: "Save variables",
          detail: "Add the API key before using the helper.",
          completeWhen: { allConfigured: ["exampleDocsApiKeyConfigured"] },
        },
      ],
    },
  });

  const guide = renderBuildingAgentGuide(building);

  assert.match(guide, /# Example Docs Building Guide/);
  assert.match(guide, /Search a documentation archive\./);
  assert.match(guide, /No explicit access model declared/);
  assert.match(guide, /API key \(required; secret; never print its value; setting: exampleDocsApiKey/);
  assert.match(guide, /Save variables: Add the API key before using the helper/);
  assert.match(guide, /Never write secrets/);
});
