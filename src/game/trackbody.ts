// Static collision built the way the original does it: precise per-tile walls from the `obstacle`
// property (circle/rectangle/multi) — the authored snow-bank pieces, with rounded corners — plus a
// perimeter backstop. (We deliberately do NOT use the tileset <objectgroup> shapes, which aren't
// physics in Pixel Wheels and were the source of the earlier invisible walls.)
// Works in our y-down frame; meters = px / 20.
import { World, Vec2, PolygonShape, CircleShape, type Body } from "planck";
import { UNIT_FOR_PIXEL } from "./constants.ts";
import { forEachTileCollision, type TrackData, type WorldShape } from "./track.ts";

const U = UNIT_FOR_PIXEL;
type Pt = [number, number];

function polygonBody(world: World, pxPoints: Pt[]): Body | null {
  if (pxPoints.length < 3) return null;
  let cx = 0, cy = 0;
  for (const [x, y] of pxPoints) { cx += x; cy += y; }
  cx /= pxPoints.length; cy /= pxPoints.length;
  const verts = pxPoints.map(([x, y]) => new Vec2((x - cx) * U, (y - cy) * U));
  const body = world.createBody({ type: "static", position: new Vec2(cx * U, cy * U) });
  try {
    body.createFixture({ shape: new PolygonShape(verts), restitution: 0.2 });
  } catch (e) {
    world.destroyBody(body);
    console.warn("[trackbody] skipped invalid obstacle polygon", e);
    return null;
  }
  return body;
}

function circleBody(world: World, cxPx: number, cyPx: number, rPx: number): Body {
  const body = world.createBody({ type: "static", position: new Vec2(cxPx * U, cyPx * U) });
  body.createFixture({ shape: new CircleShape(rPx * U), restitution: 0.2 });
  return body;
}

/** Build the static track collision. Returns the count + the shapes (for the debug overlay). */
export function createTrackBodies(world: World, track: TrackData): { count: number; shapes: WorldShape[] } {
  let count = 0;
  const shapes: WorldShape[] = [];
  forEachTileCollision(track, (s) => {
    shapes.push(s);
    if (s.kind === "polygon") { if (polygonBody(world, s.points)) count++; }
    else { circleBody(world, s.x, s.y, s.r); count++; }
  });

  // perimeter so a car can never escape into the void
  const W = track.pixelWidth, H = track.pixelHeight, t = 64;
  const ring: Pt[][] = [
    [[-t, -t], [W + t, -t], [W + t, 0], [-t, 0]],
    [[-t, H], [W + t, H], [W + t, H + t], [-t, H + t]],
    [[-t, 0], [0, 0], [0, H], [-t, H]],
    [[W, 0], [W + t, 0], [W + t, H], [W, H]],
  ];
  for (const r of ring) { if (polygonBody(world, r)) count++; }

  return { count, shapes };
}
