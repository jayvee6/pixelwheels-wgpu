// Loads the baked race.json: tile rendering (with Tiled flip orientations), material sampling, and
// collision-shape enumeration in world pixels. GIDs carry Tiled flip flags in the top 3 bits.
import type { Sprite } from "../engine/sprites.ts";

const FLIP_H = 0x80000000;
const FLIP_V = 0x40000000;
const FLIP_D = 0x20000000;
const GID_MASK = 0x1fffffff;

export interface TrackObject {
  id: number; name: string | null;
  x: number; y: number; width: number | null; height: number | null; rotation: number;
  kind: "polyline" | "polygon" | "ellipse" | "rect";
  points?: [number, number][];
}

export interface TileShape {
  type: "rect" | "polygon";
  x: number; y: number; width?: number; height?: number; points?: [number, number][];
}

export type ObstacleDef =
  | { type: "rectangle"; x: number; y: number; width: number; height: number; angle?: number }
  | { type: "circle"; x: number; y: number; radius: number }
  | { type: "multi"; obstacles: ObstacleDef[] }
  | { type: string; [k: string]: unknown };

export interface TileProps {
  material?: string;
  obstacle?: ObstacleDef;
  collision?: TileShape[];
  start?: boolean;
}

export interface TrackData {
  width: number; height: number; tileW: number; tileH: number;
  pixelWidth: number; pixelHeight: number;
  tileset: { image: string; firstgid: number; columns: number; rows: number; tileW: number; tileH: number };
  layers: { name: string; gids: number[] }[];
  tileProps: Record<string, TileProps>;
  objects: Record<string, TrackObject[]>;
}

