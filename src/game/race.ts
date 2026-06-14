// Race controller: countdown → running → finished, multi-racer stepping, and live ranking.
// Stepping happens inside the fixed physics step (before world.step): each pilot sets vehicle inputs,
// the vehicle queues forces, and lap trackers advance. Ranking is by cumulative race distance.
import type { Vehicle } from "./vehicle.ts";
import type { LapTracker } from "./lap.ts";
import type { AIPilot } from "./ai.ts";
import type { GameInput } from "./input.ts";
import { getMaterialAt, type TrackData } from "./track.ts";
import { BonusManager } from "./bonus.ts";
import type { World } from "planck";

export interface Racer {
  name: string;
  vehicle: Vehicle;
  lap: LapTracker;
  isPlayer: boolean;
  ai?: AIPilot;
  input?: { sample(): GameInput };
}

export type RaceState = "countdown" | "running" | "finished";

const COUNTDOWN_SECONDS = 3; // "3..2..1..GO" (upstream: 3 ticks × 0.75s ≈ 3s)

export class Race {
  state: RaceState = "countdown";
  countdown = COUNTDOWN_SECONDS;
  goTimer = 0; // seconds the "GO!" banner stays up after countdown hits 0
  bonusManager: BonusManager | null = null;

  constructor(public racers: Racer[], private track: TrackData) {}

  get running(): boolean { return this.state === "running"; }

  /** Advance one fixed step. Call inside the physics step, BEFORE world.step. */
  step(dt: number) {
    if (this.state === "countdown") {
      this.countdown -= dt;
      if (this.countdown <= 0) { this.state = "running"; this.goTimer = 1; }
    } else if (this.goTimer > 0) {
      this.goTimer = Math.max(0, this.goTimer - dt);
    }
    const running = this.running;

    for (const r of this.racers) {
      // material under the car → grip + ground drag
      const cp = r.vehicle.pixelPos;
      const mat = getMaterialAt(this.track, cp.x, cp.y);
      r.vehicle.groundMaterial = mat;
      r.vehicle.setMaterialForWheels(mat);

      if (r.isPlayer && r.input) {
        const gi = r.input.sample();
        r.vehicle.direction = gi.direction;
        r.vehicle.accelerating = gi.accelerating;
        r.vehicle.braking = gi.braking;
      } else if (r.ai) {
        r.ai.act(dt, running);
      }
      // during countdown, running=false → vehicle ignores throttle (cars hold at the line)
      r.vehicle.act(running && !r.lap.finished);
      r.lap.update(cp.x, cp.y, dt);
    }

    // bonus system: advance spots, bullets, mines, and apply turbo
    this.bonusManager?.step(dt, this.racers);

    // race ends when every player has finished
    if (this.state === "running" && this.racers.filter((r) => r.isPlayer).every((r) => r.lap.finished)) {
      this.state = "finished";
    }
  }

  /** Initialize the bonus manager from map spot definitions and the planck world. */
  initBonusManager(spots: Array<{ x: number; y: number }>, world: World) {
    this.bonusManager = new BonusManager(spots, this.racers.length, world);
  }

  /** Fire the player's held bonus (no-op if no bonus held or no bonus manager). */
  firePlayerBonus() {
    const playerIdx = this.racers.findIndex((r) => r.isPlayer);
    if (playerIdx < 0 || !this.bonusManager) return;
    this.bonusManager.fireBonus(playerIdx, this.racers);
  }

  /** Racers ordered by standing (1st = furthest). Finished racers rank by total time. */
  standings(): Racer[] {
    return [...this.racers].sort((a, b) => {
      const af = a.lap.finished, bf = b.lap.finished;
      if (af && bf) return a.lap.totalTime - b.lap.totalTime;     // both done: faster first
      if (af !== bf) return af ? -1 : 1;                          // finished ahead of racing
      return b.lap.raceDistance - a.lap.raceDistance;             // racing: further first
    });
  }

  /** 1-based position of a racer. */
  positionOf(racer: Racer): number {
    return this.standings().indexOf(racer) + 1;
  }
}
