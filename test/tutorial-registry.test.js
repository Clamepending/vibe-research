import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { TutorialRegistry } from "../src/tutorial-registry.js";

async function createTempTutorialsDir() {
  return mkdtemp(path.join(os.tmpdir(), "vibe-research-tutorials-"));
}

async function removeTempTutorialsDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

test("TutorialRegistry loads valid tutorials sorted by order and returns bodies via get()", async () => {
  const tutorialsDir = await createTempTutorialsDir();
  try {
    await writeFile(
      path.join(tutorialsDir, "c-one.md"),
      "---\nid: connect-telegram\ntitle: Connect Telegram\nbuildingId: telegram\nsummary: Telegram summary.\norder: 10\n---\n\n# Connect Telegram\n\nBody text.\n",
      "utf8",
    );
    await writeFile(
      path.join(tutorialsDir, "a-two.md"),
      "---\nid: connect-cameras\ntitle: Connect cameras\nbuildingId: browser-use\nsummary: Cameras summary.\norder: 20\n---\n\n# Cameras\n\nSecond body.\n",
      "utf8",
    );
    await writeFile(
      path.join(tutorialsDir, "b-three.md"),
      "---\nid: connect-stripe\ntitle: Connect Stripe\nbuildingId: wallet\nsummary: Stripe summary.\norder: 30\n---\n\n# Stripe\n\nThird body.\n",
      "utf8",
    );

    const registry = new TutorialRegistry({ tutorialsDir });
    await registry.load();

    const list = registry.list();
    assert.deepEqual(
      list.map((entry) => entry.id),
      ["connect-telegram", "connect-cameras", "connect-stripe"],
    );
    assert.equal(list[0].title, "Connect Telegram");
    assert.equal(list[0].buildingId, "telegram");
    assert.equal(list[0].summary, "Telegram summary.");
    assert.equal(list[0].priority, "normal");
    assert.ok(!("body" in list[0]), "list() entries should not include body");

    const full = registry.get("connect-cameras");
    assert.ok(full);
    assert.equal(full.title, "Connect cameras");
    assert.match(full.body, /Second body\./);
  } finally {
    await removeTempTutorialsDir(tutorialsDir);
  }
});

test("TutorialRegistry skips malformed frontmatter with a warning instead of throwing", async () => {
  const tutorialsDir = await createTempTutorialsDir();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(" "));
  };

  try {
    await writeFile(
      path.join(tutorialsDir, "valid.md"),
      "---\nid: ok\ntitle: Ok\n---\n\nHello.\n",
      "utf8",
    );
    await writeFile(path.join(tutorialsDir, "no-frontmatter.md"), "# Hi\n\nNo frontmatter here.\n", "utf8");
    await writeFile(
      path.join(tutorialsDir, "missing-id.md"),
      "---\ntitle: Has title only\n---\n\nBody.\n",
      "utf8",
    );

    const registry = new TutorialRegistry({ tutorialsDir });
    await registry.load();

    assert.deepEqual(
      registry.list().map((entry) => entry.id),
      ["ok"],
    );
    assert.ok(
      warnings.some((entry) => /no-frontmatter/.test(entry)),
      "expected a warning for missing frontmatter",
    );
    assert.ok(
      warnings.some((entry) => /missing-id/.test(entry)),
      "expected a warning for missing required fields",
    );
  } finally {
    console.warn = originalWarn;
    await removeTempTutorialsDir(tutorialsDir);
  }
});

test("TutorialRegistry deduplicates by id with last one winning", async () => {
  const tutorialsDir = await createTempTutorialsDir();
  try {
    await writeFile(
      path.join(tutorialsDir, "a-first.md"),
      "---\nid: dup\ntitle: First title\n---\n\nFirst body.\n",
      "utf8",
    );
    await writeFile(
      path.join(tutorialsDir, "z-second.md"),
      "---\nid: dup\ntitle: Second title\n---\n\nSecond body.\n",
      "utf8",
    );

    const registry = new TutorialRegistry({ tutorialsDir });
    await registry.load();

    const list = registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, "dup");
    assert.equal(list[0].title, "Second title");
    assert.match(registry.get("dup").body, /Second body\./);
  } finally {
    await removeTempTutorialsDir(tutorialsDir);
  }
});
