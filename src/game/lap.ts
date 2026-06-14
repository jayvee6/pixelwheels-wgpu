// Lap positioning + counting, ported from Pixel Wheels:
//   map/Warper.java, map/LapPositionTable.java, map/LapPositionTableIO.java, racer/LapPositionComponent.java
// Works in TILE PIXELS (our y-down world px). A car's lap distance = sectionId + sectionProgress[0..1].
import type { TrackData } from "./track.ts";

// ---------- Warper: projective map source-quad -> unit square (Johnny Lee / Simon Nilsson) ----------
class Warper {
  private warpMat = new Float32Array(16);

  constructor(
    sx0: number, sy0: number, sx1: number, sy1: number, sx2: number, sy2: number, sx3: number, sy3: number,
  ) {
    const srcMat = new Float32Array(16);
    const dstMat = new Float32Array(16);
    Warper.computeQuadToSquare(sx0, sy0, sx1, sy1, sx2, sy2, sx3, sy3, srcMat);
    // destination square (0,-1)(1,-1)(1,1)(0,1) — x is section progress, y is across-track
    Warper.computeSquareToQuad(0, -1, 1, -1, 1, 1, 0, 1, dstMat);
    Warper.multMats(srcMat, dstMat, this.warpMat);
  }

  /** Returns [progress, across] for a source point. progress (x) is in [0,1] within the section. */
  warp(x: number, y: number): [number, number] {
    const m = this.warpMat;
    const r0 = x * m[0] + y * m[4] + m[12];
    const r1 = x * m[1] + y * m[5] + m[13];
    const r3 = x * m[3] + y * m[7] + m[15];
    return [r0 / r3, r1 / r3];
  }

  private static multMats(a: Float32Array, b: Float32Array, res: Float32Array) {
    for (let r = 0; r < 4; r++) {
      const ri = r * 4;
      for (let c = 0; c < 4; c++) {
        res[ri + c] = a[ri] * b[c] + a[ri + 1] * b[c + 4] + a[ri + 2] * b[c + 8] + a[ri + 3] * b[c + 12];
      }
    }
  }

  private static computeSquareToQuad(
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, mat: Float32Array,
  ) {
    const dx1 = x1 - x2, dy1 = y1 - y2;
    const dx2 = x3 - x2, dy2 = y3 - y2;
    const sx = x0 - x1 + x2 - x3;
    const sy = y0 - y1 + y2 - y3;
    const g = (sx * dy2 - dx2 * sy) / (dx1 * dy2 - dx2 * dy1);
    const h = (dx1 * sy - sx * dy1) / (dx1 * dy2 - dx2 * dy1);
    const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
    const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
    mat[0] = a; mat[1] = d; mat[2] = 0; mat[3] = g;
    mat[4] = b; mat[5] = e; mat[6] = 0; mat[7] = h;
    mat[8] = 0; mat[9] = 0; mat[10] = 1; mat[11] = 0;
    mat[12] = c; mat[13] = f; mat[14] = 0; mat[15] = 1;
  }

  private static computeQuadToSquare(
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, mat: Float32Array,
  ) {
    Warper.computeSquareToQuad(x0, y0, x1, y1, x2, y2, x3, y3, mat);
    const a = mat[0], d = mat[1], g = mat[3];
    const b = mat[4], e = mat[5], h = mat[7];
    const c = mat[12], f = mat[13];
    const A = e - f * h, B = c * h - b, C = b * f - c * e;
    const D = f * g - d, E = a - c * g, F = c * d - a * f;
    const G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
    const idet = 1 / (a * A + b * D + c * G);
    mat[0] = A * idet; mat[1] = D * idet; mat[2] = 0; mat[3] = G * idet;
    mat[4] = B * idet; mat[5] = E * idet; mat[6] = 0; mat[7] = H * idet;
    mat[8] = 0; mat[9] = 0; mat[10] = 1; mat[11] = 0;
    mat[12] = C * idet; mat[13] = F * idet; mat[14] = 0; mat[15] = I * idet;
  }
}

// ---------- convexity (AgcMathUtils.isQuadrilateralConvex) ----------
type Pt = [number, number];
function sideOf(p: Pt, q: Pt, pt: Pt): number {
  const f = (pt[0] - p[0]) / (q[0] - p[0]) - (pt[1] - p[1]) / (q[1] - p[1]);
  return f > 0 ? 1 : f < 0 ? -1 : 0;
}
function lineCrossesSegment(lp: Pt, lq: Pt, s1: Pt, s2: Pt): boolean {
  return sideOf(lp, lq, s1) !== sideOf(lp, lq, s2);
}
function isQuadConvex(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  return lineCrossesSegment(p1, p3, p2, p4) && lineCrossesSegment(p2, p4, p1, p3);
}

