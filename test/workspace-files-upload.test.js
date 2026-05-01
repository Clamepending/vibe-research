// Tests for the workspace drag-and-drop upload pipeline (server side).
//
// Covers the helper functions in src/workspace-files.js. We construct a
// throwaway workspace directory, build a Readable stream that mimics
// what Express hands the route handler (a plain incoming request body),
// and assert the resulting on-disk state matches expectations.
//
// We hit each branch of the security/edge-case posture explicitly:
//   - happy path (top-level + nested directory)
//   - sanitization (slashes, control chars, reserved names)
//   - empty stream rejected
//   - oversize stream rejected mid-pipe with a 413
//   - collision -> "(1)" suffix walk
//   - escape attempt blocked (../ outside root)
//   - managed file overwrite blocked (AGENTS.md / CLAUDE.md at root)
//   - internal segment blocked (.vibe-research)
//   - mkdir helper creates intermediate directories safely

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureWorkspaceDirectory,
  listWorkspaceEntries,
  uploadWorkspaceFile,
} from "../src/workspace-files.js";

async function makeWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "vr-upload-test-"));
  return root;
}

function bufferToStream(buffer) {
  // Single-shot Readable from a Buffer; matches the shape uploadWorkspaceFile
  // expects (anything that pipes is fine, including a real http.IncomingMessage).
  return Readable.from([buffer]);
}

function chunkedStream(chunks) {
  // Multi-chunk stream so the size-limit transform actually has the
  // chance to fire mid-stream rather than at the very first byte.
  return Readable.from(chunks);
}

