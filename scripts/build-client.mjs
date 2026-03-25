import { mkdir, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");
const vendorDir = path.join(publicDir, "vendor");

await mkdir(vendorDir, { recursive: true });

await esbuild.build({
  bundle: true,
  entryPoints: [path.join(rootDir, "src", "client", "main.js")],
  format: "esm",
  outfile: path.join(publicDir, "app.js"),
  sourcemap: false,
  minify: false,
  target: "es2022",
});

await cp(
  path.join(rootDir, "node_modules", "xterm", "css", "xterm.css"),
  path.join(vendorDir, "xterm.css"),
);
