// Decodes the upstream Aseprite sources we need into PNGs under public/assets/, plus a
// sprites-meta.json recording each region's pixel size (needed to size wheel/vehicle bodies).
//  - maps/snow.ase            -> public/assets/maps/snow.png      (unpadded 15x18 grid + colour remap)
//  - sprites/vehicles/<v>.ase -> public/assets/sprites/vehicles/<v>.png   (rotated -90, per Makefile)
//  - sprites/tires/<t>.ase    -> public/assets/sprites/tires/<t>.png      (for wheel sizing + render)
//
// Self-contained: tools/ase.mjs (decoder) + tools/png.mjs (encoder). No external deps.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeAse } from "./ase.mjs";
import { encodePng } from "./png.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.PW_SRC_ROOT ?? "/Users/jdot/Documents/Development/pixelwheels-src";
const ASSETS_SRC = resolve(SRC, "core/assets-src");
const OUT = resolve(__dirname, "../public/assets");
const WANT_VEHICLES = (process.env.PW_VEHICLES ?? "jeep,red,police").split(",");

const meta = {}; // region -> {w,h}

function remapMapColors(rgba) {
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (r === 0xff && g === 0x00 && b === 0xff) { rgba[i] = 0x22; rgba[i + 1] = 0x20; rgba[i + 2] = 0x34; rgba[i + 3] = 0x60; }
    else if (r === 0x00 && g === 0xff && b === 0xff) { rgba[i] = 0xff; rgba[i + 1] = 0xff; rgba[i + 2] = 0xff; rgba[i + 3] = 0x20; }
  }
  return rgba;
}

function rotateNeg90(rgba, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + x) * 4, dx = y, dy = w - 1 - x, di = (dy * h + dx) * 4;
    out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
  }
  return { rgba: out, width: h, height: w };
}

function writePng(relPath, rgba, w, h) {
  const dest = resolve(OUT, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, encodePng(rgba, w, h));
  console.log(`  ${relPath}  ${w}x${h}`);
}

// strip .still/.anim and .ase to get the region base name
const baseName = (f) => f.replace(/\.(still|anim|slices)?\.?ase$/i, "").replace(/\.ase$/i, "");

// ---- tilesets ----
console.log("tilesets:");
{
  const mapsAse = [
    { name: "snow", remap: true },
    { name: "country", remap: true },
  ];
  for (const { name, remap } of mapsAse) {
    const asePath = resolve(ASSETS_SRC, `maps/${name}.ase`);
    const { width, height, frames } = decodeAse(readFileSync(asePath));
    const rgba = frames[0].rgba.slice();
    writePng(`maps/${name}.png`, remap ? remapMapColors(rgba) : rgba, width, height);
  }
}

// ---- vehicles ----
console.log("vehicles:");
{
  const dir = resolve(ASSETS_SRC, "sprites/vehicles");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ase")) : [];
  for (const f of files) {
    const name = baseName(f);
    if (WANT_VEHICLES.length && !WANT_VEHICLES.includes(name)) continue;
    const { width, height, frames } = decodeAse(readFileSync(resolve(dir, f)));
    const rot = rotateNeg90(frames[0].rgba, width, height);
    writePng(`sprites/vehicles/${name}.png`, rot.rgba, rot.width, rot.height);
    meta[`vehicles/${name}`] = { w: rot.width, h: rot.height };
  }
}

// ---- tires (for wheel body sizing + optional render) ----
console.log("tires:");
{
  const dir = resolve(ASSETS_SRC, "sprites/tires");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".ase")) : [];
  for (const f of files) {
    const name = baseName(f);
    // tires/<SIZE> — only the plain size frame (skip splash anims if separate); take frame 0
    const { width, height, frames } = decodeAse(readFileSync(resolve(dir, f)));
    writePng(`sprites/tires/${name}.png`, frames[0].rgba.slice(), width, height);
    meta[`tires/${name}`] = { w: width, h: height };
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "sprites-meta.json"), JSON.stringify(meta, null, 2));
console.log(`sprites-meta.json: ${Object.keys(meta).length} regions`);
console.log("done.");
