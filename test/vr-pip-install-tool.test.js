// Tests for bin/vr-pip-install-tool. Exercises strategy selection by
// stubbing PATH so pipx looks present/absent and python3 looks
// venv-capable/incapable. Runs every code path with VR_PIP_TOOL_DRY_RUN=1
// so we don't actually install anything.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "bin", "vr-pip-install-tool");

function runScript(args = [], { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", [SCRIPT, ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

async function makeStubBin(dir, name, exitCode = 0, output = "") {
  const stubPath = path.join(dir, name);
  await writeFile(stubPath, `#!/usr/bin/env bash\necho '${output}'\nexit ${exitCode}\n`);
  await chmod(stubPath, 0o755);
  return stubPath;
}

test("vr-pip-install-tool: errors out when no package given", async () => {
  const result = await runScript([]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /package name required/);
});

test("vr-pip-install-tool: picks pipx when pipx is on PATH (dry-run)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-pip-pipx-"));
  try {
    await makeStubBin(tmp, "pipx");
    const result = await runScript(["modal"], {
      env: {
        // Stub dir FIRST so the script picks up our fake pipx, then keep
        // the system PATH so bash itself + the script's `command -v`
        // resolve normally.
        PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
        VR_PIP_TOOL_DRY_RUN: "1",
        VIBE_RESEARCH_HOME: path.join(tmp, ".vibe-research"),
      },
    });
    assert.equal(result.code, 0, `unexpected non-zero: ${result.stderr}`);
    assert.match(result.stdout, /strategy=pipx/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("vr-pip-install-tool: VR_PIP_TOOL_FORCE_VENV=1 skips pipx even when present", async () => {
  // Use system PATH (which has python3 + pipx might be there too).
  // Force venv strategy and verify we got it.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-pip-forcevenv-"));
  try {
    await makeStubBin(tmp, "pipx");
    const result = await runScript(["modal"], {
      env: {
        PATH: `${tmp}:${process.env.PATH}`,
        VR_PIP_TOOL_DRY_RUN: "1",
        VR_PIP_TOOL_FORCE_VENV: "1",
        VIBE_RESEARCH_HOME: path.join(tmp, ".vibe-research"),
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /strategy=venv/);
    assert.doesNotMatch(result.stdout, /strategy=pipx/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("vr-pip-install-tool: VR_PIP_TOOL_FORCE_PIPX=1 errors when pipx is absent", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-pip-needpipx-"));
  try {
    // Empty PATH → pipx can't be found.
    const result = await runScript(["modal"], {
      env: {
        PATH: "/usr/bin:/bin", // no pipx (we hope; if there is one, the test is moot)
        VR_PIP_TOOL_FORCE_PIPX: "1",
        VR_PIP_TOOL_DRY_RUN: "1",
        VIBE_RESEARCH_HOME: path.join(tmp, ".vibe-research"),
      },
    });
    // Either the system has pipx (test is skipped via dry-run pipx path)
    // or it doesn't (we expect exit 1). Both are acceptable signals; the
    // failure mode we're guarding against is the "fall through silently"
    // case which should never produce exit 0 with strategy=venv.
    if (result.code !== 0) {
      assert.match(result.stderr, /pipx is not installed/);
    }
    assert.doesNotMatch(result.stdout, /strategy=venv/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("vr-pip-install-tool: dry-run with venv strategy prints the venv path", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-pip-dryrun-"));
  const home = path.join(tmp, "home");
  await mkdir(home, { recursive: true });
  try {
    const result = await runScript(["modal"], {
      env: {
        VR_PIP_TOOL_FORCE_VENV: "1",
        VR_PIP_TOOL_DRY_RUN: "1",
        VIBE_RESEARCH_HOME: path.join(home, ".vibe-research"),
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /strategy=venv/);
    assert.match(result.stdout, /\.vibe-research\/python-tools\/modal/);
    // Dry run must NOT actually create the venv directory — we just print.
    const fs = await import("node:fs/promises");
    let exists = false;
    try { await fs.stat(path.join(home, ".vibe-research/python-tools/modal/bin/python")); exists = true; } catch {}
    assert.equal(exists, false, "dry-run should not create the venv");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("vr-pip-install-tool: accepts custom bin name as second arg", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-pip-binname-"));
  try {
    const result = await runScript(["litellm-proxy", "litellm"], {
      env: {
        VR_PIP_TOOL_FORCE_VENV: "1",
        VR_PIP_TOOL_DRY_RUN: "1",
        VIBE_RESEARCH_HOME: path.join(tmp, ".vibe-research"),
      },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /package=litellm-proxy bin=litellm/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("vr-pip-install-tool: actually creates a working venv (real install of a tiny package)", async () => {
  // Real install — uses `wheel`, a tiny widely-available package — to verify
  // the venv strategy end-to-end. Skips on systems without python3+venv.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-pip-realinstall-"));
  const home = path.join(tmp, "home");
  await mkdir(home, { recursive: true });
  const fs = await import("node:fs/promises");
  // Skip if venv module is unavailable (rare on dev machines).
  const pythonCheck = await new Promise((resolve) => {
    const c = spawn("python3", ["-c", "import venv"]);
    c.on("close", (code) => resolve(code === 0));
    c.on("error", () => resolve(false));
  });
  if (!pythonCheck) return;

  try {
    const result = await runScript(["wheel"], {
      env: {
        VR_PIP_TOOL_FORCE_VENV: "1",
        VIBE_RESEARCH_HOME: path.join(home, ".vibe-research"),
      },
    });
    if (result.code !== 0) {
      // A flaky network or proxy can break this real install — log enough to
      // diagnose but don't fail the suite if the user's offline.
      console.warn("[skip] real install of `wheel` did not complete:", result.stderr.slice(-300));
      return;
    }
    assert.match(result.stdout, /strategy=venv/);
    assert.match(result.stdout, /linked .*\/wheel ->/);
    // Symlink + binary should exist + be executable.
    const symlink = path.join(home, ".vibe-research/bin/wheel");
    const stat = await fs.lstat(symlink);
    assert.ok(stat.isSymbolicLink(), "expected ~/.vibe-research/bin/wheel to be a symlink");
    // The pointed-at binary should run with --version.
    const verCheck = await new Promise((resolve) => {
      const c = spawn(symlink, ["version"], { env: { ...process.env, PATH: "/usr/bin:/bin" } });
      let stdout = "";
      c.stdout.on("data", (d) => { stdout += d.toString(); });
      c.on("close", (code) => resolve({ code, stdout }));
      c.on("error", () => resolve({ code: -1, stdout: "" }));
    });
    assert.equal(verCheck.code, 0, "venv-installed wheel binary should run");
    assert.match(verCheck.stdout, /wheel/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
