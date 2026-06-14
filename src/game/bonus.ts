// Bonus pickup system: spot management, per-racer bonus state, bullet and mine entities.
// Ported conceptually from Pixel Wheels' bonus system (com.agateau.pixelwheels.bonus.*).
import * as planck from "planck";
import type { World, Body } from "planck";
import { UNIT_FOR_PIXEL, PIXELS_PER_METER } from "./constants.ts";

// ---- BonusType ----

export type BonusType = "TURBO" | "GUN" | "MINE";
const BONUS_TYPES: BonusType[] = ["TURBO", "GUN", "MINE"];

// ---- BonusSpot ----

/** A pickup point on the track. Respawns after RESPAWN seconds. */
export class BonusSpot {
  x: number; y: number;       // world pixels
  cooldown = 0;               // seconds until available again
  readonly RESPAWN = 5;

  constructor(x: number, y: number) { this.x = x; this.y = y; }

  get available() { return this.cooldown <= 0; }

  pickup(): BonusType {
    this.cooldown = this.RESPAWN;
    return BONUS_TYPES[Math.floor(Math.random() * BONUS_TYPES.length)];
  }

  step(dt: number) {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
  }
}

// ---- BulletEntity ----

/** A planck.js projectile that travels forward and disrupts the first racer it hits. */
export class BulletEntity {
  body: Body;
  life = 3.0;         // seconds until auto-remove
  ownerIndex: number; // racer index — don't hit yourself

  constructor(world: World, x: number, y: number, angle: number, ownerIndex: number) {
    this.ownerIndex = ownerIndex;
    const bx = x * UNIT_FOR_PIXEL;
    const by = y * UNIT_FOR_PIXEL;
    this.body = world.createBody({ type: "dynamic", position: { x: bx, y: by }, angle, bullet: true });
    this.body.createFixture({ shape: planck.Circle(0.3), density: 0.01, isSensor: true });
    // Travel at 60 m/s in the forward direction
    const speed = 60;
    this.body.setLinearVelocity({ x: Math.sin(angle) * speed, y: -Math.cos(angle) * speed });
    // Carry owner index in user data
    (this.body as unknown as { ud: { bullet: boolean; ownerIndex: number } }).ud = { bullet: true, ownerIndex };
  }

  step(dt: number) { this.life -= dt; }
  get dead() { return this.life <= 0; }

  destroy(world: World) { world.destroyBody(this.body); }
}

// ---- MineEntity ----

/** Placed at the car's current position; triggers when any other racer comes within radius. */
export class MineEntity {
  x: number; y: number;    // world pixels
  ownerIndex: number;
  triggered = false;

  constructor(x: number, y: number, ownerIndex: number) {
    this.x = x; this.y = y; this.ownerIndex = ownerIndex;
  }

  checkTrigger(
    racers: Array<{ vehicle: { pixelPos: { x: number; y: number } } }>,
    ownerIndex: number,
  ): number {
    const RADIUS = 40; // pixels
    for (let i = 0; i < racers.length; i++) {
      if (i === ownerIndex) continue;
      const pos = racers[i].vehicle.pixelPos;
      const dx = pos.x - this.x;
      const dy = pos.y - this.y;
      if (dx * dx + dy * dy < RADIUS * RADIUS) {
        this.triggered = true;
        return i; // racer index that triggered it
      }
    }
    return -1;
  }
}

// ---- RacerBonus ----

/** Per-racer bonus slot and turbo timer. */
export class RacerBonus {
  held: BonusType | null = null;
  turboTimer = 0; // seconds of turbo boost remaining

  pickup(type: BonusType) { if (this.held === null) this.held = type; }

  fire(): BonusType | null {
    if (this.held === null) return null;
    const type = this.held;
    this.held = null;
    return type;
  }

  get isHolding() { return this.held !== null; }
  get isTurboActive() { return this.turboTimer > 0; }

  stepTurbo(dt: number) {
    if (this.turboTimer > 0) this.turboTimer = Math.max(0, this.turboTimer - dt);
  }
}

// ---- RacerRef (internal type for step/fire callbacks) ----

interface RacerRef {
  vehicle: {
    pixelPos: { x: number; y: number };
    body: Body;
    angle: number;
    speedKmh: number;
    disrupt(): void;
  };
}

