import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("vibe-research --url defaults to the current local app port", async () => {
  const scriptPath = fileURLToPath(new URL("../bin/vibe-research", import.meta.url));
  const { stdout } = await execFileAsync(scriptPath, ["--url"], {
    env: {
      ...process.env,
      LC_ALL: "C",
    },
  });

  assert.equal(stdout.trim(), "http://localhost:4826/");
});
