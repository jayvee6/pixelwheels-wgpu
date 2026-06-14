# Build status — Pixel Wheels WebGPU

Vertical-slice port. Plan: `~/.claude/plans/sprightly-dreaming-sunrise.md`.
Reference source clone: `../pixelwheels-src` (read-only).

## Done (code-complete, written from the real upstream source)

**M0 — scaffold + asset pipeline**
- Vite + TS repo, `planck` + `fflate` deps installed, GPL-3 + CC-BY-SA notices.
- `tools/ase.mjs` — dependency-free Aseprite decoder; `tools/png.mjs` — PNG encoder.
- `tools/build-assets.mjs` — decodes `snow.ase`→`snow.png` (unpadded 15×18 grid + the upstream
  magenta/cyan colour remap), vehicle `.ase`→PNG (rotated −90), tire `.ase`→PNG, emits
  `sprites-meta.json` (region pixel sizes).
- `tools/build-map.mjs` — `race.tmx`+`snow.tsx` → `race.json` (tile grids via zlib+base64, per-tile
  material/obstacle/collision, `Sections` lap gates, `Waypoints` AI path).
- `tools/build-vehicles.mjs` — vehicle XML → `vehicles.json` (raw attrs; swap applied at runtime).

**M1 — WebGPU sprite renderer**
- `src/engine/{gpu,texture,camera,sprites}.ts` — instanced storage-buffer sprite batch (scale-before-
  rotate), nearest sampling, ortho camera (pan/zoom/rotate), opaque swapchain, resize-safe bind group.
- `src/game/track.ts` — loads `race.json`, builds tile sprites (GID→row-major UV in snow.png).

**M2 — physics + driving** (faithful port; constants in `src/game/constants.ts`)
- `src/game/physics.ts` — planck world (zero-g) + fixed 60 Hz accumulator (6/2 iters).
- `src/game/vehicle.ts` — `Vehicle`+`Wheel`: octagon chassis, CoG shift, 4 wheels on RevoluteJoints,
  lateral-velocity kill + drift, speed-dependent steering, per-wheel drive force with high-speed
  falloff. Ported 1:1 from Vehicle.java / Wheel.java / VehicleCreator.java / Box2DUtils.java.
- `src/game/input.ts` — keyboard → commands; **always accelerating unless braking**; eased
  `DigitalSteering` ramp (left = positive).
- `src/game/tuning.ts` — live slider panel (drive force, grip, drift, steer angles, density, camera…).
- `src/main.ts` — spawn jeep at first waypoint, fixed-step sim, north-up lead-ahead follow camera
  (speed-zoom 0.6→2.1), renders tiles + wheels + car; `window.__pw` debug surface.

## Coordinate decision
Everything is **y-down** (Tiled pixel space); physics meters = px/20 in the same frame. Box2D is
gravity-free so this is just a consistent mirror. **Watch during verify:** if left/right steering is
reversed, flip the sign in `input.ts` (or negate `direction` in `vehicle.ts`). If the car sprite
faces the wrong way, the `--rotate -90` in `build-assets.mjs` is the knob (try +90).

## NOT yet run / verified (blocked on a transient Bash-classifier outage during the session)
Run, in order:
```bash
cd ~/Documents/Development/pixelwheels-wgpu
npm install                 # (already done once)
npm run assets              # decode .ase + bake race.json + vehicles.json   ← validates the decoder
npx tsc --noEmit           # typecheck
npm run dev                # http://localhost:5200
```
Then verify in Chrome via chrome-devtools MCP (not Claude_Preview): check console for WebGPU errors,
confirm the snow track renders (M1), drive the jeep and confirm drift/grip feel + lap-less free drive
(M2). Use the tuning panel to dial feel, then bake defaults into `constants.ts`.

### Things most likely to need a fix on first run
1. `.ase` decode visual fidelity (snow.png) — if wrong, fallback is a packaged upstream release.
2. planck behavioral parity — constants are the upstream starting point; *feel* is the gate (sliders).
3. y-down steering sign / vehicle sprite facing (see Coordinate decision).
4. `npm audit` flagged 2 vuln in dev deps (vite chain) — non-blocking for local dev.

## Next: M3 (track collision + lap counting), M4 (AI + race loop) — not started.
