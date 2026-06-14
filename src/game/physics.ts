// planck.js world wrapper. Top-down racer: zero gravity, fixed 60 Hz step with 6/2 iterations
// (matching the upstream Box2D settings).
import { World, Vec2 } from "planck";
import { BOX2D_DT, VELOCITY_ITERATIONS, POSITION_ITERATIONS } from "./constants.ts";

export function createWorld(): World {
  return new World({ gravity: new Vec2(0, 0) });
}

/** Advance with an accumulator so the sim is frame-rate independent (clamped against spiral-of-death).
 *  alpha: fraction of a physics step elapsed since the last step — use for render interpolation. */
export class FixedStepper {
  private acc = 0;

  /** How far past the last physics step the render is: 0 = just stepped, approaching 1 = almost next step. */
  get alpha(): number { return Math.min(1, this.acc / BOX2D_DT); }

  constructor(
    private world: World,
    private onStep: (dt: number) => void,
    private onPostStep?: () => void,
  ) {}

  advance(realDt: number) {
    this.acc += Math.min(realDt, 0.25);
    let steps = 0;
    while (this.acc >= BOX2D_DT && steps < 5) {
      this.onStep(BOX2D_DT);
      this.world.step(BOX2D_DT, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
      this.onPostStep?.();
      this.acc -= BOX2D_DT;
      steps++;
    }
  }
}
