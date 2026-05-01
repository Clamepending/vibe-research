// End-to-end integration tests for the file-upload HTTP endpoints
// (/api/files/upload and /api/files/folder).
//
// Boots a real createVibeResearchApp on an ephemeral port, then talks
// to it over HTTP exactly the way the browser will once the user drags
// a file from Finder onto the file tree.
//
// Coverage:
//   - happy path: drag a file into the workspace root
//   - drag a file into an existing nested directory
//   - drag a folder (mkdir + multi-file upload through the folder API)
//   - non-image binary file (.mp4 video bytes)
//   - collision suffix walk via the HTTP layer
//   - escape attempts blocked at the route layer
//   - oversize uploads blocked with HTTP 413
//   - empty upload blocked
//   - listing reflects the new files

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { createVibeResearchApp } from "../src/create-app.js";
import { SleepPreventionService } from "../src/sleep-prevention.js";

async function startApp(cwd) {
  const stateDir = path.join(cwd, ".vibe-research");
  const app = await createVibeResearchApp({
    host: "127.0.0.1",
    port: 0,
    cwd,
    stateDir,
    persistSessions: false,
    persistentTerminals: false,
    sleepPreventionFactory: (settings) =>
      new SleepPreventionService({ enabled: settings.preventSleepEnabled, platform: "test" }),
  });
  return { app, baseUrl: `http://127.0.0.1:${app.config.port}` };
}

async function withWorkspace(fn) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "vr-upload-int-"));
  const prevEnv = process.env.VIBE_RESEARCH_WORKSPACE_DIR;
  process.env.VIBE_RESEARCH_WORKSPACE_DIR = cwd;
  let app;
  try {
    const started = await startApp(cwd);
    app = started.app;
    await fn({ baseUrl: started.baseUrl, cwd });
  } finally {
    if (app) await app.close();
    if (prevEnv === undefined) delete process.env.VIBE_RESEARCH_WORKSPACE_DIR;
    else process.env.VIBE_RESEARCH_WORKSPACE_DIR = prevEnv;
    await rm(cwd, { recursive: true, force: true });
  }
}

