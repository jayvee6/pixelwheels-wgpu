// Vehicle / world tuning constants, ported 1:1 from Pixel Wheels (GamePlay.java, Constants.java,
// Vehicle.java, Wheel.java). These are the STARTING point for handling feel; M2 exposes live sliders
// (see tuning.ts) so they can be dialed against the original, then baked.
//
// Sources (in pixelwheels-src/core/src/com/agateau/pixelwheels/):
//   Constants.java, racescreen/GameWorld*.java, racer/Vehicle.java, racer/Wheel.java, GamePlay.java

export const UNIT_FOR_PIXEL = 1 / 20; // Box2D meters per pixel (1 m = 20 px)
export const PIXELS_PER_METER = 20;

// World step
export const BOX2D_DT = 1 / 60;
export const VELOCITY_ITERATIONS = 6;
export const POSITION_ITERATIONS = 2;

// Speed conversions
export const MS_TO_KMH = 3.6;

// Mutable so the M2 tuning panel (tuning.ts) can adjust feel live; vehicle.ts reads these each frame.
export const GamePlay = {
  // body
  vehicleDensity: 0.3,        // GamePlay.vehicleDensity(3) / 10
  tireBaseDensity: 15,        // GamePlay.tireBaseDensity (× TireSize factor)
  vehicleRestitution: 0.1,    // GamePlay.vehicleRestitution(1) / 10
  vehicleFriction: 0.2,       // Vehicle.java fixture friction
  cogShiftForward: 0.5,       // center of gravity shifted 0.5 * halfLength forward

  // driving force (medium difficulty)
  maxDrivingForce: 40,        // mediumMaxDrivingForce
  accelerationDelta: 1.0,     // per-frame ramp when accelerating
  brakingDelta: 0.8,          // per-frame ramp when braking

  // speed envelope (km/h)
  lowSpeed: 20,
  maxSpeed: 270,

  // steering (degrees)
  stoppedMaxSteer: 80,
  lowSpeedMaxSteer: 14,
  highSpeedMaxSteer: 3,
  steerStep: 0.05,            // input smoothing step toward target direction

  // lateral grip / drift (Wheel.java). Upstream is 2; the headless eval sweep found 3 races cleaner
  // (less understeer-scraping) and faster while keeping drift — slide the tuning panel back to 2 for
  // looser/driftier feel.
  maxLateralImpulse: 2,       // clamp on the "kill lateral velocity" impulse (upstream default; more drift = AI slides around rounded bank corners)
  brakingLateralFactor: 0.2,  // when braking, maxLateralImpulse is divided by this (→ 10)
  driftImpulseReduction: 0.5, // limit on lateral kill while drifting
  angularDamping: 0.1,        // applyAngularImpulse(0.1 * inertia * -omega)

  // ground / drag
  wheelDragFactor: 1,
  groundDragFactor: 8,        // applyDrag((1 - groundSpeed) * 8) when ~stopped

  // turbo (not used in the slice but kept for parity)
  turboStrength: 100,
  turboDuration: 1.0,

  // AI: a leading AI throttles back to this fraction so the player can catch up
  aiSpeedLimiter: 0.8,
  // AI driving tuning (swept by tools/sweep.mjs against the headless eval)
  aiLookAheadWaypoints: 2,  // how many waypoints ahead the AI can see (sweep-tunable)
  aiSteerDivisor: 10,       // direction = clamp(deltaDeg / this, ±1); smaller = harder steering (sweep-tuned)
  aiCornerLiftSpeed: 999,   // km/h above which the AI lifts in a sharp turn (sweep found lifting didn't help → off)
  aiCornerLiftAngle: 30,    // deg of steering demand above which lifting kicks in
  aiCornerBrakeSpeed: 70,   // km/h above which the AI actively brakes in a very sharp turn
  aiCornerBrakeAngle: 45,   // deg of steering demand above which braking kicks in

  // camera (RacerCameraUpdater)
  cameraMinZoom: 0.6,
  cameraMaxZoom: 2.1,
  cameraMaxZoomSpeed: 75,     // m/s at which max zoom-out is reached
  cameraViewportWidth: 60,    // meters across at zoom 1
  cameraAdvancePercent: 0.25, // lead-ahead as fraction of min(viewW,viewH)
  cameraSmooth: 8,            // follow lerp rate (per second); higher = snappier
};

// Material grip multipliers (Material.getGrip). Only ice is slippery.
export const MaterialGrip: Record<string, number> = {
  ROAD: 1.0, TURBO: 1.0, SAND: 1.0, SNOW: 1.0, DEEP_WATER: 1.0, WATER: 1.0, AIR: 1.0, ICE: 0.1,
};

// Material "speed" (Material.getSpeed) — drives ground drag: drag = (1 - groundSpeed) * groundDragFactor
// when groundSpeed < 1. ROAD = 1 (no drag); SNOW slows; TURBO (>1) triggers turbo (unused in slice).
export const MaterialSpeed: Record<string, number> = {
  ROAD: 1, TURBO: 4, SAND: 0.6, SNOW: 0.5, DEEP_WATER: 0, WATER: 0.3, AIR: 0, ICE: 0.3,
};

export type MutableGamePlay = { -readonly [K in keyof typeof GamePlay]: number };
