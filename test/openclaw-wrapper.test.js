import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const wrapperPath = path.join(rootDir, "bin", "openclaw");

test("openclaw wrapper runs the real CLI with a supported node even when PATH has old node first", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-openclaw-wrapper-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const fakeOpenClawPath = path.join(tempDir, "openclaw.mjs");
  const fakeOldNodePath = path.join(fakeBinDir, "node");
  const fakeNode22Path = path.join(tempDir, "node22");
  const capturePath = path.join(tempDir, "capture.txt");

  try {
    await mkdir(fakeBinDir, { recursive: true });
    await writeFile(fakeOpenClawPath, "#!/usr/bin/env node\nprocess.exit(0)\n", "utf8");
    await writeFile(fakeOldNodePath, "#!/usr/bin/env bash\nexit 42\n", "utf8");
    await writeFile(
      fakeNode22Path,
      [
        "#!/usr/bin/env bash",
        "if [ \"$1\" = \"-e\" ]; then",
        "  exit 0",
        "fi",
        "printf 'node=%s\\n' \"$0\" > \"$CAPTURE_PATH\"",
        "printf 'args=%s\\n' \"$*\" >> \"$CAPTURE_PATH\"",
        "printf 'path=%s\\n' \"$PATH\" >> \"$CAPTURE_PATH\"",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeOpenClawPath, 0o755);
    await chmod(fakeOldNodePath, 0o755);
    await chmod(fakeNode22Path, 0o755);

    await execFileAsync(wrapperPath, ["tui"], {
      env: {
        CAPTURE_PATH: capturePath,
        HOME: tempDir,
        OPENCLAW_NODE: fakeNode22Path,
        PATH: `${fakeBinDir}:/usr/bin:/bin`,
        VIBE_RESEARCH_REAL_OPENCLAW_COMMAND: fakeOpenClawPath,
      },
    });

    const capture = await readFile(capturePath, "utf8");
    assert.match(capture, new RegExp(`node=${fakeNode22Path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(capture, new RegExp(`args=${fakeOpenClawPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} tui`));
    assert.match(capture, new RegExp(`path=${path.dirname(fakeNode22Path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:`));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
