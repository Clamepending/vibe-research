#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");
const assetsDir = path.join(desktopDir, "assets");
const iconsetDir = path.join(assetsDir, "icon.iconset");
const sizes = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024],
];

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const crc32Table = makeCrc32Table();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crc32Table[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, payload])), 0);
  return Buffer.concat([length, typeBuffer, payload, checksum]);
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function mix(a, b, amount) {
  return Math.round(a + (b - a) * amount);
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared);
  const x = ax + t * dx;
  const y = ay + t * dy;
  return Math.hypot(px - x, py - y);
}

function roundedBoxAlpha(x, y) {
  const radius = 0.19;
  const half = 0.88;
  const qx = Math.abs(x) - half + radius;
  const qy = Math.abs(y) - half + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const distance = outside + inside - radius;
  return clamp(0.5 - distance * 20);
}

function pixelAt(nx, ny) {
  const alpha = roundedBoxAlpha(nx, ny);
  if (alpha <= 0) {
    return [0, 0, 0, 0];
  }

  const gradient = clamp((nx + ny + 1.6) / 3.2);
  const base = [
    mix(19, 226, gradient),
    mix(107, 184, gradient),
    mix(106, 75, gradient),
  ];

  const leftStroke = distanceToSegment(nx, ny, -0.52, -0.45, -0.08, 0.46);
  const rightStroke = distanceToSegment(nx, ny, 0.52, -0.45, 0.08, 0.46);
  const beam = Math.min(leftStroke, rightStroke);
  const beamAlpha = clamp((0.13 - beam) * 11);
  const centerGlow = clamp((0.23 - Math.hypot(nx, ny - 0.44)) * 4);
  const markAlpha = clamp(Math.max(beamAlpha, centerGlow));

  const color = markAlpha > 0
    ? [
        mix(base[0], 244, markAlpha),
        mix(base[1], 241, markAlpha),
        mix(base[2], 232, markAlpha),
      ]
    : base;

  return [color[0], color[1], color[2], Math.round(alpha * 255)];
}

function createPng(size) {
  const rowLength = size * 4 + 1;
  const raw = Buffer.alloc(rowLength * size);
  const samples = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];

  for (let y = 0; y < size; y += 1) {
    raw[y * rowLength] = 0;
    for (let x = 0; x < size; x += 1) {
      const rgba = [0, 0, 0, 0];
      for (const [sx, sy] of samples) {
        const nx = ((x + sx) / size) * 2 - 1;
        const ny = ((y + sy) / size) * 2 - 1;
        const sample = pixelAt(nx, ny);
        for (let channel = 0; channel < 4; channel += 1) {
          rgba[channel] += sample[channel] / samples.length;
        }
      }
      const offset = y * rowLength + 1 + x * 4;
      raw[offset] = Math.round(rgba[0]);
      raw[offset + 1] = Math.round(rgba[1]);
      raw[offset + 2] = Math.round(rgba[2]);
      raw[offset + 3] = Math.round(rgba[3]);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });
mkdirSync(assetsDir, { recursive: true });

for (const [fileName, size] of sizes) {
  writeFileSync(path.join(iconsetDir, fileName), createPng(size));
}

const iconPng = createPng(1024);
writeFileSync(path.join(assetsDir, "icon.png"), iconPng);

if (process.platform === "darwin") {
  execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", path.join(assetsDir, "icon.icns")], {
    stdio: "inherit",
  });
}

console.log(`[vibe-research-desktop] wrote icons ${createHash("sha256").update(iconPng).digest("hex").slice(0, 12)}`);