// ---- BonusManager ----

/** Orchestrates spots, bullets, mines, and per-racer bonus state. */
export class BonusManager {
  spots: BonusSpot[] = [];
  bullets: BulletEntity[] = [];
  mines: MineEntity[] = [];
  racerBonuses: RacerBonus[];

  constructor(
    spotDefs: Array<{ x: number; y: number }>,
    racerCount: number,
    private world: World,
  ) {
    // BonusSpot positions in the map JSON are already in pixel coords (center of ellipse)
    this.spots = spotDefs.map((s) => new BonusSpot(s.x, s.y));
    this.racerBonuses = Array.from({ length: racerCount }, () => new RacerBonus());
  }

  step(dt: number, racers: RacerRef[]) {
    // Tick spots
    for (const spot of this.spots) spot.step(dt);

    // Pickup check — racer within 32px of an available spot
    for (let ri = 0; ri < racers.length; ri++) {
      const pos = racers[ri].vehicle.pixelPos;
      for (const spot of this.spots) {
        if (!spot.available) continue;
        const dx = pos.x - spot.x;
        const dy = pos.y - spot.y;
        if (dx * dx + dy * dy < 32 * 32) {
          const type = spot.pickup();
          this.racerBonuses[ri].pickup(type);
        }
      }
    }

    // Tick bullets
    for (const b of this.bullets) b.step(dt);

    // Bullet hit check (pixel-space distance)
    for (const b of this.bullets) {
      if (b.dead) continue;
      const bp = b.body.getPosition();
      const bpx = bp.x * PIXELS_PER_METER;
      const bpy = bp.y * PIXELS_PER_METER;
      for (let ri = 0; ri < racers.length; ri++) {
        if (ri === b.ownerIndex) continue;
        const rp = racers[ri].vehicle.pixelPos;
        const dx = bpx - rp.x;
        const dy = bpy - rp.y;
        if (dx * dx + dy * dy < 30 * 30) {
          racers[ri].vehicle.disrupt();
          b.life = 0; // kill bullet
        }
      }
    }

    // Remove dead bullets
    const dead = this.bullets.filter((b) => b.dead);
    for (const b of dead) b.destroy(this.world);
    this.bullets = this.bullets.filter((b) => !b.dead);

    // Mine trigger check
    for (const mine of this.mines) {
      if (mine.triggered) continue;
      const hitIdx = mine.checkTrigger(racers, mine.ownerIndex);
      if (hitIdx >= 0) racers[hitIdx].vehicle.disrupt();
    }
    this.mines = this.mines.filter((m) => !m.triggered);

    // Turbo bonus effect: apply forward force while turbo is active
    for (let ri = 0; ri < racers.length; ri++) {
      const rb = this.racerBonuses[ri];
      rb.stepTurbo(dt);
      if (rb.isTurboActive) {
        const veh = racers[ri].vehicle;
        const angle = veh.body.getAngle();
        veh.body.applyForceToCenter(
          { x: Math.sin(angle) * 1200, y: -Math.cos(angle) * 1200 },
          true,
        );
      }
    }
  }

  /** Fire the held bonus for a given racer. */
  fireBonus(racerIndex: number, racers: RacerRef[]) {
    const rb = this.racerBonuses[racerIndex];
    const type = rb.fire();
    if (!type) return;

    const veh = racers[racerIndex].vehicle;
    const pos = veh.pixelPos;
    const angle = veh.body.getAngle();

    if (type === "GUN") {
      // Offset bullet spawn slightly forward
      const spawnX = pos.x + Math.sin(angle) * 24;
      const spawnY = pos.y - Math.cos(angle) * 24;
      this.bullets.push(new BulletEntity(this.world, spawnX, spawnY, angle, racerIndex));
    } else if (type === "MINE") {
      this.mines.push(new MineEntity(pos.x, pos.y, racerIndex));
    } else if (type === "TURBO") {
      rb.turboTimer = 2.5; // seconds of boost
    }
  }

  /** Held bonus type for a racer (null = empty slot). Used by HUD. */
  heldBonus(racerIndex: number): BonusType | null {
    return this.racerBonuses[racerIndex]?.held ?? null;
  }
}