function uploadUrl(baseUrl, params) {
  const url = new URL(`${baseUrl}/api/files/upload`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function postUpload(baseUrl, { root, relativePath, fileName, body, mimeType }) {
  return fetch(
    uploadUrl(baseUrl, {
      root,
      path: relativePath,
      name: encodeURIComponent(fileName),
      type: mimeType || "",
    }),
    {
      method: "POST",
      headers: {
        "Content-Type": mimeType || "application/octet-stream",
        "Content-Length": String(body.length),
      },
      body,
    },
  );
}

async function postFolder(baseUrl, { root, parentPath, name }) {
  return fetch(`${baseUrl}/api/files/folder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, path: parentPath || "", name }),
  });
}

async function listFiles(baseUrl, root, relativePath = "") {
  const url = new URL(`${baseUrl}/api/files`);
  url.searchParams.set("root", root);
  if (relativePath) url.searchParams.set("path", relativePath);
  const res = await fetch(url.toString());
  return { status: res.status, body: await res.json() };
}

test("POST /api/files/upload writes a file at the workspace root", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const body = Buffer.from("hello drag-and-drop", "utf8");
    const res = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "",
      fileName: "note.txt",
      body,
      mimeType: "text/plain",
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.file.name, "note.txt");
    assert.equal(json.file.relativePath, "note.txt");
    assert.equal(json.file.byteLength, body.length);

    const onDisk = await readFile(path.join(cwd, "note.txt"));
    assert.equal(onDisk.toString("utf8"), "hello drag-and-drop");

    // The list endpoint should now show the file.
    const list = await listFiles(baseUrl, cwd);
    const names = list.body.entries.map((e) => e.name);
    assert.ok(names.includes("note.txt"));
  });
});

test("POST /api/files/upload places a file inside an existing nested directory", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    await mkdir(path.join(cwd, "media", "drops"), { recursive: true });
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // JPEG-ish header
    const res = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "media/drops",
      fileName: "photo.jpg",
      body,
      mimeType: "image/jpeg",
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.file.relativePath, "media/drops/photo.jpg");
    assert.equal(json.file.isImage, true);
    const onDisk = await readFile(path.join(cwd, "media", "drops", "photo.jpg"));
    assert.equal(onDisk.length, body.length);
  });
});

test("POST /api/files/folder + uploads simulate a folder drop", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    // Drag a folder "vacation/" with two nested files.
    const folderRes = await postFolder(baseUrl, {
      root: cwd,
      parentPath: "",
      name: "vacation",
    });
    assert.equal(folderRes.status, 201);
    const folderJson = await folderRes.json();
    assert.equal(folderJson.folder.relativePath, "vacation");

    const sub = await postFolder(baseUrl, {
      root: cwd,
      parentPath: "vacation",
      name: "day-1",
    });
    assert.equal(sub.status, 201);
    const subJson = await sub.json();
    assert.equal(subJson.folder.relativePath, "vacation/day-1");

    const fileA = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "vacation/day-1",
      fileName: "beach.jpg",
      body: Buffer.from("jpegA"),
      mimeType: "image/jpeg",
    });
    assert.equal(fileA.status, 201);

    const fileB = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "vacation/day-1",
      fileName: "clip.mp4",
      body: Buffer.alloc(64 * 1024, 0xab),
      mimeType: "video/mp4",
    });
    assert.equal(fileB.status, 201);

    // Files exist on disk
    const a = await readFile(path.join(cwd, "vacation", "day-1", "beach.jpg"), "utf8");
    assert.equal(a, "jpegA");
    const b = await readFile(path.join(cwd, "vacation", "day-1", "clip.mp4"));
    assert.equal(b.length, 64 * 1024);
    assert.equal(b[0], 0xab);

    // Listing reflects the structure
    const root = await listFiles(baseUrl, cwd);
    assert.ok(root.body.entries.some((e) => e.name === "vacation" && e.type === "directory"));
    const day = await listFiles(baseUrl, cwd, "vacation/day-1");
    const names = day.body.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["beach.jpg", "clip.mp4"]);
  });
});

test("POST /api/files/upload handles a non-trivial binary (1 MB) round-trip", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const size = 1 * 1024 * 1024;
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i += 1) body[i] = (i * 17 + 5) & 0xff;
    const res = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "",
      fileName: "sample.mp4",
      body,
      mimeType: "video/mp4",
    });
    assert.equal(res.status, 201);
    const onDisk = await readFile(path.join(cwd, "sample.mp4"));
    assert.equal(Buffer.compare(onDisk, body), 0);
  });
});

test("POST /api/files/upload appends (1) suffix on collision", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const first = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "",
      fileName: "twin.png",
      body: Buffer.from("a"),
      mimeType: "image/png",
    });
    assert.equal(first.status, 201);

    const second = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "",
      fileName: "twin.png",
      body: Buffer.from("bb"),
      mimeType: "image/png",
    });
    assert.equal(second.status, 201);
    const json = await second.json();
    assert.equal(json.file.name, "twin (1).png");
    assert.equal(json.file.renamed, true);
    assert.equal(json.file.requestedName, "twin.png");

    const a = await readFile(path.join(cwd, "twin.png"));
    const b = await readFile(path.join(cwd, "twin (1).png"));
    assert.equal(a.toString(), "a");
    assert.equal(b.toString(), "bb");
  });
});

test("POST /api/files/upload rejects an empty body with 400", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const res = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "",
      fileName: "empty.bin",
      body: Buffer.alloc(0),
      mimeType: "application/octet-stream",
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /empty/i);
  });
});

test("POST /api/files/upload rejects oversize uploads with 413", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    // Patch the env-var so the server enforces a tiny cap for this test.
    const previous = process.env.VIBE_RESEARCH_UPLOAD_MAX_BYTES;
    process.env.VIBE_RESEARCH_UPLOAD_MAX_BYTES = "1024";
    try {
      const oversize = Buffer.alloc(4096, 0x41);
      const res = await postUpload(baseUrl, {
        root: cwd,
        relativePath: "",
        fileName: "big.bin",
        body: oversize,
        mimeType: "application/octet-stream",
      });
      assert.equal(res.status, 413);
      const json = await res.json();
      assert.match(json.error, /maximum size/i);
      // The temp file must not appear on disk.
      const fs = await import("node:fs");
      const entries = await fs.promises.readdir(cwd);
      for (const name of entries) {
        assert.ok(
          !name.startsWith(".vr-upload-") && name !== "big.bin",
          `unexpected leftover: ${name}`,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.VIBE_RESEARCH_UPLOAD_MAX_BYTES;
      else process.env.VIBE_RESEARCH_UPLOAD_MAX_BYTES = previous;
    }
  });
});

test("POST /api/files/upload sanitises a file name with path components", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const res = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "",
      fileName: "../../../escape.txt",
      body: Buffer.from("nope"),
      mimeType: "text/plain",
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.file.relativePath, "escape.txt");
    // The parent of cwd must NOT contain a stray escape.txt.
    const stale = path.join(path.dirname(cwd), "escape.txt");
    const fs = await import("node:fs");
    await assert.rejects(() => fs.promises.stat(stale), (e) => e.code === "ENOENT");
  });
});

test("POST /api/files/upload rejects a destination outside the workspace", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const res = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "../../../",
      fileName: "x.txt",
      body: Buffer.from("y"),
      mimeType: "text/plain",
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /escapes/i);
  });
});

test("POST /api/files/upload rejects an upload to a non-existent dir with 404", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const res = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "no/such/place",
      fileName: "x.txt",
      body: Buffer.from("y"),
      mimeType: "text/plain",
    });
    assert.equal(res.status, 404);
  });
});

test("POST /api/files/upload accepts unicode + emoji file names", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const fileName = "résumé café";
    const res = await postUpload(baseUrl, {
      root: cwd,
      relativePath: "",
      fileName,
      body: Buffer.from("unicode ok"),
      mimeType: "text/plain",
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.file.name, fileName);
    const onDisk = await readFile(path.join(cwd, fileName), "utf8");
    assert.equal(onDisk, "unicode ok");
  });
});

test("POST /api/files/folder rejects internal segment names", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    const res = await postFolder(baseUrl, {
      root: cwd,
      parentPath: "",
      name: ".vibe-research",
    });
    assert.equal(res.status, 400);
  });
});

test("POST /api/files/folder rejects bodies larger than the small JSON cap", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    // Send a wildly oversized body to confirm the inline body-size
    // guard fires before we hit any deeper logic.
    const huge = JSON.stringify({
      root: cwd,
      path: "",
      name: "x".repeat(80 * 1024),
    });
    const res = await fetch(`${baseUrl}/api/files/folder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: huge,
    });
    assert.equal(res.status, 413);
  });
});

test("POST /api/files/upload streams a chunked Readable body without buffering", async () => {
  await withWorkspace(async ({ baseUrl, cwd }) => {
    // Build a chunked body; node fetch will treat a Readable with a
    // duplex body just like a real network upload from a browser.
    const chunkSize = 8 * 1024;
    const chunkCount = 16; // 128 KB total
    const chunks = [];
    for (let i = 0; i < chunkCount; i += 1) {
      const buf = Buffer.alloc(chunkSize);
      buf.fill((i * 13 + 7) & 0xff);
      chunks.push(buf);
    }
    const stream = Readable.from(chunks);
    const total = chunkSize * chunkCount;
    const url = uploadUrl(baseUrl, {
      root: cwd,
      path: "",
      name: encodeURIComponent("streamed.bin"),
      type: "application/octet-stream",
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(total),
      },
      body: stream,
      duplex: "half",
    });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.file.byteLength, total);
    const onDisk = await readFile(path.join(cwd, "streamed.bin"));
    assert.equal(onDisk.length, total);
    // First chunk's fill byte
    assert.equal(onDisk[0], chunks[0][0]);
    // Last chunk's fill byte
    assert.equal(onDisk[total - 1], chunks[chunkCount - 1][chunkSize - 1]);
  });
});
