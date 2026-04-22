import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

test("vr-mailwatch emits a concise notification for new inbox messages", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-mailwatch-"));
  const inboxDir = path.join(workspaceDir, ".vibe-research", "wiki", "comms", "agents", "agent-123", "inbox");

  await mkdir(inboxDir, { recursive: true });

  const watcher = spawn(
    process.execPath,
    [path.join(process.cwd(), "bin", "vr-mailwatch"), "--inbox", inboxDir, "--interval", "0.2", "--no-bell", "--quiet"],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let combined = "";
  watcher.stdout.on("data", (chunk) => {
    combined += String(chunk);
  });
  watcher.stderr.on("data", (chunk) => {
    combined += String(chunk);
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 400));

    await writeFile(
      path.join(inboxDir, "2026-04-11T21-04-00Z-agent-456.md"),
      `---
from: agent-456
from_name: checkpoint worker
reply_to: agent-456
sent_at: 2026-04-11T21:04:00Z
subject: 1 GPU available for ~20 min after current checkpoint
---
I can spare 1 GPU once the current checkpoint finishes.
`,
      "utf8",
    );

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for mailwatch output. Saw: ${combined}`));
      }, 8_000);

      const poll = setInterval(() => {
        if (combined.includes("[vibe-research-mail]")) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 100);
    });

    assert.match(combined, /\[vibe-research-mail\]/);
    assert.match(combined, /checkpoint worker/);
    assert.match(combined, /1 GPU available for ~20 min after current checkpoint/);
    assert.match(combined, /2026-04-11T21:04:00Z/);
  } finally {
    watcher.kill("SIGTERM");
    await once(watcher, "exit");
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-mailwatch falls back to polling-only mode and still emits notifications", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-mailwatch-poll-"));
  const inboxDir = path.join(workspaceDir, ".vibe-research", "wiki", "comms", "agents", "agent-456", "inbox");

  await mkdir(inboxDir, { recursive: true });

  const watcher = spawn(
    process.execPath,
    [path.join(process.cwd(), "bin", "vr-mailwatch"), "--inbox", inboxDir, "--interval", "0.2", "--no-bell", "--quiet"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VIBE_RESEARCH_MAILWATCH_POLL_ONLY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let combined = "";
  watcher.stdout.on("data", (chunk) => {
    combined += String(chunk);
  });
  watcher.stderr.on("data", (chunk) => {
    combined += String(chunk);
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 400));

    await writeFile(
      path.join(inboxDir, "2026-04-11T21-05-00Z-agent-789.md"),
      `---
from: agent-789
from_name: research agent
reply_to: agent-789
sent_at: 2026-04-11T21:05:00Z
subject: Results note
---
The plot is ready for review.
`,
      "utf8",
    );

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for polling fallback output. Saw: ${combined}`));
      }, 8_000);

      const poll = setInterval(() => {
        if (combined.includes("[vibe-research-mail]")) {
          clearTimeout(timeout);
          clearInterval(poll);
          resolve();
        }
      }, 100);
    });

    assert.match(combined, /\[vibe-research-mail\]/);
    assert.match(combined, /research agent/);
    assert.match(combined, /Results note/);
  } finally {
    watcher.kill("SIGTERM");
    await once(watcher, "exit");
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-mailwatch can block once until a new message arrives", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-mailwatch-once-"));
  const inboxDir = path.join(workspaceDir, ".vibe-research", "wiki", "comms", "agents", "agent-once", "inbox");

  await mkdir(inboxDir, { recursive: true });

  const watcher = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "bin", "vr-mailwatch"),
      "--inbox",
      inboxDir,
      "--interval",
      "0.2",
      "--no-bell",
      "--quiet",
      "--once",
      "--timeout",
      "5",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let combined = "";
  watcher.stdout.on("data", (chunk) => {
    combined += String(chunk);
  });
  watcher.stderr.on("data", (chunk) => {
    combined += String(chunk);
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 400));

    await writeFile(
      path.join(inboxDir, "2026-04-11T21-06-00Z-agent-999.md"),
      `---
from: agent-999
from_name: eval runner
reply_to: agent-999
sent_at: 2026-04-11T21:06:00Z
subject: Ready now
---
You can start the run now.
`,
      "utf8",
    );

    const [exitCode] = await once(watcher, "exit");
    assert.equal(exitCode, 0);
    assert.match(combined, /\[vibe-research-mail\]/);
    assert.match(combined, /Ready now/);
  } finally {
    watcher.kill("SIGTERM");
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-mailwatch can match an already-present peer reply using --from and --after", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-mailwatch-filtered-"));
  const inboxDir = path.join(workspaceDir, ".vibe-research", "wiki", "comms", "groups", "resource-hall", "inbox");
  const baselineSentAt = "2026-04-11T21:10:00Z";
  const selfMessagePath = path.join(inboxDir, "2026-04-11T21-10-00Z-agent-self.md");
  const peerMessagePath = path.join(inboxDir, "2026-04-11T21-10-05Z-agent-peer.md");

  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    selfMessagePath,
    `---
from: agent-self
from_name: eval runner
reply_to: agent-self
sent_at: ${baselineSentAt}
subject: Need 1 GPU for quick eval
---
Can anyone free 1 GPU for a quick eval?
`,
    "utf8",
  );
  await writeFile(
    peerMessagePath,
    `---
from: agent-peer
from_name: resource coordinator
reply_to: agent-peer
sent_at: 2026-04-11T21:10:05Z
subject: Re: Need 1 GPU for quick eval
---
Yes, 1 GPU is available.
`,
    "utf8",
  );

  const watcher = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "bin", "vr-mailwatch"),
      "--inbox",
      inboxDir,
      "--from",
      "agent-peer",
      "--after",
      baselineSentAt,
      "--print-path",
      "--no-bell",
      "--quiet",
      "--once",
      "--timeout",
      "5",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  watcher.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  watcher.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    const [exitCode] = await once(watcher, "exit");
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), peerMessagePath);
    assert.match(stderr, /Re: Need 1 GPU for quick eval/);
    assert.doesNotMatch(stderr, /eval runner/);
  } finally {
    watcher.kill("SIGTERM");
    await rm(workspaceDir, { recursive: true, force: true });
  }
});

test("vr-mailwatch treats a same-second peer reply as new when filtered by sender", async () => {
  const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "vibe-research-mailwatch-equal-"));
  const inboxDir = path.join(workspaceDir, ".vibe-research", "wiki", "comms", "groups", "resource-hall", "inbox");
  const baselineSentAt = "2026-04-11T21:12:00Z";
  const peerMessagePath = path.join(inboxDir, "2026-04-11T21-12-00Z-agent-peer.md");

  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    peerMessagePath,
    `---
from: agent-peer
from_name: resource coordinator
reply_to: agent-peer
sent_at: ${baselineSentAt}
subject: Same-second reply
---
Reply landed in the same second as the request timestamp.
`,
    "utf8",
  );

  const watcher = spawn(
    process.execPath,
    [
      path.join(process.cwd(), "bin", "vr-mailwatch"),
      "--inbox",
      inboxDir,
      "--from",
      "agent-peer",
      "--after",
      baselineSentAt,
      "--print-path",
      "--no-bell",
      "--quiet",
      "--once",
      "--timeout",
      "5",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  watcher.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  watcher.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    const [exitCode] = await once(watcher, "exit");
    assert.equal(exitCode, 0);
    assert.equal(stdout.trim(), peerMessagePath);
    assert.match(stderr, /Same-second reply/);
  } finally {
    watcher.kill("SIGTERM");
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
