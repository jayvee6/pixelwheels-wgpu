// Headless game-quality eval harness. Runs a full AI race entirely in Node (no WebGPU, no browser):
// the physics (planck), AI, lap, and race logic are renderer-independent. Drives N AI racers around
// the track, collects objective metrics, prints JSON + a composite quality score. This is the "eval"
// half of the autonomous run→eval→fix loop. Run: node --experimental-strip-types tools/eval.ts
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorld } from "../src/game/physics.ts";
import { LapPositionTable, LapTracker } from "../src/game/lap.ts";
import { WaypointStore } from "../src/game/waypoints.ts";
import { AIPilot } from "../src/game/ai.ts";
import { Vehicle, type VehicleDef } from "../src/game/vehicle.ts";
import { createTrackBodies } from "../src/game/trackbody.ts";
import { getMaterialAt, findStartPositions, findStart, type TrackData } from "../src/game/track.ts";
import { BOX2D_DT, VELOCITY_ITERATIONS, POSITION_ITERATIONS, GamePlay } from "../src/game/constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(__dirname, "../public/assets");

const ROSTER = ["jeep", "red", "police", "jeep"];
const LAPS = Number(process.env.EVAL_LAPS ?? 3);
const MAX_SECONDS = Number(process.env.EVAL_MAX_SECONDS ?? 240);
const COUNTDOWN = 3;

interface RacerMetric {
  name: string;
  finished: boolean;
  finishTime: number | null;
  bestLap: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  stuckEvents: number;     // # times speed < 5 km/h for > 1.2 s while running & not finished
  stuckSeconds: number;    // total time spent stuck
  wallContacts: number;    // car-body-vs-wall begin-contact count (cornering smoothness proxy)
  raceDistance: number;
}

// Apply GamePlay overrides from env (PARAM_<key>=value) so the sweep can search the space.
function applyOverrides() {
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("PARAM_")) continue;
    const key = k.slice(6) as keyof typeof GamePlay;
    if (key in GamePlay && v != null) (GamePlay as Record<string, number>)[key] = Number(v);
  }
}