function pointInQuad(quad: number[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = 6; i < 8; j = i, i += 2) {
    const xi = quad[i], yi = quad[i + 1], xj = quad[j], yj = quad[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- LapPositionTable ----------
export interface LapPosition { sectionId: number; sectionDistance: number; lapDistance: number; }

interface Section { id: number; quad: number[]; warper: Warper; }

export class LapPositionTable {
  readonly sectionCount: number;
  private sections: Section[] = [];

  constructor(track: TrackData) {
    const objs = (track.objects.Sections ?? []).filter((o) => o.points && o.points.length >= 2);
    // absolute 2-point lines, sorted by numeric name
    const lines = objs
      .map((o) => ({
        order: Number(o.name),
        p1: [o.x + o.points![0][0], o.y + o.points![0][1]] as Pt,
        p2: [o.x + o.points![1][0], o.y + o.points![1][1]] as Pt,
      }))
      .sort((a, b) => a.order - b.order);

    for (let i = 0; i < lines.length; i++) {
      const l1 = lines[i];
      const l2 = lines[(i + 1) % lines.length];
      let a = l2.p1, b = l2.p2;
      if (!isQuadConvex(l1.p1, a, b, l1.p2)) {
        [a, b] = [b, a]; // swapPoints
        if (!isQuadConvex(l1.p1, a, b, l1.p2)) {
          console.warn(`[lap] section ${l1.order}->${l2.order} concave; using as-is`);
        }
      }
      const quad = [l1.p1[0], l1.p1[1], a[0], a[1], b[0], b[1], l1.p2[0], l1.p2[1]];
      this.sections.push({
        id: i,
        quad,
        warper: new Warper(quad[0], quad[1], quad[2], quad[3], quad[4], quad[5], quad[6], quad[7]),
      });
    }
    this.sectionCount = this.sections.length;
  }

  /** Each section's 4-corner quad as [x0,y0,x1,y1,x2,y2,x3,y3] (world px). Corners: gate_i.p1,
   *  gate_{i+1}.p1, gate_{i+1}.p2, gate_i.p2 — so edges 0→1 and 3→2 are the road's two sides. */
  get sectionQuads(): number[][] { return this.sections.map((s) => s.quad); }

  /** px,py in tile pixels. Returns null if off all sections. */
  get(px: number, py: number): LapPosition | null {
    for (const s of this.sections) {
      if (pointInQuad(s.quad, px, py)) {
        const progress = s.warper.warp(px, py)[0];
        return { sectionId: s.id, sectionDistance: progress, lapDistance: s.id + progress };
      }
    }
    return null;
  }
}

// ---------- LapTracker (LapPositionComponent) ----------
export type LapStatus = "racing" | "completed";

export class LapTracker {
  lapCount = 0;
  status: LapStatus = "racing";
  totalTime = 0;
  lapTime = 0;
  bestLapTime = Infinity;
  lapDistance = 0; // sectionId + progress, for ranking
  private sectionId = -1;
  private skipNextFinishLine = true;

  constructor(private table: LapPositionTable, public readonly totalLaps = 3) {}

  /** Call each fixed step with the car's world-pixel position. */
  update(px: number, py: number, dt: number) {
    if (this.status !== "racing") return;
    this.totalTime += dt;
    this.lapTime += dt;

    const old = this.sectionId;
    const pos = this.table.get(px, py);
    if (!pos) return; // off-track: keep last section
    this.sectionId = pos.sectionId;
    this.lapDistance = pos.lapDistance;

    const crossedFinish = pos.sectionId === 0 && old > 1;
    const crossedBackward = pos.sectionId > 1 && old === 0;
    if (crossedFinish) {
      if (this.skipNextFinishLine) {
        this.skipNextFinishLine = false;
      } else {
        this.bestLapTime = Math.min(this.bestLapTime, this.lapTime);
        this.lapTime = 0;
      }
      this.lapCount++;
      if (this.lapCount > this.totalLaps) {
        this.lapCount--;
        this.status = "completed";
      }
    } else if (crossedBackward) {
      this.lapCount = Math.max(0, this.lapCount - 1);
      this.skipNextFinishLine = true;
    }
  }

  /** 1-based lap number for display. */
  get displayLap(): number { return Math.min(this.totalLaps, Math.max(1, this.lapCount)); }
  get finished(): boolean { return this.status === "completed"; }
  /** Cumulative race distance for ranking: completed laps + current lap progress. */
  get raceDistance(): number { return this.lapCount * this.sectionCount() + this.lapDistance; }
  private sectionCount(): number { return this.table.sectionCount; }
}
