// Tests for ClaudeStreamSession.sendWithImages — the path that delivers
// real image bytes to Claude as base64 content blocks instead of just
// the file path as text. Without this, the agent sees the path string
// but can't open the actual image content.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { ClaudeStreamSession } from "../src/claude-stream-session.js";

// 1×1 transparent PNG (base64-decoded once into bytes).
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=",
  "base64",
);

function makeFakeStreamSession() {
  const session = new ClaudeStreamSession({ sessionId: "image-test" });
  const stdinFrames = [];
  session._child = {
    stdin: { write(line) { stdinFrames.push(JSON.parse(String(line).trim())); }, end() {} },
    stdout: { setEncoding() {}, on() {} },
    stderr: { setEncoding() {}, on() {} },
    on() {}, kill() {},
  };
  session.status = "running";
  session.stdinFrames = stdinFrames;
  return session;
}

test("sendWithImages: text + one image produces a user message with text + image content blocks", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-img-"));
  try {
    const imgPath = path.join(tmp, "tiny.png");
    await writeFile(imgPath, TINY_PNG);
    const stream = makeFakeStreamSession();

    await stream.sendWithImages("What's in this image?", [{ absolutePath: imgPath }]);

    assert.equal(stream.stdinFrames.length, 1);
    const frame = stream.stdinFrames[0];
    assert.equal(frame.type, "user");
    assert.equal(frame.message.role, "user");
    assert.equal(frame.message.content.length, 2);
    assert.deepEqual(frame.message.content[0], { type: "text", text: "What's in this image?" });
    assert.equal(frame.message.content[1].type, "image");
    assert.equal(frame.message.content[1].source.type, "base64");
    assert.equal(frame.message.content[1].source.media_type, "image/png");
    // The image bytes round-trip through base64.
    const decoded = Buffer.from(frame.message.content[1].source.data, "base64");
    assert.deepEqual(decoded, TINY_PNG);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("sendWithImages: multiple images all get their own content block", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-img-multi-"));
  try {
    const a = path.join(tmp, "a.png");
    const b = path.join(tmp, "b.jpg");
    await writeFile(a, TINY_PNG);
    await writeFile(b, TINY_PNG);
    const stream = makeFakeStreamSession();

    await stream.sendWithImages("Compare", [
      { absolutePath: a },
      { absolutePath: b },
    ]);

    const content = stream.stdinFrames[0].message.content;
    assert.equal(content.length, 3, "1 text + 2 images");
    assert.equal(content[1].source.media_type, "image/png", "infers png from extension");
    assert.equal(content[2].source.media_type, "image/jpeg", "infers jpeg from .jpg");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("sendWithImages: an unreadable attachment is dropped, message still goes through with the survivors", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-img-partial-"));
  try {
    const ok = path.join(tmp, "ok.png");
    await writeFile(ok, TINY_PNG);
    const stream = makeFakeStreamSession();

    await stream.sendWithImages("Look", [
      { absolutePath: "/no/such/file.png" },
      { absolutePath: ok },
    ]);

    assert.equal(stream.stdinFrames.length, 1);
    const content = stream.stdinFrames[0].message.content;
    assert.equal(content.length, 2, "text + 1 surviving image");
    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "image");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("sendWithImages: text-only (empty attachments array) falls through to a plain text content block", async () => {
  const stream = makeFakeStreamSession();
  await stream.sendWithImages("Hello", []);
  const content = stream.stdinFrames[0].message.content;
  assert.equal(content.length, 1);
  assert.deepEqual(content[0], { type: "text", text: "Hello" });
});

test("sendWithImages: empty text + only attachments still emits a user message with the images", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-img-only-"));
  try {
    const img = path.join(tmp, "x.png");
    await writeFile(img, TINY_PNG);
    const stream = makeFakeStreamSession();

    await stream.sendWithImages("", [{ absolutePath: img }]);

    const content = stream.stdinFrames[0].message.content;
    assert.equal(content.length, 1, "no text block, just one image");
    assert.equal(content[0].type, "image");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("sendWithImages: returns false when text is empty and ALL attachments fail", async () => {
  const stream = makeFakeStreamSession();
  const result = await stream.sendWithImages("", [
    { absolutePath: "/nope/a.png" },
    { absolutePath: "/nope/b.png" },
  ]);
  assert.equal(result, false);
  assert.equal(stream.stdinFrames.length, 0);
});

test("sendWithImages: declared mimeType wins over extension inference", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "vr-img-mime-"));
  try {
    // File is a PNG by content, but the attachment is declared as webp —
    // honour the declaration since the upload endpoint may have stamped it.
    const filePath = path.join(tmp, "untyped.bin");
    await writeFile(filePath, TINY_PNG);
    const stream = makeFakeStreamSession();

    await stream.sendWithImages("look", [
      { absolutePath: filePath, mimeType: "image/webp" },
    ]);

    const content = stream.stdinFrames[0].message.content;
    assert.equal(content[1].source.media_type, "image/webp");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
