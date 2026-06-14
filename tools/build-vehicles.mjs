// Bakes the upstream vehicle XML defs into public/assets/vehicles.json (RAW attribute values).
// The TS port (src/game/vehicle.ts) replicates VehicleIO's width/height swap + VehicleCreator math,
// so we keep the raw numbers here and apply the same transforms at runtime.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.PW_VEH_SRC ?? "/Users/jdot/Documents/Development/pixelwheels-src/android/assets/vehicles";
const OUT = resolve(__dirname, "../public/assets/vehicles.json");
const ONLY = (process.env.PW_VEHICLES ?? "jeep,red,police,pickup,miramar,old-f1,roadster,harvester,santa,rocket,2cv,dark-m,antonin,c15,bigfoot").split(",");

const attr = (s, name, def = null) => {
  const m = s.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : def;
};
const fnum = (s, name, def = null) => { const v = attr(s, name); return v == null ? def : Number(v); };

function parseVehicle(xml, id) {
  const root = xml.match(/<vehicle\b[^>]*>/)[0];
  const main = xml.match(/<main\b[^>]*>/)?.[0] ?? "";
  const shapes = [];
  const shapesBlock = xml.match(/<shapes>([\s\S]*?)<\/shapes>/)?.[1] ?? "";
  for (let m, re = /<(octogon|trapezoid)\b([^>]*)\/>/g; (m = re.exec(shapesBlock)); ) {
    const t = m[1], a = m[2];
    if (t === "octogon") {
      shapes.push({ type: "octogon", width: fnum(a, "width"), height: fnum(a, "height"),
        corner: fnum(a, "corner", 0), x: fnum(a, "x"), y: fnum(a, "y") });
    } else {
      shapes.push({ type: "trapezoid", bottomWidth: fnum(a, "bottomWidth"), topWidth: fnum(a, "topWidth"),
        height: fnum(a, "height"), x: fnum(a, "x"), y: fnum(a, "y") });
    }
  }
  const axles = [];
  for (let m, re = /<axle\b([^>]*)\/>/g; (m = re.exec(xml)); ) {
    const a = m[1];
    axles.push({
      width: fnum(a, "width"), y: fnum(a, "y"),
      steer: fnum(a, "steer", 0), drive: fnum(a, "drive", 1),
      drift: attr(a, "drift", "true") === "true",
      tireSize: attr(a, "tireSize", "NORMAL"),
    });
  }
  return {
    id, name: attr(root, "name"), speed: fnum(root, "speed", 1),
    width: fnum(root, "width"), height: fnum(root, "height"),
    image: attr(main, "image"), shapes, axles,
  };
}

const out = {};
const ids = ONLY.length ? ONLY : readdirSync(SRC).filter((f) => f.endsWith(".xml")).map((f) => f.replace(".xml", ""));
for (const id of ids) {
  try {
    out[id] = parseVehicle(readFileSync(resolve(SRC, `${id}.xml`), "utf8"), id);
  } catch (e) { console.warn(`  (skip ${id}: ${e.message})`); }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`vehicles.json: ${Object.keys(out).join(", ")}`);
