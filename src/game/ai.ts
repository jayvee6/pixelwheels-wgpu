// AIPilot — ported from racer/AIPilot.java. Reactive waypoint-following with a stuck-recovery state
// machine. The upstream line-of-sight raycast avoids dynamic obstacles (mines/cars); the slice has
// none, so we keep the waypoint-scoring + material weighting and the blocked/reverse recovery.
import { World, Vec2 } from "planck";
import { GamePlay, MaterialSpeed, UNIT_FOR_PIXEL } from "./constants.ts";
import type { Vehicle } from "./vehicle.ts";
import type { WaypointStore } from "./waypoints.ts";
import type { LapTracker } from "./lap.ts";
import type { TrackData } from "./track.ts";
import { getMaterialAt } from "./track.ts";

/** True if a static wall lies on the segment between two world-pixel points. */
function wallBetween(world: World, ax: number, ay: number, bx: number, by: number): boolean {
  let hit = false;
  world.rayCast(
    new Vec2(ax * UNIT_FOR_PIXEL, ay * UNIT_FOR_PIXEL),
    new Vec2(bx * UNIT_FOR_PIXEL, by * UNIT_FOR_PIXEL),
    (fixture, _p, _n, fraction) => {
      if (fixture.getBody().isStatic()) { hit = true; return 0; } // stop at first wall
      return fraction; // ignore dynamic bodies (other cars), keep going
    },
  );
  return hit;
}

const MIN_NORMAL_SPEED = 2;       // m/s
const MAX_BLOCKED_DURATION = 1;   // s below MIN_NORMAL_SPEED before reversing
const MAX_REVERSE_DURATION = 0.9; // s — longer than upstream; gives the jeep room to swing clear of bank corners
// Pulled from GamePlay so the eval sweep can search it (PARAM_aiLookAheadWaypoints)

function normalizeAngleDeg(a: number): number {
  let r = a % 360;
  if (r < 0) r += 360;
  return r;
}

export class AIPilot {
  private state: "normal" | "blocked" = "normal";
  private blockedDuration = 0;
  private reverseDuration = 0;

  constructor(
    private world: World,
    private vehicle: Vehicle,
    private lap: LapTracker,
    private store: WaypointStore,
    private track: TrackData,
    private aheadOfAllPlayers: () => boolean, // for the AI speed limiter
  ) {}

  act(dt: number, running: boolean) {
    if (this.state === "blocked") { this.actBlocked(dt); return; }

    // accelerate (with a limiter if this AI is ahead of every player)
    this.vehicle.accelerating = true;
    this.vehicle.braking = false;
    this.vehicle.speedLimiter = this.aheadOfAllPlayers() ? GamePlay.aiSpeedLimiter : 1;

    this.updateDirection();

    if (running && this.vehicle.speedKmh / 3.6 < MIN_NORMAL_SPEED) {
      this.blockedDuration += dt;
      if (this.blockedDuration > MAX_BLOCKED_DURATION) { this.state = "blocked"; this.reverseDuration = 0; }
    } else {
      this.blockedDuration = 0;
    }
  }

  private actBlocked(dt: number) {
    this.vehicle.accelerating = false;
    this.vehicle.braking = true;
    this.vehicle.direction = 0;
    this.reverseDuration += dt;
    if (this.reverseDuration > MAX_REVERSE_DURATION) { this.state = "normal"; this.blockedDuration = 0; }
  }

  private updateDirection() {
    const target = this.findBestTarget();
    if (!target) { this.state = "blocked"; this.reverseDuration = 0; return; }

    const p = this.vehicle.pixelPos;
    const targetAngle = normalizeAngleDeg(Math.atan2(target.y - p.y, target.x - p.x) * 180 / Math.PI);
    const vehicleAngleDeg = normalizeAngleDeg(this.vehicle.angle * 180 / Math.PI);
    let delta = targetAngle - vehicleAngleDeg;
    if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
    // positive direction increases heading (verified vs player mapping) → steer toward the target
    this.vehicle.direction = clamp(delta / GamePlay.aiSteerDivisor, -1, 1);

    // Corner braking: a large steering demand at speed means a sharp turn the car will understeer
    // through (into the wall). Lift off / brake so the turn tightens, the way a real driver would.
    const speedKmh = this.vehicle.speedKmh;
    const absDelta = Math.abs(delta);
    if (speedKmh > GamePlay.aiCornerLiftSpeed && absDelta > GamePlay.aiCornerLiftAngle) {
      this.vehicle.accelerating = false;
      if (speedKmh > GamePlay.aiCornerBrakeSpeed && absDelta > GamePlay.aiCornerBrakeAngle) this.vehicle.braking = true;
    }
  }

  // Furthest-ahead waypoint that is (a) reachable without a wall in the way and (b) not over a hole.
  // The wall check makes the AI corner instead of cutting straight into the banks.
  private findBestTarget(): { x: number; y: number } | null {
    const store = this.store;
    if (store.count === 0) return null;
    const car = this.vehicle.pixelPos;
    const nextIdx = store.getWaypointIndex(this.lap.lapDistance);
    let index = store.getPreviousIndex(nextIdx);
    let bestScore = -Infinity;
    let best: { x: number; y: number } | null = null;
    for (let i = -1; i < GamePlay.aiLookAheadWaypoints; i++, index = store.getNextIndex(index)) {
      const wp = store.getWaypoint(index);
      if (wallBetween(this.world, car.x, car.y, wp.x, wp.y)) continue; // can't see it → skip
      const mat = getMaterialAt(this.track, wp.x, wp.y);
      const matSpeed = MaterialSpeed[mat] ?? 1;
      if (matSpeed <= 0) continue; // hole / void — skip
      const score = i + matSpeed;
      if (score > bestScore) { bestScore = score; best = { x: wp.x, y: wp.y }; }
    }
    // Fallback: if every candidate is wall-blocked (tight corner), still aim at the next waypoint so
    // the AI grinds forward through the corner instead of giving up and reverse-looping.
    if (!best) { const n = store.getWaypoint(nextIdx); best = { x: n.x, y: n.y }; }
    return best;
  }
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