function main() {
  applyOverrides();
  const track = JSON.parse(readFileSync(resolve(ASSETS, "maps/race.json"), "utf8")) as TrackData;
  const defs = JSON.parse(readFileSync(resolve(ASSETS, "vehicles.json"), "utf8")) as Record<string, VehicleDef>;
  const meta = JSON.parse(readFileSync(resolve(ASSETS, "sprites-meta.json"), "utf8")) as Record<string, { w: number; h: number }>;

  const world = createWorld();
  const lapTable = new LapPositionTable(track);
  createTrackBodies(world, track);
  const waypoints = new WaypointStore(track, lapTable);

  // count car-body-vs-wall contacts (a proxy for cornering smoothness / track roughness)
  const wallContacts: number[] = [];
  world.on("begin-contact", (contact) => {
    const ba = contact.getFixtureA().getBody(), bb = contact.getFixtureB().getBody();
    const sa = ba.isStatic(), sb = bb.isStatic();
    if (sa === sb) return; // need exactly one static (wall) + one dynamic (car)
    const dyn = sa ? bb : ba;
    const ud = dyn.getUserData() as { racer?: number } | null;
    if (ud && typeof ud.racer === "number") wallContacts[ud.racer] = (wallContacts[ud.racer] ?? 0) + 1;
  });

  // start heading from the racing line
  const wp = track.objects.Waypoints?.[0];
  const angle = wp?.points
    ? Math.atan2((wp.y + wp.points[1][1]) - (wp.y + wp.points[0][1]), (wp.x + wp.points[1][0]) - (wp.x + wp.points[0][0]))
    : 0;
  const startCells = findStartPositions(track).map((p) => ({ x: p.x, y: p.y + track.tileH / 2 }));
  const pose = (i: number) => {
    if (i < startCells.length) return { x: startCells[i].x, y: startCells[i].y };
    const b = startCells[startCells.length - 1] ?? findStart(track);
    return { x: b.x - Math.cos(angle) * (i - startCells.length + 1) * 80, y: b.y - Math.sin(angle) * (i - startCells.length + 1) * 80 };
  };

  interface R { name: string; vehicle: Vehicle; lap: LapTracker; ai: AIPilot; m: RacerMetric; stuckTimer: number; sumSpeed: number; samples: number; }
  const racers: R[] = ROSTER.map((id, i) => {
    const p = pose(i);
    const vehicle = new Vehicle(world, defs[id], p.x * (1 / 20), p.y * (1 / 20), angle, GamePlay.maxDrivingForce, meta);
    const lap = new LapTracker(lapTable, LAPS);
    const m: RacerMetric = { name: `${id}#${i}`, finished: false, finishTime: null, bestLap: Infinity, maxSpeedKmh: 0, avgSpeedKmh: 0, stuckEvents: 0, stuckSeconds: 0, wallContacts: 0, raceDistance: 0 };
    vehicle.body.setUserData({ racer: i }); // tag chassis so the contact listener can attribute wall hits
    return { name: m.name, vehicle, lap, ai: null as unknown as AIPilot, m, stuckTimer: 0, sumSpeed: 0, samples: 0 };
  });
  for (const r of racers) {
    r.ai = new AIPilot(world, r.vehicle, r.lap, waypoints, track, () => false); // no rubber-band in eval
  }

  let t = 0, countdown = COUNTDOWN;
  let steps = 0;
  const maxSteps = Math.ceil(MAX_SECONDS / BOX2D_DT);
  while (steps < maxSteps) {
    countdown -= BOX2D_DT;
    const running = countdown <= 0;
    if (running) t += BOX2D_DT;

    for (const r of racers) {
      const cp = r.vehicle.pixelPos;
      const mat = getMaterialAt(track, cp.x, cp.y);
      r.vehicle.groundMaterial = mat;
      r.vehicle.setMaterialForWheels(mat);
      r.ai.act(BOX2D_DT, running);
      r.vehicle.act(running && !r.lap.finished);
      r.lap.update(cp.x, cp.y, BOX2D_DT);

      if (running && !r.lap.finished) {
        const sp = r.vehicle.speedKmh;
        r.m.maxSpeedKmh = Math.max(r.m.maxSpeedKmh, sp);
        r.sumSpeed += sp; r.samples++;
        if (sp < 5) { r.stuckTimer += BOX2D_DT; r.m.stuckSeconds += BOX2D_DT; if (r.stuckTimer > 1.2) { r.m.stuckEvents++; r.stuckTimer = 0; } }
        else r.stuckTimer = 0;
      }
      if (r.lap.finished && r.m.finishTime === null) { r.m.finished = true; r.m.finishTime = t; r.m.bestLap = r.lap.bestLapTime; }
    }
    world.step(BOX2D_DT, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
    steps++;
    if (racers.every((r) => r.lap.finished)) break;
  }

  for (const r of racers) {
    r.m.avgSpeedKmh = r.samples ? r.sumSpeed / r.samples : 0;
    r.m.raceDistance = r.lap.raceDistance;
    r.m.wallContacts = wallContacts[racers.indexOf(r)] ?? 0;
    if (!isFinite(r.m.bestLap)) r.m.bestLap = 0;
  }

  // ---- composite score (higher = better) ----
  const finishedCount = racers.filter((r) => r.m.finished).length;
  const finishTimes = racers.filter((r) => r.m.finished).map((r) => r.m.finishTime!);
  const totalStuck = racers.reduce((s, r) => s + r.m.stuckEvents, 0);
  const totalContacts = racers.reduce((s, r) => s + r.m.wallContacts, 0);
  const spread = finishTimes.length >= 2 ? Math.max(...finishTimes) - Math.min(...finishTimes) : 0;
  const avgFinish = finishTimes.length ? finishTimes.reduce((a, b) => a + b, 0) / finishTimes.length : MAX_SECONDS;

  // score: all-finish is paramount; then penalize stuck + wall scraping + slow races; reward lively spread
  let score = 0;
  score += finishedCount * 20;                          // up to 80 for 4/4
  score -= totalStuck * 4;                              // sustained-stuck is bad
  score -= Math.min(40, totalContacts * 0.15);         // wall scraping = rough cornering (finer-grained)
  score -= Math.min(40, avgFinish / 4);                // faster races score better (cap)
  score += spread > 3 && spread < 40 ? 10 : 0;         // healthy field spread

  const out = {
    laps: LAPS,
    simSeconds: +t.toFixed(1),
    finishedCount,
    allFinished: finishedCount === racers.length,
    totalStuckEvents: totalStuck,
    totalWallContacts: totalContacts,
    avgFinishTime: +avgFinish.toFixed(1),
    fieldSpread: +spread.toFixed(1),
    score: +score.toFixed(1),
    racers: racers.map((r) => ({ ...r.m, bestLap: +r.m.bestLap.toFixed(1), finishTime: r.m.finishTime == null ? null : +r.m.finishTime.toFixed(1), maxSpeedKmh: +r.m.maxSpeedKmh.toFixed(0), avgSpeedKmh: +r.m.avgSpeedKmh.toFixed(0), stuckSeconds: +r.m.stuckSeconds.toFixed(1), raceDistance: +r.m.raceDistance.toFixed(1) })),
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
