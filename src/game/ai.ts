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

let _rescueCount = 0;
export function getRescueCount() { return _rescueCount; }
export function resetRescueCount() { _rescueCount = 0; }

const MIN_NORMAL_SPEED = 8 / 3.6; // m/s — 8 km/h converted; below this = potentially stuck
const MAX_BLOCKED_DURATION = 1.2; // s below MIN_NORMAL_SPEED before declaring stuck
const MAX_REVERSE_DURATION = 0.8; // s of reverse to escape a wedge
// Hard-rescue: if raceDistance doesn't advance by MIN_PROGRESS within HARD_RESCUE_THRESHOLD
// seconds, jump ahead to a waypoint. Catches multi-car deadlocks in narrow sections where the
// block/reverse cycle oscillates speed but never escapes (speedKmh briefly > 0 during reverse).
const HARD_RESCUE_THRESHOLD = 4.0;  // simulated seconds without meaningful forward progress
const HARD_RESCUE_MIN_PROGRESS = 0.3; // raceDistance units that count as "making progress"
const HARD_RESCUE_WAYPOINTS_AHEAD = 5; // waypoints to jump forward on rescue
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
  // Hard-rescue state: track elapsed time without forward raceDistance progress.
  private hardStuckTime = 0;
  private hardStuckBaseDist = -1; // raceDistance snapshot when timer last reset

  constructor(
    private world: World,
    private vehicle: Vehicle,
    private lap: LapTracker,
    private store: WaypointStore,
    private track: TrackData,
    private aheadOfAllPlayers: () => boolean, // for the AI speed limiter
  ) {}

  act(dt: number, running: boolean) {
    // Hard-rescue: if raceDistance doesn't advance by MIN_PROGRESS within HARD_RESCUE_THRESHOLD
    // seconds, teleport ahead. Tracks progress not speed, so the block/reverse oscillation
    // (which briefly pushes speed above 0 going backward) doesn't reset the timer.
    if (running) {
      const curDist = this.lap.raceDistance;
      if (this.hardStuckBaseDist < 0) this.hardStuckBaseDist = curDist;
      const delta = curDist - this.hardStuckBaseDist;
      if (delta < -5.0) {
        // Lap wrap: raceDistance reset to start of new lap — don't count as stuck, just re-anchor.
        this.hardStuckTime = 0;
        this.hardStuckBaseDist = curDist;
      } else if (delta >= HARD_RESCUE_MIN_PROGRESS) {
        // Made real forward progress — reset
        this.hardStuckTime = 0;
        this.hardStuckBaseDist = curDist;
      } else {
        this.hardStuckTime += dt;
        if (this.hardStuckTime >= HARD_RESCUE_THRESHOLD) {
          this.hardRescue();
          this.hardStuckTime = 0;
          this.hardStuckBaseDist = -1;
          this.state = "normal";
          this.blockedDuration = 0;
          return;
        }
      }
    }

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

  private hardRescue() {
    _rescueCount++;
    const curDist = this.lap.lapDistance;
    const nextIdx = this.store.getWaypointIndex(curDist);
    // When the car is past all sorted waypoints (nextIdx wraps to 0), the target will have a
    // LOWER lapDistance than current — it's on the other side of the finish line. Allow this
    // case and suppress the backward-cheat guard instead of bailing.
    const pastAllWaypoints = nextIdx === 0 && this.store.count > 0 &&
      curDist > this.store.getWaypointLapDistance(this.store.count - 1);
    let idx = nextIdx;
    for (let i = 0; i < HARD_RESCUE_WAYPOINTS_AHEAD; i++) {
      const next = this.store.getNextIndex(idx);
      // Stop before wrapping the circular waypoint array — except in the pastAllWaypoints case
      // where nextIdx is already 0 and all advances are safe forward steps.
      if (next <= nextIdx && !pastAllWaypoints) break;
      idx = next;
    }
    const targetLapDist = this.store.getWaypointLapDistance(idx);
    // Safety: bail if the target is behind us — UNLESS we're past all waypoints, where the
    // target is naturally lower (cross-finish-line rescue). In that case always proceed.
    if (!pastAllWaypoints && targetLapDist <= curDist) return;
    // Always suppress the LapTracker backward-cheat guard: rescue teleports that jump section
    // boundaries aren't cheating and shouldn't decrement lapCount.
    this.lap.skipNextBackwardGuard();
    const dest = this.store.getWaypoint(idx);
    const tx = dest.x * UNIT_FOR_PIXEL, ty = dest.y * UNIT_FOR_PIXEL;
    // Compute translation delta so wheels move with the body
    const bodyPos = this.vehicle.body.getPosition();
    const dx = tx - bodyPos.x, dy = ty - bodyPos.y;
    // Face the rescue destination so the car doesn't start wedged into a wall.
    const newAngle = Math.atan2(ty - bodyPos.y, tx - bodyPos.x);
    for (const wh of this.vehicle.wheels) {
      const wp = wh.body.getPosition();
      wh.body.setPosition(new Vec2(wp.x + dx, wp.y + dy));
      wh.body.setLinearVelocity(new Vec2(0, 0));
      wh.body.setAngularVelocity(0);
      wh.body.setAngle(newAngle);
    }
    this.vehicle.body.setPosition(new Vec2(tx, ty));
    this.vehicle.body.setLinearVelocity(new Vec2(0, 0));
    this.vehicle.body.setAngularVelocity(0);
    this.vehicle.body.setAngle(newAngle);
  }

  private actBlocked(dt: number) {
    this.vehicle.accelerating = false;
    this.vehicle.braking = true;
    // Alternate steer direction each half-second so the car wiggles free of symmetrical wedges
    // instead of grinding straight back into the same wall.
    this.vehicle.direction = this.reverseDuration % 1 < 0.5 ? 0.5 : -0.5;
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
    const lapDist = this.lap.lapDistance;
    const nextIdx = store.getWaypointIndex(lapDist);
    // When the car is past ALL sorted waypoints (getWaypointIndex wraps to 0), limit look-ahead
    // to 1. Without this, the AI scores wp[4] higher than wp[0] and aims at a waypoint whose
    // pixel coordinates are deep inside the track, causing the car to drive backward through
    // sections to reach it. Aiming at just wp[0] (physically just past the finish line) keeps
    // the car going forward across the finish line.
    const pastAllWaypoints = nextIdx === 0 && lapDist > store.getWaypointLapDistance(store.count - 1);
    const lookAhead = pastAllWaypoints ? 1 : GamePlay.aiLookAheadWaypoints;
    let index = store.getPreviousIndex(nextIdx);
    let bestScore = -Infinity;
    let best: { x: number; y: number } | null = null;
    for (let i = -1; i < lookAhead; i++, index = store.getNextIndex(index)) {
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
