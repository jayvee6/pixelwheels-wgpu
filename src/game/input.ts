// Keyboard input → vehicle commands. Steering (DigitalSteering) is ported 1:1 from upstream (eases in
// over frames, resets on direction flip). Throttle deviates from upstream's always-on accelerate: a
// keyboard player needs to release the gas to unstick from walls, so Up/W accelerates, Down/S brakes.
import { GamePlay } from "./constants.ts";

export interface GameInput {
  accelerating: boolean;
  braking: boolean;
  direction: number; // -1..1, positive = left (matches upstream)
}

// DigitalSteering.steer — must be ticked once per fixed step.
class DigitalSteering {
  private sign = 0;
  private steering = 0;

  steer(left: boolean, right: boolean): number {
    let sign: number;
    if (left === right) sign = 0;
    else if (right) sign = -1;
    else sign = 1;

    if (sign !== this.sign) this.steering = 0;
    if (sign !== 0) this.steering = Math.min(this.steering + GamePlay.steerStep, 1);
    this.sign = sign;
    if (this.sign === 0) return 0;

    const k = this.steering * Math.PI - Math.PI / 2;
    return (0.5 + Math.sin(k) * 0.5) * this.sign;
  }
}

export class GamepadInput {
  private dpad = new DigitalSteering();

  /** Sample once per fixed step. Returns zero/false if no gamepad is connected. */
  sample(): GameInput {
    const gamepads = navigator.getGamepads();
    let gp: Gamepad | null = null;
    for (const g of gamepads) { if (g && g.connected) { gp = g; break; } }
    if (!gp) return { accelerating: false, braking: false, direction: 0 };

    // Analog left stick X (axis 0) — deadzone 0.12, negate so right = positive-left in game coords
    const rawAxis = gp.axes[0] ?? 0;
    const DEADZONE = 0.12;
    const analogActive = Math.abs(rawAxis) > DEADZONE;

    // D-pad buttons: 12=up, 13=down, 14=left, 15=right
    const dpadUp    = gp.buttons[12]?.pressed ?? false;
    const dpadDown  = gp.buttons[13]?.pressed ?? false;
    const dpadLeft  = gp.buttons[14]?.pressed ?? false;
    const dpadRight = gp.buttons[15]?.pressed ?? false;

    // Face buttons: A=0, B=1, X=2
    const accelerating = (gp.buttons[0]?.pressed ?? false) || (gp.buttons[2]?.pressed ?? false) || dpadUp;
    const braking      = (gp.buttons[1]?.pressed ?? false) || dpadDown;

    let direction: number;
    if (analogActive) {
      // Bypass DigitalSteering — map raw axis directly; negate so right stick = right turn
      const clamped = Math.max(-1, Math.min(1, rawAxis));
      const sign = clamped < 0 ? -1 : 1;
      const scaled = (Math.abs(clamped) - DEADZONE) / (1 - DEADZONE);
      direction = -sign * scaled; // negate: right stick (positive) → positive-left in game
    } else {
      direction = this.dpad.steer(dpadLeft, dpadRight);
    }

    return { accelerating: accelerating && !braking, braking, direction };
  }
}

export class CombinedInput {
  private keyboard = new KeyboardInput();
  private gamepad  = new GamepadInput();

  /** Sample once per fixed step. Gamepad takes priority when any axis/button is active. */
  sample(): GameInput {
    const gp = this.gamepad.sample();
    if (gp.accelerating || gp.braking || gp.direction !== 0) return gp;
    return this.keyboard.sample();
  }
}

export class KeyboardInput {
  private keys = new Set<string>();
  private steer = new DigitalSteering();

  constructor(target: Window = window) {
    target.addEventListener("keydown", (e) => {
      this.keys.add(e.key.toLowerCase());
      // prevent page scroll on arrows/space
      if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(e.key.toLowerCase())) e.preventDefault();
    });
    target.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
  }

  /** Sample once per fixed step. */
  sample(): GameInput {
    const left = this.keys.has("arrowleft") || this.keys.has("a");
    const right = this.keys.has("arrowright") || this.keys.has("d");
    const braking = this.keys.has("arrowdown") || this.keys.has("s");
    // Explicit throttle (Up/W) rather than upstream's always-on accelerate: on a keyboard, always-on
    // throttle pins the car against walls (forward grinds in, only reverse backs out, then it re-pins).
    // Letting the player release the gas makes wall recovery possible. Hold Up to drive, Down to brake/reverse.
    const accel = this.keys.has("arrowup") || this.keys.has("w");
    return {
      braking,
      accelerating: accel && !braking,
      // Negated: our world is y-down (Tiled), a mirror of upstream's y-up Box2D frame, so the
      // steer sign flips to keep Right = turn right on screen.
      direction: -this.steer.steer(left, right),
    };
  }
}
