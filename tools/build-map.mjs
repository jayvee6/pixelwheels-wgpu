// Bakes an upstream Tiled map + tsx into a single runtime JSON.
// Output: public/assets/maps/<name>.json — tile grids (decoded GIDs), tileset geometry,
// per-tile properties (material / obstacle / collision objectgroup / start), and object layers
// (Obstacles, Sections lap gates, Waypoints AI path). Pure build-time; no runtime XML parsing.
//
// Usage:
//   MAP_NAME=race    node tools/build-map.mjs   (default — race.tmx + snow.tsx → race.json)
//   MAP_NAME=country node tools/build-map.mjs   (country.tmx + country.tsx → country.json)
//
// TSX_NAME can override the tileset filename independently if needed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.PW_SRC ?? "/Users/jdot/Documents/Development/pixelwheels-src/android/assets/maps";

// MAP_NAME drives both the .tmx and (default) the .tsx + output filename.
// TSX_NAME overrides the tileset file independently.
const MAP_NAME = process.env.MAP_NAME ?? "race";
const TSX_NAME = process.env.TSX_NAME ?? MAP_NAME === "race" ? "snow" : MAP_NAME;
const OUT = resolve(__dirname, `../public/assets/maps/${MAP_NAME}.json`);

const tmx = readFileSync(resolve(SRC, `${MAP_NAME}.tmx`), "utf8");
const tsx = readFileSync(resolve(SRC, `${TSX_NAME}.tsx`), "utf8");

const attr = (s, name) => {
  const m = s.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : null;
};
const num = (s, name) => { const v = attr(s, name); return v == null ? null : Number(v); };
const unescapeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// ---- <map> ----
const mapTag = tmx.match(/<map\b[^>]*>/)[0];
const width = num(mapTag, "width");
const height = num(mapTag, "height");
const tileW = num(mapTag, "tilewidth");
const tileH = num(mapTag, "tileheight");

// ---- tile layers (bg1/bg2/fg1/fg2): decode base64 + zlib into GID arrays ----
const layers = [];
const layerRe = /<layer\b([^>]*)>\s*<data\b([^>]*)>([\s\S]*?)<\/data>\s*<\/layer>/g;
for (let m; (m = layerRe.exec(tmx)); ) {
  const head = m[1];
  const dataHead = m[2];
  const name = attr(head, "name");
  const encoding = attr(dataHead, "encoding");
  const compression = attr(dataHead, "compression");
  let gids;
  if (encoding === "csv") {
    // CSV: comma-separated GID values (may include Tiled flip flags as large positive ints)
    gids = m[3].trim().split(",").map((v) => Number(v.trim()) >>> 0);
  } else if (encoding === "base64") {
    let bytes = Buffer.from(m[3].trim(), "base64");
    if (compression === "zlib") bytes = inflateSync(bytes);
    else if (compression) throw new Error(`layer ${name}: unsupported compression ${compression}`);
    // Keep the raw 32-bit GID incl. Tiled flip flags (top 3 bits); the runtime decodes id + flips.
    gids = new Array(width * height);
    for (let i = 0; i < width * height; i++) gids[i] = bytes.readUInt32LE(i * 4);
  } else {
    throw new Error(`layer ${name}: unexpected encoding ${encoding}`);
  }
  layers.push({ name, gids });
}

// ---- tileset geometry. We decode the .ase UNPADDED (no margin/spacing), so override the
// tsx's padded geometry: tiles laid out row-major at (col*tileW, row*tileH). ----
const firstgid = Number(attr(tmx.match(/<tileset\b[^>]*>/)[0], "firstgid"));
const columns = num(tsx.match(/<tileset\b[^>]*>/)[0], "columns");
const tileCount = num(tsx.match(/<tileset\b[^>]*>/)[0], "tilecount");
const rows = Math.ceil(tileCount / columns);

// The tileset image name from the tsx (e.g. "country.png" or "snow.png").
// We use TSX_NAME so the runtime fetches the right decoded PNG.
const tilesetImage = `${TSX_NAME}.png`;

