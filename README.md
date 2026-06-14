# Pixel Wheels — WebGPU

A from-scratch **WebGPU** port of [Pixel Wheels](https://github.com/agateau/pixelwheels) by
Aurélien Gâteau — a top-down 2D arcade racer originally built in Java + libGDX + Box2D.

This is a **vertical slice**: one track (snow `race`), a few vehicles, single quick race vs AI, lap
counting and finish. The renderer is raw WebGPU; physics is [planck.js](https://piqnt.com/planck.js/)
(a Box2D port); the vehicle handling reproduces the original's tuning constants.

## Status
See [the plan](../../.claude/plans/) and the in-repo milestones:
- **M0** scaffold + asset pipeline · **M1** WebGPU sprite renderer · **M2** physics + driving ·
  **M3** collision + laps · **M4** AI + race loop

## Assets
The upstream art ships as Aseprite `.ase` sources rendered at build time, and is **not checked in
here**. `npm run assets` reproduces them from a local Pixel Wheels checkout (default
`../pixelwheels-src`, override with `PW_SRC_ROOT`):
- `tools/build-assets.mjs` — a dependency-free `.ase` decoder + PNG encoder → `public/assets/maps/snow.png`
  and `public/assets/sprites/vehicles/*.png`.
- `tools/build-map.mjs` — bakes `race.tmx` + `snow.tsx` into `public/assets/maps/race.json`
  (tile grids, per-tile material/collision, lap-gate `Sections`, AI `Waypoints`).

## Develop
```bash
npm install
npm run assets      # one-time: fetch + parse upstream assets
npm run dev         # http://localhost:5200
```

## Licensing
- **Code** (this port): **GPL-3.0-or-later** — inherited from Pixel Wheels' game logic. See `LICENSE`.
- **Assets** (sprites, tilesets, maps, sounds): **CC-BY-SA 4.0**, © Aurélien Gâteau. See
  `ASSETS-LICENSE.md`. Not redistributed in this repo — fetched from upstream at build time.

This is an unofficial fan port and is not affiliated with or endorsed by the original author.
