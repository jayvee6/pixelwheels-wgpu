// Vehicle + Wheel physics, ported faithfully from Pixel Wheels:
//   racer/Vehicle.java, racer/Wheel.java, vehicledef/VehicleCreator.java, utils/Box2DUtils.java
// Body angle 0 = facing +x (east). World units = Box2D meters; render converts via PIXELS_PER_METER.
import { World, Vec2, PolygonShape, RevoluteJoint, type Body, type MassData } from "planck";
import {
  UNIT_FOR_PIXEL, MS_TO_KMH, PIXELS_PER_METER, GamePlay, MaterialGrip, MaterialSpeed,
} from "./constants.ts";

const BOX2D_DT: number = 1 / 60;

const DEG2RAD = Math.PI / 180;
// libGDX Interpolation.sineOut: sin(a * PI/2)
const sineOut = (a: number) => Math.sin(a * Math.PI / 2);

export interface VehicleDef {
  id: string; name: string; speed: number;
  width: number; height: number; // RAW xml attrs (sprite upright: width across, height along)
  image: string;
  shapes: { type: string; width: number; height: number; corner?: number; x?: number; y?: number }[];
  axles: { width: number; y: number; steer: number; drive: number; drift: boolean; tireSize: string }[];
}

const TIRE_DENSITY_FACTOR: Record<string, number> = { THIN: 0.2, NORMAL: 0.2, LARGE: 0.2, HUGE: 0.05 };
const tireDensity = (size: string) => (TIRE_DENSITY_FACTOR[size] ?? 0.2) * GamePlay.tireBaseDensity;

/** Box2DUtils.createOctogon → array of Vec2 (meters). */
function octogon(w: number, h: number, cw: number, ch: number): Vec2[] {
  const v = [
    [w / 2 - cw, -h / 2], [w / 2, -h / 2 + ch], [w / 2, h / 2 - ch], [w / 2 - cw, h / 2],
    [-w / 2 + cw, h / 2], [-w / 2, h / 2 - ch], [-w / 2, -h / 2 + ch], [-w / 2 + cw, -h / 2],
  ];
  return v.map(([x, y]) => new Vec2(x, y));
}

function lateralVelocity(body: Body): Vec2 {
  const normal = body.getWorldVector(new Vec2(0, 1)); // body local-y
  const v = normal.x * body.getLinearVelocity().x + normal.y * body.getLinearVelocity().y;
  return new Vec2(normal.x * v, normal.y * v);
}

function applyDrag(body: Body, factor: number) {
  const lv = body.getLinearVelocity();
  body.applyForce(new Vec2(-factor * lv.x, -factor * lv.y), body.getWorldCenter(), true);
}

class Wheel {
  body: Body;
  canDrift = false;
  maxDrivingForce = 0;
  steeringFactor = 0;
  joint!: RevoluteJoint;
  drifting = false;
  material = "ROAD";

  constructor(world: World, x: number, y: number, angleRad: number, density: number, wPx: number, hPx: number) {
    this.body = world.createBody({ type: "dynamic", position: new Vec2(x, y), angle: angleRad });
    const w = UNIT_FOR_PIXEL * wPx;
    const h = UNIT_FOR_PIXEL * hPx;
    this.body.createFixture({ shape: new PolygonShape(octogon(w, h, w / 4, w / 4)), density });
  }

  // Wheel.adjustSpeed — drive force along the wheel's own (possibly steered) heading.
  adjustSpeed(amount: number) {
    if (amount === 0) return;
    const lv = this.body.getLinearVelocity();
    const speedKmh = Math.hypot(lv.x, lv.y) * MS_TO_KMH;
    const limit = 1 - 0.2 * sineOut(speedKmh / GamePlay.maxSpeed);
    amount *= limit;
    const force = this.maxDrivingForce * amount;
    const angle = this.body.getAngle();
    this.body.applyForce(
      new Vec2(force * Math.cos(angle), force * Math.sin(angle)),
      this.body.getWorldCenter(), true,
    );
  }

  // Wheel.updateFriction — kill lateral velocity (with drift slip) + kill angular velocity.
  updateFriction(isBraking: boolean) {
    const grip = MaterialGrip[this.material] ?? 1;
    const mass = this.body.getMass();
    const lat = lateralVelocity(this.body);
    let ix = lat.x * -mass * grip;
    let iy = lat.y * -mass * grip;
    let maxImpulse = GamePlay.maxLateralImpulse / (isBraking ? GamePlay.brakingLateralFactor : 1);
    const len = Math.hypot(ix, iy);
    const isIce = this.material === "ICE";
    const isWater = this.material === "WATER" || this.material === "DEEP_WATER";
    if (!isIce && !isWater && this.canDrift && len > maxImpulse) {
      this.drifting = true;
      maxImpulse = Math.max(maxImpulse, len - GamePlay.driftImpulseReduction);
      if (len > maxImpulse) { const s = maxImpulse / len; ix *= s; iy *= s; }
    } else {
      this.drifting = false;
    }
    this.body.applyLinearImpulse(new Vec2(ix, iy), this.body.getWorldCenter(), true);
    this.body.applyAngularImpulse(0.1 * this.body.getInertia() * -this.body.getAngularVelocity(), true);
  }