export async function loadTrack(url: string): Promise<TrackData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch track ${url}: ${res.status}`);
  return (await res.json()) as TrackData;
}

interface DecodedGid { id: number; fh: boolean; fv: boolean; fd: boolean; }
function decodeGid(gid: number, firstgid: number): DecodedGid | null {
  if (!gid) return null;
  const fh = (gid & FLIP_H) !== 0, fv = (gid & FLIP_V) !== 0, fd = (gid & FLIP_D) !== 0;
  const id = (gid & GID_MASK) - firstgid;
  if (id < 0) return null;
  return { id, fh, fv, fd };
}

// Apply Tiled flip to a unit-square coord (cx,cy in {0,1} or [0,1]). Diagonal first, then H, then V.
function flipUnit(cx: number, cy: number, fh: boolean, fv: boolean, fd: boolean): [number, number] {
  let sx = cx, sy = cy;
  if (fd) { const t = sx; sx = sy; sy = t; }
  if (fh) sx = 1 - sx;
  if (fv) sy = 1 - sy;
  return [sx, sy];
}

/** UV basis (origin + U/V edge vectors) for a tile id with the given flip flags. */
function tileUVBasis(d: DecodedGid, columns: number, tileW: number, tileH: number, texW: number, texH: number): Pick<Sprite, "uo" | "uu" | "uv"> {
  const col = d.id % columns;
  const row = Math.floor(d.id / columns);
  const u0 = (col * tileW) / texW, v0 = (row * tileH) / texH;
  const du = tileW / texW, dv = tileH / texH;
  const texel = (sx: number, sy: number): [number, number] => [u0 + sx * du, v0 + sy * dv];
  const o = texel(...flipUnit(0, 0, d.fh, d.fv, d.fd));
  const a = texel(...flipUnit(1, 0, d.fh, d.fv, d.fd));
  const b = texel(...flipUnit(0, 1, d.fh, d.fv, d.fd));
  return { uo: o, uu: [a[0] - o[0], a[1] - o[1]], uv: [b[0] - o[0], b[1] - o[1]] };
}

/** Build sprite instances for all tile layers (bg under fg). Static — call once. */
export function buildTileSprites(track: TrackData, texW: number, texH: number): Sprite[] {
  const { width, height, tileW, tileH, tileset } = track;
  const sprites: Sprite[] = [];
  for (const layer of track.layers) {
    for (let ty = 0; ty < height; ty++) {
      for (let tx = 0; tx < width; tx++) {
        const d = decodeGid(layer.gids[ty * width + tx], tileset.firstgid);
        if (!d) continue;
        const basis = tileUVBasis(d, tileset.columns, tileW, tileH, texW, texH);
        sprites.push({
          x: tx * tileW + tileW / 2, y: ty * tileH + tileH / 2, w: tileW, h: tileH, ...basis,
        });
      }
    }
  }
  return sprites;
}

/** Material under a world-pixel position. Scans background (name starts "bg") layers, top first. */
export function getMaterialAt(track: TrackData, px: number, py: number): string {
  const tx = Math.floor(px / track.tileW);
  const ty = Math.floor(py / track.tileH);
  if (tx < 0 || ty < 0 || tx >= track.width || ty >= track.height) return "ROAD";
  const bg = track.layers.filter((l) => l.name.startsWith("bg"));
  for (let i = bg.length - 1; i >= 0; i--) {
    const d = decodeGid(bg[i].gids[ty * track.width + tx], track.tileset.firstgid);
    if (d) return track.tileProps[d.id]?.material ?? "ROAD";
  }
  return "ROAD";
}

// ---- collision shape enumeration (world pixels) ----
export type WorldShape =
  | { kind: "polygon"; points: [number, number][] }
  | { kind: "circle"; x: number; y: number; r: number };

/** Transform a tile-fraction point (fx,fy in [0,1]) to world px, honoring flips. */
function fracToWorld(fx: number, fy: number, ox: number, oy: number, tileW: number, tileH: number, d: DecodedGid): [number, number] {
  const [sx, sy] = flipUnit(fx, fy, d.fh, d.fv, d.fd);
  return [ox + sx * tileW, oy + sy * tileH];
}

/** Yield every static-collision shape from placed tiles (objectgroup px shapes + obstacle JSON). */
export function forEachTileCollision(track: TrackData, cb: (s: WorldShape) => void) {
  const { width, height, tileW, tileH, tileset } = track;
  for (const layer of track.layers) {
    for (let ty = 0; ty < height; ty++) {
      for (let tx = 0; tx < width; tx++) {
        const d = decodeGid(layer.gids[ty * width + tx], tileset.firstgid);
        if (!d) continue;
        const props = track.tileProps[d.id];
        if (!props) continue;
        const ox = tx * tileW, oy = ty * tileH;

        // Walls come ONLY from the `obstacle` property (circle/rectangle/multi) — matching the
        // upstream TiledObstacleCreator, which ignores the tileset's <objectgroup> shapes for physics.
        if (props.obstacle) emitObstacle(props.obstacle, ox, oy, tileW, tileH, d, cb);
      }
    }
  }
}

function emitObstacle(ob: ObstacleDef, ox: number, oy: number, tileW: number, tileH: number, d: DecodedGid, cb: (s: WorldShape) => void) {
  if (ob.type === "rectangle") {
    const o = ob as { x: number; y: number; width: number; height: number; angle?: number };
    let corners: [number, number][] = [[o.x, o.y], [o.x + o.width, o.y], [o.x + o.width, o.y + o.height], [o.x, o.y + o.height]];
    if (o.angle) { // rotate (clockwise, y-down) around the rect origin before placing
      const a = (o.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      corners = corners.map(([fx, fy]) => { const dx = fx - o.x, dy = fy - o.y; return [o.x + dx * c - dy * s, o.y + dx * s + dy * c]; });
    }
    cb({ kind: "polygon", points: corners.map(([fx, fy]) => fracToWorld(fx, fy, ox, oy, tileW, tileH, d)) });
  } else if (ob.type === "circle") {
    const o = ob as { x: number; y: number; radius: number };
    const [cx, cy] = fracToWorld(o.x, o.y, ox, oy, tileW, tileH, d);
    cb({ kind: "circle", x: cx, y: cy, r: o.radius * tileW });
  } else if (ob.type === "multi") {
    for (const sub of (ob as { obstacles: ObstacleDef[] }).obstacles) emitObstacle(sub, ox, oy, tileW, tileH, d, cb);
  }
}

/** All start-tile positions (center-x, top-y in px), scanning the ground layer (Track.findStartTilePositions). */
export function findStartPositions(track: TrackData): { x: number; y: number }[] {
  const startIds = new Set(
    Object.entries(track.tileProps).filter(([, p]) => p.start).map(([id]) => Number(id)),
  );
  const ground = track.layers[0]; // bg1 = ground layer
  const out: { x: number; y: number }[] = [];
  if (!ground || !startIds.size) return out;
  for (let ty = 0; ty < track.height; ty++) {
    for (let tx = 0; tx < track.width; tx++) {
      const d = decodeGid(ground.gids[ty * track.width + tx], track.tileset.firstgid);
      if (d && startIds.has(d.id)) out.push({ x: tx * track.tileW + track.tileW / 2, y: ty * track.tileH });
    }
  }
  return out;
}

/** Starting placement: center of the first start-flagged tile, else first waypoint. */
export function findStart(track: TrackData): { x: number; y: number } {
  const startIds = new Set(
    Object.entries(track.tileProps).filter(([, p]) => p.start).map(([id]) => Number(id)),
  );
  if (startIds.size) {
    for (const layer of track.layers) {
      for (let ty = 0; ty < track.height; ty++) {
        for (let tx = 0; tx < track.width; tx++) {
          const d = decodeGid(layer.gids[ty * track.width + tx], track.tileset.firstgid);
          if (d && startIds.has(d.id)) return { x: tx * track.tileW + track.tileW / 2, y: ty * track.tileH + track.tileH / 2 };
        }
      }
    }
  }
  const wp = track.objects.Waypoints?.[0];
  if (wp?.points?.length) return { x: wp.x + wp.points[0][0], y: wp.y + wp.points[0][1] };
  return { x: track.pixelWidth / 2, y: track.pixelHeight / 2 };
}