// ---- per-tile properties from the tsx (<tile id=...> blocks) ----
const tileProps = {}; // localId -> { material?, obstacle?, collision?: [...], start?: true }
const tileRe = /<tile\b([^>]*)>([\s\S]*?)<\/tile>/g;
for (let m; (m = tileRe.exec(tsx)); ) {
  const id = Number(attr(m[1], "id"));
  const body = m[2];
  const props = {};
  // collect ALL <property> entries
  const propRe = /<property name="([^"]+)"(?:\s+value="([^"]*)")?\s*(?:\/>|>([\s\S]*?)<\/property>)/g;
  for (let p; (p = propRe.exec(body)); ) {
    const key = p[1];
    const val = p[2] != null ? p[2] : unescapeXml((p[3] ?? "").trim());
    if (key === "start") props.start = val === "true";
    else if (key === "material") props.material = val;
    else if (key === "obstacle") { try { props.obstacle = JSON.parse(val); } catch { props.obstacle = null; } }
  }
  // per-tile collision shapes from <objectgroup>
  const og = body.match(/<objectgroup\b[^>]*>([\s\S]*?)<\/objectgroup>/);
  if (og) {
    const shapes = [];
    const objRe = /<object\b([^>]*)(?:\/>|>([\s\S]*?)<\/object>)/g;
    for (let o; (o = objRe.exec(og[1])); ) {
      const oh = o[1];
      const inner = o[2] ?? "";
      const ox = num(oh, "x") ?? 0, oy = num(oh, "y") ?? 0;
      const poly = inner.match(/<polygon points="([^"]+)"/);
      if (poly) {
        const pts = poly[1].trim().split(/\s+/).map((pr) => pr.split(",").map(Number));
        shapes.push({ type: "polygon", x: ox, y: oy, points: pts });
      } else {
        const w = num(oh, "width"), h = num(oh, "height");
        if (w != null && h != null) shapes.push({ type: "rect", x: ox, y: oy, width: w, height: h });
      }
    }
    if (shapes.length) props.collision = shapes;
  }
  if (Object.keys(props).length) tileProps[id] = props;
}

// ---- object layers ----
const objectGroups = {};
const ogRe = /<objectgroup\b([^>]*)>([\s\S]*?)<\/objectgroup>/g;
for (let m; (m = ogRe.exec(tmx)); ) {
  const name = attr(m[1], "name");
  if (!name) continue;
  const objs = [];
  const objRe = /<object\b([^>]*)(?:\/>|>([\s\S]*?)<\/object>)/g;
  for (let o; (o = objRe.exec(m[2])); ) {
    const oh = o[1], inner = o[2] ?? "";
    const obj = {
      id: num(oh, "id"),
      name: attr(oh, "name"),
      x: num(oh, "x"), y: num(oh, "y"),
      width: num(oh, "width"), height: num(oh, "height"),
      rotation: num(oh, "rotation") ?? 0,
    };
    const poly = inner.match(/<(polyline|polygon) points="([^"]+)"/);
    if (poly) {
      obj.kind = poly[1];
      obj.points = poly[2].trim().split(/\s+/).map((pr) => { const [px, py] = pr.split(",").map(Number); return [px, py]; });
    } else if (/<ellipse/.test(inner)) {
      obj.kind = "ellipse";
    } else {
      obj.kind = "rect";
    }
    objs.push(obj);
  }
  objectGroups[name] = objs;
}

const out = {
  source: `pixelwheels/${MAP_NAME}.tmx`,
  width, height, tileW, tileH,
  pixelWidth: width * tileW, pixelHeight: height * tileH,
  tileset: { image: tilesetImage, firstgid, columns, rows, tileW, tileH },
  layers,            // [{name, gids[]}]
  tileProps,         // localId -> {material?, obstacle?, collision?, start?}
  objects: objectGroups, // {Obstacles, Sections, Waypoints, BonusSpots}
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const tileLayerNames = layers.map((l) => l.name).join(", ");
console.log(`${MAP_NAME}.json: ${width}x${height} tiles (${out.pixelWidth}x${out.pixelHeight}px), layers [${tileLayerNames}], ` +
  `${Object.keys(tileProps).length} tile-prop entries, sections=${objectGroups.Sections?.length}, ` +
  `waypoints=${objectGroups.Waypoints?.[0]?.points?.length}`);