  act(isBraking: boolean) {
    this.updateFriction(isBraking);
    applyDrag(this.body, GamePlay.wheelDragFactor);
  }
}

export class Vehicle {
  body: Body;
  wheels: Wheel[] = [];
  def: VehicleDef;
  // input
  direction = 0;     // -1..1 (already smoothed by input layer)
  accelerating = false;
  braking = false;
  speedLimiter = 1;  // 0..1 throttle scale (AI uses this to hold back when leading)
  groundMaterial = "ROAD"; // material under the car body (set by the game each step)
  // render size in px: x extent (forward) = xml height, y extent (lateral) = xml width
  readonly renderW: number;
  readonly renderH: number;
  // disruption state (wall hit at speed → temporary slowdown)
  disruptedTimer = 0; // seconds remaining in disrupted state
  readonly DISRUPTED_DURATION = 1.5;
  // rescue state (vehicle fell into DEEP_WATER → freeze → teleport to last safe position)
  lastSafePos = { x: 0, y: 0 }; // world pixels; updated each step when on safe ground
  rescueTimer = 0;               // seconds until teleport completes
  readonly RESCUE_DURATION = 1.8;
  get isRescuing() { return this.rescueTimer > 0; }

  constructor(world: World, def: VehicleDef, x: number, y: number, angleRad: number, maxDrivingForce: number,
              tireSizes: Record<string, { w: number; h: number }>) {
    this.def = def;
    // VehicleIO swaps width/height: body-space width(x) = xml height, height(y) = xml width.
    this.renderW = def.height; // along forward axis (x)
    this.renderH = def.width;  // lateral (y)

    this.body = world.createBody({ type: "dynamic", position: new Vec2(x, y), angle: angleRad });
    for (const s of def.shapes) {
      // octogon in body space: width(x) = xml height attr, height(y) = xml width attr (the swap)
      const w = UNIT_FOR_PIXEL * s.height;
      const h = UNIT_FOR_PIXEL * s.width;
      const c = UNIT_FOR_PIXEL * (s.corner ?? 0);
      this.body.createFixture({
        shape: new PolygonShape(octogon(w, h, c, c)),
        density: GamePlay.vehicleDensity,
        friction: GamePlay.vehicleFriction,
        restitution: GamePlay.vehicleRestitution,
      });
    }
    // Move center of gravity forward (Vehicle.moveCenterOfGravity uses the rotated region height = xml width).
    const md: MassData = { mass: 0, center: new Vec2(0, 0), I: 0 };
    this.body.getMassData(md);
    md.center.x += GamePlay.cogShiftForward * (def.width / 2) * UNIT_FOR_PIXEL;
    this.body.setMassData(md);

    const drivingForce = maxDrivingForce * def.speed;
    const renderWidthPx = def.height; // rotated region width

    for (const axle of def.axles) {
      const wheelY = (axle.width * UNIT_FOR_PIXEL) / 2;
      const wheelX = (axle.y - renderWidthPx / 2) * UNIT_FOR_PIXEL;
      const drive = drivingForce * axle.drive;
      const density = tireDensity(axle.tireSize);
      const tire = tireSizes[`tires/${axle.tireSize}`] ?? { w: 6, h: 12 };
      for (const sign of [1, -1]) {
        // rotate the local offset by spawn angle, add to spawn position
        const lx = wheelX, ly = wheelY * sign;
        const wx = x + lx * Math.cos(angleRad) - ly * Math.sin(angleRad);
        const wy = y + lx * Math.sin(angleRad) + ly * Math.cos(angleRad);
        const wheel = new Wheel(world, wx, wy, angleRad, density, tire.w, tire.h);
        wheel.steeringFactor = axle.steer;
        wheel.canDrift = axle.drift;
        wheel.maxDrivingForce = drive;
        // RevoluteJoint locking the wheel to the chassis at its position (limit set each frame).
        wheel.joint = world.createJoint(
          new RevoluteJoint({ enableLimit: true, lowerAngle: 0, upperAngle: 0 },
            this.body, wheel.body, wheel.body.getPosition()),
        ) as RevoluteJoint;
        this.wheels.push(wheel);
      }
    }
  }

