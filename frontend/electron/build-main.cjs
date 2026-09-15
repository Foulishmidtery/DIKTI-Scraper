const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const sourceRoot = __dirname;
const outputRoot = path.resolve(sourceRoot, "..", "electron-dist");
fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

for (const entry of ["main.cjs", "preload.cjs"]) {
  esbuild.buildSync({
    entryPoints: [path.join(sourceRoot, entry)],
    outfile: path.join(outputRoot, entry),
    bundle: true,
    minify: true,
    sourcemap: false,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    legalComments: "none",
  });
}

fs.cpSync(path.join(sourceRoot, "assets"), path.join(outputRoot, "assets"), { recursive: true });
fs.copyFileSync(path.join(sourceRoot, "splash.html"), path.join(outputRoot, "splash.html"));
const integrity = path.join(sourceRoot, "integrity-manifest.json");
if (fs.existsSync(integrity)) fs.copyFileSync(integrity, path.join(outputRoot, "integrity-manifest.json"));