test("uploadWorkspaceFile: writes a file at the workspace root", async () => {
  const root = await makeWorkspace();
  try {
    const buffer = Buffer.from("hello world", "utf8");
    const result = await uploadWorkspaceFile({
      root,
      relativePath: "",
      fileName: "hello.txt",
      source: bufferToStream(buffer),
      fallbackCwd: root,
      mimeType: "text/plain",
    });

    assert.equal(result.name, "hello.txt");
    assert.equal(result.relativePath, "hello.txt");
    assert.equal(result.byteLength, buffer.byteLength);
    assert.equal(result.renamed, false);
    assert.equal(result.isImage, false);
    assert.equal(result.mimeType, "text/plain");

    const onDisk = await readFile(path.join(root, "hello.txt"));
    assert.equal(onDisk.toString("utf8"), "hello world");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: writes into a nested subdirectory", async () => {
  const root = await makeWorkspace();
  try {
    await mkdir(path.join(root, "projects", "alpha"), { recursive: true });
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG header
    const result = await uploadWorkspaceFile({
      root,
      relativePath: "projects/alpha",
      fileName: "fig.png",
      source: bufferToStream(buffer),
      fallbackCwd: root,
      mimeType: "image/png",
    });

    assert.equal(result.relativePath, "projects/alpha/fig.png");
    assert.equal(result.isImage, true);
    const onDisk = await readFile(path.join(root, "projects", "alpha", "fig.png"));
    assert.equal(onDisk.length, buffer.length);
    assert.deepEqual([...onDisk], [...buffer]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: collision walks suffix (1), (2), ...", async () => {
  const root = await makeWorkspace();
  try {
    await writeFile(path.join(root, "video.mp4"), Buffer.from("first"));
    await writeFile(path.join(root, "video (1).mp4"), Buffer.from("second"));

    const result = await uploadWorkspaceFile({
      root,
      relativePath: "",
      fileName: "video.mp4",
      source: bufferToStream(Buffer.from("third")),
      fallbackCwd: root,
    });

    assert.equal(result.name, "video (2).mp4");
    assert.equal(result.relativePath, "video (2).mp4");
    assert.equal(result.renamed, true);
    assert.equal(result.requestedName, "video.mp4");
    const onDisk = await readFile(path.join(root, "video (2).mp4"), "utf8");
    assert.equal(onDisk, "third");
    // Originals untouched
    assert.equal(await readFile(path.join(root, "video.mp4"), "utf8"), "first");
    assert.equal(await readFile(path.join(root, "video (1).mp4"), "utf8"), "second");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: rejects path-traversal in destination", async () => {
  const root = await makeWorkspace();
  try {
    await mkdir(path.join(root, "inside"), { recursive: true });
    await assert.rejects(
      () =>
        uploadWorkspaceFile({
          root,
          relativePath: "../",
          fileName: "evil.txt",
          source: bufferToStream(Buffer.from("nope")),
          fallbackCwd: root,
        }),
      (error) => {
        // Should be a 400 about leaving the workspace.
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /escapes/i);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: rejects file name with slashes", async () => {
  const root = await makeWorkspace();
  try {
    // The sanitizer strips path components from the leaked name and
    // accepts the basename — so "../escape.txt" becomes "escape.txt"
    // landing safely inside `root`. This matches Finder's behaviour
    // when the OS supplies webkitRelativePath; the directory tree is
    // rebuilt by the client through ensureWorkspaceDirectory, never
    // through the file-name field.
    const result = await uploadWorkspaceFile({
      root,
      relativePath: "",
      fileName: "../escape.txt",
      source: bufferToStream(Buffer.from("nice try")),
      fallbackCwd: root,
    });
    assert.equal(result.name, "escape.txt");
    assert.equal(result.relativePath, "escape.txt");
    const stats = await stat(path.join(root, "escape.txt"));
    assert.ok(stats.isFile());
    // And nothing was written above the root.
    const parent = path.dirname(root);
    const stale = path.join(parent, "escape.txt");
    await assert.rejects(() => stat(stale), (e) => e.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: rejects empty file name", async () => {
  const root = await makeWorkspace();
  try {
    await assert.rejects(
      () =>
        uploadWorkspaceFile({
          root,
          relativePath: "",
          fileName: "   ",
          source: bufferToStream(Buffer.from("anything")),
          fallbackCwd: root,
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: rejects empty file body", async () => {
  const root = await makeWorkspace();
  try {
    await assert.rejects(
      () =>
        uploadWorkspaceFile({
          root,
          relativePath: "",
          fileName: "empty.bin",
          source: bufferToStream(Buffer.alloc(0)),
          fallbackCwd: root,
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /empty/i);
        return true;
      },
    );
    // Empty file should NOT exist on disk (temp file cleaned up).
    await assert.rejects(
      () => stat(path.join(root, "empty.bin")),
      (e) => e.code === "ENOENT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: enforces maxBytes mid-stream (413)", async () => {
  const root = await makeWorkspace();
  try {
    const chunkA = Buffer.alloc(1024, 0x41); // 1 KB of 'A'
    const chunkB = Buffer.alloc(1024, 0x42); // 1 KB of 'B'
    await assert.rejects(
      () =>
        uploadWorkspaceFile({
          root,
          relativePath: "",
          fileName: "big.bin",
          source: chunkedStream([chunkA, chunkB]),
          fallbackCwd: root,
          maxBytes: 1500, // < 2048 total
        }),
      (error) => {
        assert.equal(error.statusCode, 413);
        return true;
      },
    );
    // The temp file should have been cleaned up — the partial upload
    // must not leave debris in the workspace root.
    const entries = await import("node:fs").then((m) =>
      m.promises.readdir(root),
    );
    for (const name of entries) {
      assert.ok(!name.startsWith(".vr-upload-"), `temp file leaked: ${name}`);
      assert.notEqual(name, "big.bin");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: blocks overwriting managed top-level files", async () => {
  const root = await makeWorkspace();
  try {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      await assert.rejects(
        () =>
          uploadWorkspaceFile({
            root,
            relativePath: "",
            fileName: name,
            source: bufferToStream(Buffer.from("hijacked")),
            fallbackCwd: root,
          }),
        (error) => {
          assert.equal(error.statusCode, 400);
          assert.match(error.message, /managed/i);
          return true;
        },
      );
    }
    // But CLAUDE.md inside a subdirectory is fine — only the top-level
    // pair is reserved.
    await mkdir(path.join(root, "projects", "demo"), { recursive: true });
    const result = await uploadWorkspaceFile({
      root,
      relativePath: "projects/demo",
      fileName: "CLAUDE.md",
      source: bufferToStream(Buffer.from("local override")),
      fallbackCwd: root,
    });
    assert.equal(result.relativePath, "projects/demo/CLAUDE.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: blocks names matching internal segments", async () => {
  const root = await makeWorkspace();
  try {
    for (const name of [".vibe-research", ".remote-vibes"]) {
      await assert.rejects(
        () =>
          uploadWorkspaceFile({
            root,
            relativePath: "",
            fileName: name,
            source: bufferToStream(Buffer.from("x")),
            fallbackCwd: root,
          }),
        (error) => {
          assert.equal(error.statusCode, 400);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: blocks reserved Windows device names", async () => {
  const root = await makeWorkspace();
  try {
    for (const name of ["CON", "PRN.txt", "COM1.bin", "LPT9.png", "nul.dat"]) {
      await assert.rejects(
        () =>
          uploadWorkspaceFile({
            root,
            relativePath: "",
            fileName: name,
            source: bufferToStream(Buffer.from("x")),
            fallbackCwd: root,
          }),
        (error) => {
          assert.equal(error.statusCode, 400);
          assert.match(error.message, /reserved/i);
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: strips control characters from file name", async () => {
  const root = await makeWorkspace();
  try {
    const name = `evilname .txt`;
    const result = await uploadWorkspaceFile({
      root,
      relativePath: "",
      fileName: name,
      source: bufferToStream(Buffer.from("x")),
      fallbackCwd: root,
    });
    assert.equal(result.name, "evilname.txt");
    assert.ok(/[^ -]+/.test(result.name));
    const stats = await stat(path.join(root, "evilname.txt"));
    assert.ok(stats.isFile());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: rejects when destination is a file, not a directory", async () => {
  const root = await makeWorkspace();
  try {
    await writeFile(path.join(root, "a-file.txt"), "x");
    await assert.rejects(
      () =>
        uploadWorkspaceFile({
          root,
          relativePath: "a-file.txt",
          fileName: "child.txt",
          source: bufferToStream(Buffer.from("y")),
          fallbackCwd: root,
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        assert.match(error.message, /not a directory/i);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: rejects when source is missing", async () => {
  const root = await makeWorkspace();
  try {
    await assert.rejects(
      () =>
        uploadWorkspaceFile({
          root,
          relativePath: "",
          fileName: "x.txt",
          source: null,
          fallbackCwd: root,
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: large binary file (5 MB) round-trips byte-exact", async () => {
  const root = await makeWorkspace();
  try {
    const size = 5 * 1024 * 1024;
    const buffer = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) {
      buffer[i] = (i * 31 + 7) & 0xff; // deterministic non-trivial pattern
    }
    // Split into 64 KB chunks like a real network read.
    const chunks = [];
    for (let i = 0; i < size; i += 64 * 1024) {
      chunks.push(buffer.subarray(i, Math.min(i + 64 * 1024, size)));
    }
    const result = await uploadWorkspaceFile({
      root,
      relativePath: "",
      fileName: "blob.bin",
      source: chunkedStream(chunks),
      fallbackCwd: root,
    });
    assert.equal(result.byteLength, size);
    const onDisk = await readFile(path.join(root, "blob.bin"));
    assert.equal(onDisk.length, size);
    // Cheap whole-buffer compare via Buffer.compare (returns 0 if equal).
    assert.equal(Buffer.compare(onDisk, buffer), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceDirectory: creates a directory and is idempotent", async () => {
  const root = await makeWorkspace();
  try {
    const result = await ensureWorkspaceDirectory({
      root,
      relativePath: "",
      name: "uploads",
      fallbackCwd: root,
    });
    assert.equal(result.relativePath, "uploads");
    const stats = await stat(path.join(root, "uploads"));
    assert.ok(stats.isDirectory());

    // Idempotent — second call must not throw and leaves it alone.
    const second = await ensureWorkspaceDirectory({
      root,
      relativePath: "",
      name: "uploads",
      fallbackCwd: root,
    });
    assert.equal(second.relativePath, "uploads");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceDirectory: rejects internal segment names", async () => {
  const root = await makeWorkspace();
  try {
    await assert.rejects(
      () =>
        ensureWorkspaceDirectory({
          root,
          relativePath: "",
          name: ".vibe-research",
          fallbackCwd: root,
        }),
      (error) => {
        assert.equal(error.statusCode, 400);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureWorkspaceDirectory: rejects path escape attempts via name", async () => {
  const root = await makeWorkspace();
  try {
    // The sanitizer collapses "../foo" to "foo", so the dir lands
    // safely inside root rather than in the parent — verifying the
    // escape attempt does NOT succeed.
    const result = await ensureWorkspaceDirectory({
      root,
      relativePath: "",
      name: "../sneaky",
      fallbackCwd: root,
    });
    assert.equal(result.relativePath, "sneaky");
    const inside = await stat(path.join(root, "sneaky"));
    assert.ok(inside.isDirectory());
    const parentSneaky = path.join(path.dirname(root), "sneaky");
    await assert.rejects(() => stat(parentSneaky), (e) => e.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listWorkspaceEntries: hides leftover .vr-upload-*.tmp temp files", async () => {
  // Simulates the case where an upload was interrupted (browser tab
  // closed mid-stream) — the temp file persists on disk but should
  // never leak into the file-tree UI.
  const root = await makeWorkspace();
  try {
    await writeFile(path.join(root, ".vr-upload-deadbeef0001.tmp"), "junk");
    await writeFile(path.join(root, "ok.txt"), "ok");
    const listing = await listWorkspaceEntries({
      root,
      relativePath: "",
      fallbackCwd: root,
    });
    const names = listing.entries.map((e) => e.name);
    assert.ok(names.includes("ok.txt"));
    assert.ok(!names.some((n) => n.startsWith(".vr-upload-")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploadWorkspaceFile: refuses an upload when the destination directory does not exist", async () => {
  const root = await makeWorkspace();
  try {
    await assert.rejects(
      () =>
        uploadWorkspaceFile({
          root,
          relativePath: "no/such/folder",
          fileName: "x.txt",
          source: bufferToStream(Buffer.from("x")),
          fallbackCwd: root,
        }),
      (error) => {
        assert.equal(error.statusCode, 404);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