  // Vehicle.computeSteerAngle — speed-dependent max steer, scaled by input direction.
  private computeSteerAngle(): number {
    if (Math.abs(this.direction) < 1e-4) return 0;
    const lv = this.body.getLinearVelocity();
    const speed = Math.hypot(lv.x, lv.y) * MS_TO_KMH;
    let steer: number;
    if (speed < GamePlay.lowSpeed) {
      steer = lerp(GamePlay.stoppedMaxSteer, GamePlay.lowSpeedMaxSteer, speed / GamePlay.lowSpeed);
    } else if (speed < GamePlay.maxSpeed) {
      const f = (speed - GamePlay.lowSpeed) / (GamePlay.maxSpeed - GamePlay.lowSpeed);
      steer = lerp(GamePlay.lowSpeedMaxSteer, GamePlay.highSpeedMaxSteer, f);
    } else {
      steer = GamePlay.highSpeedMaxSteer;
    }
    return this.direction * steer;
  }

  /** Trigger water rescue: freeze the body and start the rescue countdown. */
  triggerRescue() {
    if (this.isRescuing) return; // already rescuing
    this.rescueTimer = this.RESCUE_DURATION;
    this.body.setLinearVelocity(new Vec2(0, 0));
    this.body.setAngularVelocity(0);
  }

  /** Record the current body position as the last safe landing spot (world pixels). */
  markSafePosition() {
    const p = this.body.getPosition();
    this.lastSafePos.x = p.x / UNIT_FOR_PIXEL;
    this.lastSafePos.y = p.y / UNIT_FOR_PIXEL;
  }

  /** Vehicle.act — must be called once per fixed step, BEFORE world.step. running = race RUNNING state. */
  act(running: boolean) {
    // --- water rescue: freeze + teleport back to last safe position ---
    if (this.isRescuing) {
      this.rescueTimer = Math.max(0, this.rescueTimer - BOX2D_DT);
      this.body.setLinearVelocity(new Vec2(0, 0));
      this.body.setAngularVelocity(0);
      if (this.rescueTimer === 0) {
        const sx = this.lastSafePos.x * UNIT_FOR_PIXEL;
        const sy = this.lastSafePos.y * UNIT_FOR_PIXEL;
        this.body.setPosition(new Vec2(sx, sy));
        this.body.setLinearVelocity(new Vec2(0, 0));
      }
      return; // skip all other vehicle logic while rescuing
    }

    // applyPilotCommands
    let speedDelta = 0;
    if (running) {
      if (this.accelerating) speedDelta = GamePlay.accelerationDelta * this.speedLimiter;
      if (this.braking) speedDelta -= GamePlay.brakingDelta;
    }
    const steerAngle = this.computeSteerAngle() * DEG2RAD;
    for (const w of this.wheels) {
      const angle = w.steeringFactor * steerAngle;
      w.adjustSpeed(speedDelta);
      w.joint.setLimits(angle, angle);
    }
    // applyGroundEffects: ground drag from the material under the car (ROAD=1 → none; SNOW slows).
    const groundSpeed = MaterialSpeed[this.groundMaterial] ?? 1;
    if (groundSpeed < 1) applyDrag(this.body, (1 - groundSpeed) * GamePlay.groundDragFactor);

    // turbo boost: TURBO tiles apply a forward force burst (in addition to suppressing drag).
    if (this.groundMaterial === "TURBO") {
      const fwd = this.body.getWorldVector(new Vec2(0, 1));
      this.body.applyForceToCenter(new Vec2(fwd.x * 800, fwd.y * 800), true);
    }

    // disruption: wall hit at speed caps velocity for DISRUPTED_DURATION seconds.
    if (this.disruptedTimer > 0) {
      this.disruptedTimer = Math.max(0, this.disruptedTimer - BOX2D_DT);
      const vel = this.body.getLinearVelocity();
      const speed = Math.sqrt(vel.x ** 2 + vel.y ** 2);
      // GamePlay.maxSpeed is in km/h; convert to m/s for Box2D comparison.
      const maxDisruptedSpeed = (GamePlay.maxSpeed / MS_TO_KMH) * 0.35;
      if (speed > maxDisruptedSpeed) {
        const scale = maxDisruptedSpeed / speed;
        this.body.setLinearVelocity(new Vec2(vel.x * scale, vel.y * scale));
      }
    }

    // actWheels
    for (const w of this.wheels) w.act(this.braking);
  }

  /** Trigger a disruption (wall hit): caps vehicle speed for DISRUPTED_DURATION seconds. */
  disrupt() { this.disruptedTimer = this.DISRUPTED_DURATION; }

  get angle(): number { return this.body.getAngle(); }
  get speedKmh(): number { const v = this.body.getLinearVelocity(); return Math.hypot(v.x, v.y) * MS_TO_KMH; }
  get isDrifting(): boolean { return this.wheels.some((w) => w.drifting); }
  get isBoosting(): boolean { return this.groundMaterial === "TURBO"; }
  get isDisrupted(): boolean { return this.disruptedTimer > 0; }

  /** World position in pixels (for the renderer/camera). */
  get pixelPos(): { x: number; y: number } {
    const p = this.body.getPosition();
    return { x: p.x * PIXELS_PER_METER, y: p.y * PIXELS_PER_METER };
  }

  setMaterialForWheels(material: string) { for (const w of this.wheels) w.material = material; }
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
