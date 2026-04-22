import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { SessionStore } from "../src/session-store.js";

test("SessionStore serializes overlapping saves without corrupting sessions.json", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "vr-session-store-"));
  const store = new SessionStore({ stateDir });

  try {
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.save([
          {
            id: `session-${index}`,
            providerId: "shell",
            status: "running",
          },
        ]),
      ),
    );

    const sessions = await store.load();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "session-24");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
