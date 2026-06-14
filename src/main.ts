// Pixel Wheels WebGPU — entry point.
// M4: full single-player quick race. Player jeep + AI racers on the snow/country track, ported
// planck.js physics + static collision, material grip/drag, lap counting, countdown → running →
// finished race state with live standings, a follow camera, and a live tuning panel.
// Track selection is preserved via URL params (?track=race|country&car=0|1|2).
import { initWebGPU, resizeToDisplay } from "./engine/gpu.ts";
import { loadTexture, type LoadedTexture } from "./engine/texture.ts";
import { Camera2D } from "./engine/camera.ts";
import { SpriteBatch, rectUV, type Sprite } from "./engine/sprites.ts";
import { SkidMarks } from "./engine/skidmarks.ts";
import { loadTrack, buildTileSprites, findStart, findStartPositions } from "./game/track.ts";
import { createWorld, FixedStepper } from "./game/physics.ts";
import { createTrackBodies } from "./game/trackbody.ts";
import { LapPositionTable, LapTracker } from "./game/lap.ts";
import { WaypointStore } from "./game/waypoints.ts";
import { AIPilot } from "./game/ai.ts";
import { Race, type Racer } from "./game/race.ts";
import { Vehicle, type VehicleDef } from "./game/vehicle.ts";
import { CombinedInput } from "./game/input.ts";
import { GamePlay, PIXELS_PER_METER, UNIT_FOR_PIXEL } from "./game/constants.ts";
import { createTuningPanel } from "./game/tuning.ts";
import { AudioEngine } from "./engine/audio.ts";
import { ChiptunePlayer } from "./engine/music.ts";
import { Minimap } from "./game/minimap.ts";
import { ParticleSystem } from "./engine/particles.ts";

import type { World } from "planck";

const canvas = document.getElementById("gpu") as HTMLCanvasElement;
const hud = document.getElementById("hud") as HTMLDivElement;
const errEl = document.getElementById("err") as HTMLDivElement;

function fatal(e: unknown) {
  const msg = e instanceof Error ? `${e.message}\n\n${e.stack ?? ""}` : String(e);
  errEl.textContent = `Pixel Wheels failed to start:\n\n${msg}`;
  errEl.style.display = "grid";
  console.error(e);
}

type SpriteMeta = Record<string, { w: number; h: number }>;

interface RacerConfig { defId: string; name: string; player?: boolean; tint?: [number, number, number]; }

// Car selection options (index = choice index, not ROSTER index)
const CAR_OPTIONS = [
  { defId: "jeep",      label: "Jeep" },
  { defId: "red",       label: "Red Racer" },
  { defId: "police",    label: "Police Car" },
  { defId: "pickup",    label: "Pickup" },
  { defId: "miramar",   label: "Miramar" },
  { defId: "old-f1",    label: "Old F1" },
  { defId: "roadster",  label: "Roadster" },
  { defId: "harvester", label: "Harvester" },
  { defId: "santa",     label: "Santa" },
  { defId: "rocket",    label: "Rocket" },
  { defId: "2cv",       label: "2CV" },
  { defId: "dark-m",    label: "Dark-M" },
  { defId: "antonin",   label: "Antonin" },
  { defId: "c15",       label: "C15" },
  { defId: "bigfoot",   label: "Bigfoot" },
] as const;

// Track options
const TRACK_OPTIONS = [
  { name: "race",         label: "Snow Ridge",   emoji: "❄️"  },
  { name: "country",      label: "Country Road",  emoji: "🌿"  },
  { name: "snow2",        label: "Snow Slalom",   emoji: "🌨️" },
  { name: "snow3",        label: "Icy Circuit",   emoji: "⛄"  },
  { name: "flood",        label: "Flood Plains",  emoji: "🌊"  },
  { name: "river",        label: "Riverside",     emoji: "🏞️" },
  { name: "be",           label: "Be Circuit",    emoji: "🏁"  },
  { name: "city3",        label: "City Speedway", emoji: "🌆"  },
  { name: "tiny-sur-mer", label: "Tiny-sur-Mer",  emoji: "⛵"  },
] as const;
type TrackName = typeof TRACK_OPTIONS[number]["name"];

// Read track + car selections from URL params (set when switching tracks mid-session)
function getUrlParams(): { trackIdx: number; carIdx: number | null } {
  const p = new URLSearchParams(location.search);
  const trackParam = p.get("track") ?? "";
  const carParam = p.get("car");
  const trackIdx = Math.max(0, TRACK_OPTIONS.findIndex((t) => t.name === trackParam));
  const carIdx = carParam !== null ? Math.max(0, Math.min(CAR_OPTIONS.length - 1, Number(carParam))) : null;
  return { trackIdx, carIdx };
}

/** Navigate to the same page with updated track/car params — causes full reload (GPU textures swap). */
function switchTrack(trackIdx: number, carIdx: number) {
  const p = new URLSearchParams();
  p.set("track", TRACK_OPTIONS[trackIdx].name);
  p.set("car", String(carIdx));
  location.href = `${location.pathname}?${p}`;
}

// AI roster entries to fill remaining 3 slots, cycling through cars other than the chosen one
function buildRoster(chosenIdx: number): RacerConfig[] {
  const chosen = CAR_OPTIONS[chosenIdx];
  const aiOptions = CAR_OPTIONS.filter((_, i) => i !== chosenIdx);
  // third AI gets a tinted jeep if only 2 other cars available
  const aiConfigs: RacerConfig[] = [
    { defId: aiOptions[0].defId, name: aiOptions[0].label },
    { defId: aiOptions[1].defId, name: aiOptions[1].label },
    { defId: chosen.defId,       name: chosen.label, tint: [0.55, 0.7, 1] },
  ];
  return [
    { defId: chosen.defId, name: "You", player: true },
    ...aiConfigs,
  ];
}

let ROSTER: RacerConfig[] = buildRoster(0); // default; overwritten after menu

// ---- Title / Car + Track Selection Menu ----
function showMenu(initialTrackIdx: number, initialCarIdx: number): Promise<{ carIdx: number; trackIdx: number; difficulty: "easy" | "medium" | "hard"; laps: number }> {
  return new Promise((resolve) => {
    let selected = initialCarIdx;
    let selectedTrack = initialTrackIdx;
    let selectedDiff: "easy" | "medium" | "hard" = "medium";
    let selectedLaps = 3;

    const overlay = document.createElement("div");
    overlay.style.cssText = [
      "position:fixed", "inset:0", "z-index:50",
      "background:rgba(8,12,24,0.97)",
      "display:flex", "flex-direction:column",
      "align-items:center", "justify-content:center",
      "font-family:monospace", "color:#eee",
      "user-select:none",
    ].join(";");

    // Title
    const title = document.createElement("div");
    title.textContent = "PIXEL WHEELS";
    title.style.cssText = [
      "font-size:3.2rem", "font-weight:900", "letter-spacing:.25em",
      "color:#FFD700", "text-shadow:0 0 28px rgba(255,170,0,0.7)",
      "margin-bottom:.4rem",
    ].join(";");

    const subtitle = document.createElement("div");
    subtitle.textContent = "choose your track & car";
    subtitle.style.cssText = [
      "font-size:1rem", "letter-spacing:.18em", "color:#aaa",
      "margin-bottom:1.6rem",
    ].join(";");

    // Track selection
    const trackSectionLabel = document.createElement("div");
    trackSectionLabel.textContent = "TRACK";
    trackSectionLabel.style.cssText = "font-size:.7rem;letter-spacing:.2em;color:#666;margin-bottom:.6rem;";

    const trackRow = document.createElement("div");
    trackRow.style.cssText = "display:flex;flex-wrap:wrap;gap:.6rem;margin-bottom:1.8rem;max-width:900px;justify-content:center;";

    function makeTrackBtn(i: number): HTMLButtonElement {
      const opt = TRACK_OPTIONS[i];
      const tb = document.createElement("button");
      const updateTrackStyle = () => {
        const active = selectedTrack === i;
        tb.style.cssText = [
          "font-family:monospace", "font-size:.85rem", "font-weight:bold",
          "letter-spacing:.1em", "cursor:pointer", "padding:.45rem 1.2rem",
          "border-radius:8px",
          `border:2px solid ${active ? "#FFD700" : "rgba(255,255,255,0.15)"}`,
          `background:${active ? "rgba(255,215,0,0.13)" : "rgba(255,255,255,0.04)"}`,
          `color:${active ? "#FFD700" : "#888"}`,
          "transition:border 0.12s,background 0.12s,color 0.12s",
        ].join(";");
      };
      updateTrackStyle();
      tb.textContent = `${opt.emoji}  ${opt.label}`;
      tb.addEventListener("click", () => {
        selectedTrack = i;
        refreshTrackBtns();
      });
      (tb as HTMLButtonElement & { _updateStyle: () => void })._updateStyle = updateTrackStyle;
      return tb;
    }
    const trackBtns: HTMLButtonElement[] = TRACK_OPTIONS.map((_, i) => makeTrackBtn(i));
    trackBtns.forEach((b) => trackRow.appendChild(b));

    function refreshTrackBtns() {
      trackBtns.forEach((b, bi) => {
        const active = selectedTrack === bi;
        b.style.border = `2px solid ${active ? "#FFD700" : "rgba(255,255,255,0.15)"}`;
        b.style.background = active ? "rgba(255,215,0,0.13)" : "rgba(255,255,255,0.04)";
        b.style.color = active ? "#FFD700" : "#888";
      });
    }

    // Difficulty selection
    const diffSectionLabel = document.createElement("div");
    diffSectionLabel.textContent = "DIFFICULTY";
    diffSectionLabel.style.cssText = "font-size:.7rem;letter-spacing:.2em;color:#666;margin-bottom:.6rem;";

    const diffRow = document.createElement("div");
    diffRow.style.cssText = "display:flex;flex-wrap:wrap;gap:.6rem;margin-bottom:1.8rem;justify-content:center;";

    const DIFF_OPTIONS: Array<{ id: "easy" | "medium" | "hard"; label: string }> = [
      { id: "easy",   label: "Easy" },
      { id: "medium", label: "Medium" },
      { id: "hard",   label: "Hard" },
    ];

    function makeDiffBtn(opt: typeof DIFF_OPTIONS[number]): HTMLButtonElement {
      const db = document.createElement("button");
      const updateDiffStyle = () => {
        const active = selectedDiff === opt.id;
        db.style.cssText = [
          "font-family:monospace", "font-size:.85rem", "font-weight:bold",
          "letter-spacing:.1em", "cursor:pointer", "padding:.45rem 1.4rem",
          "border-radius:8px",
          `border:2px solid ${active ? "#FFD700" : "rgba(255,255,255,0.15)"}`,
          `background:${active ? "rgba(255,215,0,0.13)" : "rgba(255,255,255,0.04)"}`,
          `color:${active ? "#FFD700" : "#888"}`,
          "transition:border 0.12s,background 0.12s,color 0.12s",
        ].join(";");
      };
      updateDiffStyle();
      db.textContent = opt.label;
      db.addEventListener("click", () => {
        selectedDiff = opt.id;
        refreshDiffBtns();
      });
      (db as HTMLButtonElement & { _updateStyle: () => void })._updateStyle = updateDiffStyle;
      return db;
    }
    const diffBtns = DIFF_OPTIONS.map((o) => makeDiffBtn(o));
    diffBtns.forEach((b) => diffRow.appendChild(b));

    function refreshDiffBtns() {
      diffBtns.forEach((b, bi) => {
        const active = selectedDiff === DIFF_OPTIONS[bi].id;
        b.style.border = `2px solid ${active ? "#FFD700" : "rgba(255,255,255,0.15)"}`;
        b.style.background = active ? "rgba(255,215,0,0.13)" : "rgba(255,255,255,0.04)";
        b.style.color = active ? "#FFD700" : "#888";
      });
    }

    // Lap count selection
    const lapSectionLabel = document.createElement("div");
    lapSectionLabel.textContent = "LAPS";
    lapSectionLabel.style.cssText = "font-size:.7rem;letter-spacing:.2em;color:#666;margin-bottom:.6rem;";

    const lapRow = document.createElement("div");
    lapRow.style.cssText = "display:flex;flex-wrap:wrap;gap:.6rem;margin-bottom:1.8rem;justify-content:center;";

    const LAP_OPTIONS = [1, 3, 5];

    function makeLapBtn(count: number): HTMLButtonElement {
      const lb = document.createElement("button");
      const updateLapStyle = () => {
        const active = selectedLaps === count;
        lb.style.cssText = [
          "font-family:monospace", "font-size:.85rem", "font-weight:bold",
          "letter-spacing:.1em", "cursor:pointer", "padding:.45rem 1.4rem",
          "border-radius:8px",
          `border:2px solid ${active ? "#FFD700" : "rgba(255,255,255,0.15)"}`,
          `background:${active ? "rgba(255,215,0,0.13)" : "rgba(255,255,255,0.04)"}`,
          `color:${active ? "#FFD700" : "#888"}`,
          "transition:border 0.12s,background 0.12s,color 0.12s",
        ].join(";");
      };
      updateLapStyle();
      lb.textContent = `${count} Lap${count > 1 ? "s" : ""}`;
      lb.addEventListener("click", () => {
        selectedLaps = count;
        refreshLapBtns();
      });
      (lb as HTMLButtonElement & { _updateStyle: () => void })._updateStyle = updateLapStyle;
      return lb;
    }
    const lapBtns = LAP_OPTIONS.map((c) => makeLapBtn(c));
    lapBtns.forEach((b) => lapRow.appendChild(b));

    function refreshLapBtns() {
      lapBtns.forEach((b, bi) => {
        const active = selectedLaps === LAP_OPTIONS[bi];
        b.style.border = `2px solid ${active ? "#FFD700" : "rgba(255,255,255,0.15)"}`;
        b.style.background = active ? "rgba(255,215,0,0.13)" : "rgba(255,255,255,0.04)";
        b.style.color = active ? "#FFD700" : "#888";
      });
    }

    // Car section label
    const carSectionLabel = document.createElement("div");
    carSectionLabel.textContent = "CAR";
    carSectionLabel.style.cssText = "font-size:.7rem;letter-spacing:.2em;color:#666;margin-bottom:.6rem;";

    // Car cards row (wrapping grid for 15 vehicles)
    const carRow = document.createElement("div");
    carRow.style.cssText = [
      "display:flex", "flex-wrap:wrap", "gap:.8rem", "margin-bottom:2.4rem",
      "max-width:900px", "justify-content:center",
    ].join(";");

    function makeCard(i: number): HTMLDivElement {
      const opt = CAR_OPTIONS[i];
      const card = document.createElement("div");
      const updateStyle = () => {
        const active = selected === i;
        card.style.cssText = [
          "display:flex", "flex-direction:column", "align-items:center",
          "gap:.4rem", "padding:.7rem .9rem",
          "border-radius:10px", "cursor:pointer",
          `border:2px solid ${active ? "#FFD700" : "rgba(255,255,255,0.12)"}`,
          `background:${active ? "rgba(255,215,0,0.10)" : "rgba(255,255,255,0.04)"}`,
          "transition:border 0.12s,background 0.12s",
          "min-width:90px",
        ].join(";");
      };
      updateStyle();

      const img = document.createElement("img");
      img.src = `/assets/sprites/vehicles/${opt.defId}.png`;
      img.style.cssText = [
        "width:auto", "height:auto",
        "image-rendering:pixelated",
        "transform:scale(3)", "transform-origin:center",
        "margin:1.5rem 0",  // space for the 3× scaled image
      ].join(";");

      const label = document.createElement("div");
      label.textContent = opt.label;
      label.style.cssText = [
        "font-size:.85rem", "letter-spacing:.1em",
        "color:#ddd", "margin-top:.2rem",
      ].join(";");

      card.appendChild(img);
      card.appendChild(label);

      card.addEventListener("click", () => {
        selected = i;
        cards.forEach((c, ci) => {
          const active2 = selected === ci;
          c.style.border = `2px solid ${active2 ? "#FFD700" : "rgba(255,255,255,0.12)"}`;
          c.style.background = active2 ? "rgba(255,215,0,0.10)" : "rgba(255,255,255,0.04)";
        });
      });
      card.addEventListener("dblclick", () => confirm());

      // store updateStyle for later re-calls
      (card as HTMLDivElement & { _updateStyle: () => void })._updateStyle = updateStyle;
      return card;
    }

    const cards: HTMLDivElement[] = CAR_OPTIONS.map((_, i) => makeCard(i));
    cards.forEach((c) => carRow.appendChild(c));

    // RACE button
    const btn = document.createElement("button");
    btn.textContent = "RACE!";
    btn.style.cssText = [
      "font-family:monospace", "font-size:1.4rem", "font-weight:900",
      "letter-spacing:.22em", "cursor:pointer",
      "padding:.65rem 2.8rem",
      "background:#FFD700", "color:#111",
      "border:none", "border-radius:8px",
      "box-shadow:0 0 24px rgba(255,215,0,0.45)",
      "transition:transform 0.08s,box-shadow 0.08s",
    ].join(";");
    btn.addEventListener("mouseenter", () => { btn.style.transform = "scale(1.06)"; btn.style.boxShadow = "0 0 36px rgba(255,215,0,0.7)"; });
    btn.addEventListener("mouseleave", () => { btn.style.transform = ""; btn.style.boxShadow = "0 0 24px rgba(255,215,0,0.45)"; });

    function confirm() {
      window.removeEventListener("keydown", onKey);
      overlay.style.transition = "opacity 0.28s";
      overlay.style.opacity = "0";
      setTimeout(() => overlay.remove(), 290);
      resolve({ carIdx: selected, trackIdx: selectedTrack, difficulty: selectedDiff, laps: selectedLaps });
    }

    btn.addEventListener("click", confirm);

    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") {
        selected = (selected + CAR_OPTIONS.length - 1) % CAR_OPTIONS.length;
        refreshCards();
      } else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") {
        selected = (selected + 1) % CAR_OPTIONS.length;
        refreshCards();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        confirm();
      } else if (e.key === "t" || e.key === "T") {
        selectedTrack = (selectedTrack + 1) % TRACK_OPTIONS.length;
        refreshTrackBtns();
      }
    }

    function refreshCards() {
      cards.forEach((c, ci) => {
        const active = selected === ci;
        c.style.border = `2px solid ${active ? "#FFD700" : "rgba(255,255,255,0.12)"}`;
        c.style.background = active ? "rgba(255,215,0,0.10)" : "rgba(255,255,255,0.04)";
      });
    }

    window.addEventListener("keydown", onKey);

    const hint = document.createElement("div");
    hint.textContent = "← → car  ·  T track  ·  Enter to race";
    hint.style.cssText = [
      "font-size:.75rem", "color:#555", "letter-spacing:.1em",
      "margin-top:1rem",
    ].join(";");

    overlay.appendChild(title);
    overlay.appendChild(subtitle);
    overlay.appendChild(trackSectionLabel);
    overlay.appendChild(trackRow);
    overlay.appendChild(diffSectionLabel);
    overlay.appendChild(diffRow);
    overlay.appendChild(lapSectionLabel);
    overlay.appendChild(lapRow);
    overlay.appendChild(carSectionLabel);
    overlay.appendChild(carRow);
    overlay.appendChild(btn);
    overlay.appendChild(hint);
    document.body.appendChild(overlay);
  });
}

async function main() {
  const gpu = await initWebGPU(canvas);
  resizeToDisplay(canvas);

  // Read URL params (set when switching tracks mid-session via T key or menu)
  const urlParams = getUrlParams();
  const initialTrackIdx = urlParams.trackIdx;
  const initialCarIdx = urlParams.carIdx ?? 0;

  // Show menu unless URL already has both track + car (i.e. came from a T-key track switch)
  let selectedTrackIdx: number;
  let selectedCarIdx: number;
  let selectedDifficulty: "easy" | "medium" | "hard" = "medium";
  let selectedLaps = 3;
  if (urlParams.carIdx !== null) {
    // Skip menu — came from track switch, jump straight into race
    selectedTrackIdx = initialTrackIdx;
    selectedCarIdx = initialCarIdx;
  } else {
    const choice = await showMenu(initialTrackIdx, initialCarIdx);
    selectedTrackIdx = choice.trackIdx;
    selectedCarIdx = choice.carIdx;
    selectedDifficulty = choice.difficulty;
    selectedLaps = choice.laps;
  }
  ROSTER = buildRoster(selectedCarIdx);

  const trackName: TrackName = TRACK_OPTIONS[selectedTrackIdx].name;

  // --- load data ---
  const [track, vehiclesJson, metaJson] = await Promise.all([
    loadTrack(`/assets/maps/${trackName}.json`),
    fetch("/assets/vehicles.json").then((r) => r.json() as Promise<Record<string, VehicleDef>>),
    fetch("/assets/sprites-meta.json").then((r) => r.json() as Promise<SpriteMeta>),
  ]);
  const tileset = await loadTexture(gpu.device, `/assets/maps/${track.tileset.image}`);

  // unique vehicle textures + a shared tire texture
  const defIds = [...new Set(ROSTER.map((r) => r.defId))];
  const carTex: Record<string, LoadedTexture> = {};
  for (const id of defIds) carTex[id] = await loadTexture(gpu.device, `/assets/sprites/vehicles/${vehiclesJson[id].image}.png`);
  let tireTex: LoadedTexture | null = null;
  try { tireTex = await loadTexture(gpu.device, `/assets/sprites/tires/LARGE.png`); } catch { /* optional */ }

  const tileSprites: Sprite[] = buildTileSprites(track, tileset.width, tileset.height);

  // --- batches ---
  const tileBatch = new SpriteBatch(gpu.device, gpu.format, tileset.view, tileSprites.length + 16);
  const carBatch: Record<string, SpriteBatch> = {};
  for (const id of defIds) carBatch[id] = new SpriteBatch(gpu.device, gpu.format, carTex[id].view, 8);
  const tireBatch = tireTex ? new SpriteBatch(gpu.device, gpu.format, tireTex.view, 64) : null;

  // --- world ---
  const world: World = createWorld();
  const lapTable = new LapPositionTable(track);
  const { shapes: wallShapes } = createTrackBodies(world, track);

  // --- skid marks (persistent GPU RTT texture) ---
  const skidMarks = new SkidMarks(gpu.device, track.pixelWidth, track.pixelHeight);
  const skidBatch = new SpriteBatch(gpu.device, gpu.format, skidMarks.view, 4, "linear");
  const skidSprite: Sprite = {
    x: track.pixelWidth / 2, y: track.pixelHeight / 2,
    w: track.pixelWidth, h: track.pixelHeight, rot: 0,
    ...rectUV(0, 0, 1, 1),
  };

  // --- snow particles (drifting spray) ---
  interface Particle { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; cr?: number; cg?: number; cb?: number; }
  const particles: Particle[] = [];
  const MAX_PARTICLES = 350;

  // --- camera shake state (wall collision → burst that decays over time) ---
  let shakeAmt = 0;
  let shakePhaseX = 0;
  let shakePhaseY = 1.3; // offset phases so x and y shake out of sync

  world.on("begin-contact", (contact) => {
    const ba = contact.getFixtureA().getBody(), bb = contact.getFixtureB().getBody();
    const sa = ba.isStatic(), sb = bb.isStatic();
    if (sa === sb) return;
    const dyn = sa ? bb : ba;
    const ud = dyn.getUserData() as { racer?: number } | null;
    if (ud?.racer === undefined) return;
    const v = dyn.getLinearVelocity();
    const spd = Math.hypot(v.x, v.y);
    if (spd < 1) return; // ignore gentle touches
    // smoke burst at impact point (all racers)
    const pos = dyn.getPosition();
    const ix = pos.x * PIXELS_PER_METER, iy = pos.y * PIXELS_PER_METER;
    const count = Math.min(Math.round(2 + spd * 1.2), 12);
    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = spd * PIXELS_PER_METER * (0.04 + Math.random() * 0.12);
      const life = 0.22 + Math.random() * 0.18;
      particles.push({ x: ix + (Math.random() - 0.5) * 10, y: iy + (Math.random() - 0.5) * 10,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, maxLife: life,
        cr: 0.72, cg: 0.72, cb: 0.78 });
    }
    // disrupt any racer that hits a wall hard (15 km/h threshold → 4.17 m/s in Box2D units)
    if (spd > 4.17) {
      race.racers[ud.racer]?.vehicle.disrupt();
    }
    if (ud.racer === 0) { // player only: shake + audio
      shakeAmt = Math.min(shakeAmt + spd * 0.35, 5);
      audio.impact(spd / 8);
    }
  });
  const waypoints = new WaypointStore(track, lapTable);

  // --- finish-screen overlay ---
  const finishOverlayEl = document.createElement("div");
  finishOverlayEl.style.cssText = [
    "position:fixed", "inset:0", "display:flex", "flex-direction:column",
    "align-items:center", "justify-content:center", "pointer-events:none",
    "z-index:15", "background:rgba(4,6,12,0.78)", "font-family:monospace",
    "transition:opacity 0.45s", "opacity:0",
  ].join(";");
  document.body.appendChild(finishOverlayEl);

  // --- pause overlay (Escape key toggles while running) ---
  const pauseOverlay = document.createElement("div");
  pauseOverlay.style.cssText = [
    "position:fixed", "inset:0", "z-index:40",
    "background:rgba(8,12,24,0.88)",
    "display:none", "flex-direction:column",
    "align-items:center", "justify-content:center",
    "font-family:monospace", "color:#eee",
  ].join(";");

  const pauseTitle = document.createElement("div");
  pauseTitle.textContent = "PAUSED";
  pauseTitle.style.cssText = "font-size:3rem;font-weight:900;color:#FFD700;letter-spacing:.3em;margin-bottom:2rem;text-shadow:0 0 24px rgba(255,170,0,0.6);";

  function makePauseBtn(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = [
      "font-family:monospace", "font-size:1.1rem", "font-weight:bold",
      "letter-spacing:.15em", "cursor:pointer",
      "padding:.7rem 2.5rem", "margin:.4rem",
      "border-radius:8px", "border:2px solid #FFD700",
      "background:rgba(255,215,0,0.1)", "color:#FFD700",
    ].join(";");
    btn.addEventListener("click", onClick);
    return btn;
  }

  const resumeBtn = makePauseBtn("▶  RESUME", () => { paused = false; pauseOverlay.style.display = "none"; });
  const quitBtn   = makePauseBtn("✕  QUIT TO MENU", () => { location.href = location.pathname; });
  pauseOverlay.append(pauseTitle, resumeBtn, quitBtn);
  document.body.appendChild(pauseOverlay);

  // --- mute toggle button ---
  const muteBtn = document.createElement("div");
  muteBtn.style.cssText = [
    "position:fixed", "bottom:16px", "right:16px", "z-index:20",
    "font-size:1.4rem", "cursor:pointer", "user-select:none",
    "background:rgba(0,0,0,0.5)", "border-radius:50%",
    "width:2.4rem", "height:2.4rem", "display:flex",
    "align-items:center", "justify-content:center",
    "transition:opacity 0.2s", "opacity:0.7",
  ].join(";");
  muteBtn.textContent = "🔊";
  muteBtn.title = "Toggle music (M)";
  muteBtn.addEventListener("click", () => {
    if (music) { const muted = music.toggleMute(); muteBtn.textContent = muted ? "🔇" : "🔊"; }
  });
  muteBtn.addEventListener("mouseenter", () => muteBtn.style.opacity = "1");
  muteBtn.addEventListener("mouseleave", () => muteBtn.style.opacity = "0.7");
  document.body.appendChild(muteBtn);

  // --- floating car-position labels (Canvas2D, device-pixel-scaled) ---
  const labelsCanvas = document.createElement("canvas");
  labelsCanvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:8;";
  document.body.appendChild(labelsCanvas);
  const labelsCtx = labelsCanvas.getContext("2d")!;
  function resizeLabels() {
    labelsCanvas.width = Math.round(window.innerWidth * devicePixelRatio);
    labelsCanvas.height = Math.round(window.innerHeight * devicePixelRatio);
  }
  resizeLabels();
  window.addEventListener("resize", resizeLabels);

  // --- Canvas2D particle system (explosions, smoke, rescue fade) ---
  const vfx = new ParticleSystem();
  // Track which racers were disrupted last frame to detect the onset transition
  const prevDisrupted = new Set<number>();

  // --- wrong-way indicator ---
  const wrongWayEl = document.createElement("div");
  wrongWayEl.style.cssText = [
    "position:fixed", "top:110px", "left:50%", "transform:translateX(-50%)",
    "font-family:monospace", "font-weight:900", "font-size:1.5rem",
    "color:#f44", "background:rgba(0,0,0,0.72)", "padding:6px 20px",
    "border-radius:8px", "pointer-events:none", "z-index:12",
    "letter-spacing:.06em", "transition:opacity 0.2s", "opacity:0",
    "text-shadow:0 0 14px #f44",
  ].join(";");
  wrongWayEl.textContent = "◄ WRONG WAY ►";
  document.body.appendChild(wrongWayEl);

  // --- lap-delta banner (colored: green=new best, red=slower, gray=first lap) ---
  const lapDeltaEl = document.createElement("div");
  lapDeltaEl.style.cssText = [
    "position:fixed", "top:155px", "left:50%", "transform:translateX(-50%)",
    "font-family:monospace", "font-weight:bold", "font-size:1.3rem",
    "padding:5px 18px", "border-radius:8px", "pointer-events:none",
    "z-index:12", "letter-spacing:.04em", "transition:opacity 0.3s", "opacity:0",
    "background:rgba(0,0,0,0.72)",
  ].join(";");
  document.body.appendChild(lapDeltaEl);

  // --- centered countdown overlay ---
  const countdownEl = document.createElement("div");
  countdownEl.style.cssText = [
    "position:fixed", "inset:0", "display:flex", "align-items:center", "justify-content:center",
    "pointer-events:none", "z-index:20", "font-family:monospace", "font-weight:900",
    "text-shadow:0 0 24px rgba(0,0,0,0.9), 0 4px 8px rgba(0,0,0,0.7)",
    "transition:opacity 0.15s",
  ].join(";");
  document.body.appendChild(countdownEl);
  let lastCountdownLabel = "";

  // --- minimap overlay (Canvas2D element, updates each frame with racer positions) ---
  const wpArray = Array.from({ length: waypoints.count }, (_, i) => waypoints.getWaypoint(i));
  const minimap = new Minimap(
    document.body,
    track.pixelWidth, track.pixelHeight,
    wpArray,
  );

  // --- collision debug overlay (toggle with 'C') — red = where the static walls are ---
  const whiteTex = gpu.device.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  gpu.device.queue.writeTexture({ texture: whiteTex }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
  const collisionSprites: Sprite[] = wallShapes.map((s) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (s.kind === "polygon") { for (const [x, y] of s.points) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); } }
    else { minX = s.x - s.r; minY = s.y - s.r; maxX = s.x + s.r; maxY = s.y + s.r; }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, rot: 0, ...rectUV(0, 0, 1, 1), r: 1, g: 0.1, b: 0.1, a: 0.45 };
  });
  const debugBatch = new SpriteBatch(gpu.device, gpu.format, whiteTex.createView(), collisionSprites.length + 16);
  // Separate batch for particles — shares the white 1×1 texture but owns its own instance buffer
  // so writeBuffer calls don't clobber the collision debug buffer within the same submit.
  const particleBatch = new SpriteBatch(gpu.device, gpu.format, whiteTex.createView(), MAX_PARTICLES + 8);
  let showCollision = false; // press C to toggle
  addEventListener("keydown", (e) => { if (e.key.toLowerCase() === "c") showCollision = !showCollision; });
  const cam = new Camera2D();

  // start heading: direction of the track at the start (waypoint 0 → 1)
  function startHeading(): number {
    const wp = track.objects.Waypoints?.[0];
    if (wp?.points && wp.points.length >= 2) {
      const ax = wp.x + wp.points[0][0], ay = wp.y + wp.points[0][1];
      const bx = wp.x + wp.points[1][0], by = wp.y + wp.points[1][1];
      return Math.atan2(by - ay, bx - ax);
    }
    return 0;
  }

  // Authored start-tile grid (clean road, between the banks). Place racer i on the i-th start tile
  // (front to back); if there are more racers than tiles, stagger the rest back along the racing line.
  const startCells = findStartPositions(track).map((p) => ({ x: p.x, y: p.y + track.tileH / 2 }));
  function gridPose(i: number, angle: number): { x: number; y: number; angle: number } {
    let cx: number, cy: number;
    if (i < startCells.length) {
      cx = startCells[i].x; cy = startCells[i].y;
    } else {
      const base = startCells[startCells.length - 1] ?? findStart(track);
      const back = (i - startCells.length + 1) * 80;
      cx = base.x - Math.cos(angle) * back; cy = base.y - Math.sin(angle) * back;
    }
    return { x: cx * UNIT_FOR_PIXEL, y: cy * UNIT_FOR_PIXEL, angle };
  }

  // --- audio ---
  const audio = new AudioEngine();
  let audioInited = false;
  let music: ChiptunePlayer | null = null;

  function initAudio() {
    if (audioInited) return;
    audio.init();
    audioInited = true;
    // Share the AudioContext with the music player
    const ctx = audio.audioCtx;
    const master = audio.masterOutput;
    if (ctx && master) {
      music = new ChiptunePlayer(ctx, master);
    }
  }

  // Init (and re-resume) on any keydown — AudioContext requires a user gesture
  addEventListener("keydown", (e) => {
    initAudio();
    audio.resume();
    // M key — toggle music mute
    if (e.key.toLowerCase() === "m" && music) {
      const muted = music.toggleMute();
      muteBtn.textContent = muted ? "🔇" : "🔊";
      console.log(`[Music] ${muted ? "muted" : "unmuted"}`);
    }
  });

  const playerInput = new CombinedInput(); // one instance for the session (avoid per-respawn listener leak)
  let race: Race;
  function buildRace() {
    const angle = startHeading();
    const diffMult = selectedDifficulty === "easy" ? 0.72 : selectedDifficulty === "hard" ? 1.12 : 1.0;
    const racers: Racer[] = ROSTER.map((cfg, i) => {
      const def = vehiclesJson[cfg.defId];
      const pose = gridPose(i, angle);
      const vehicle = new Vehicle(world, def, pose.x, pose.y, pose.angle, GamePlay.maxDrivingForce, metaJson);
      vehicle.body.setUserData({ racer: i }); // tag for camera-shake contact listener
      // Apply difficulty scale to AI racers only
      if (!cfg.player) vehicle.speedScale = diffMult;
      const lap = new LapTracker(lapTable, selectedLaps);
      const racer: Racer = { name: cfg.name, vehicle, lap, isPlayer: !!cfg.player };
      if (cfg.player) racer.input = playerInput;
      return racer;
    });
    // AI pilots need a "leading every player?" predicate
    for (const r of racers) {
      if (!r.isPlayer) {
        r.ai = new AIPilot(world, r.vehicle, r.lap, waypoints, track,
          () => racers.filter((p) => p.isPlayer).every((p) => r.lap.raceDistance > p.lap.raceDistance));
      }
    }
    race = new Race(racers, track);
    // Initialize bonus manager from map BonusSpots (ellipses — center = x + w/2, y + h/2)
    const rawSpots = track.objects.BonusSpots ?? [];
    const bonusSpotDefs = rawSpots.map((s) => ({
      x: s.x + (s.width ?? 0) / 2,
      y: s.y + (s.height ?? 0) / 2,
    }));
    race.initBonusManager(bonusSpotDefs, world);
    const p = racers[0].vehicle.pixelPos;
    cam.cx = p.x; cam.cy = p.y;
  }
  buildRace();

  function tintFor(cfg: RacerConfig): Partial<Sprite> {
    return cfg.tint ? { r: cfg.tint[0], g: cfg.tint[1], b: cfg.tint[2] } : {};
  }

  function respawn() {
    for (const r of race.racers) { for (const w of r.vehicle.wheels) world.destroyBody(w.body); world.destroyBody(r.vehicle.body); }
    buildRace();
    // clear skid marks + reset notification state for fresh race
    const clearEnc = gpu.device.createCommandEncoder();
    skidMarks.clear(clearEnc);
    gpu.device.queue.submit([clearEnc.finish()]);
    particles.length = 0;
    lastPos = ROSTER.length; posFlashTimer = 0;
    prevLapCount = 1; lapFlashMsg = ""; lapFlashTimer = 0;
    lastCountdownLabel = "";
    countdownEl.style.opacity = "0";
    finishShown = false;
    finishOverlayEl.style.opacity = "0";
    finishOverlayEl.style.pointerEvents = "none";
    paused = false;
    pauseOverlay.style.display = "none";
    wrongWayTimer = 0;
    wrongWayEl.style.opacity = "0";
    prevRaceDistance = 0;
    lastLapTime = 0;
    prevBestLapForDelta = Infinity;
    lapDeltaColor = "#fff";
    lapDeltaEl.style.opacity = "0";
    prevSnap = currSnap = snapRacers();
    // stop music; it will restart when the new race transitions to running
    music?.stop();
    musicStarted = false;
  }

  // render-interpolation snapshots: prev = state before last physics step, curr = state after.
  // Lerping between them by stepper.alpha gives smooth motion at any fps above 60.
  interface BodySnap { x: number; y: number; angle: number; }
  interface RacerSnap { body: BodySnap; wheels: BodySnap[]; }
  function snapRacers(): RacerSnap[] {
    return race.racers.map((r) => ({
      body: { ...r.vehicle.pixelPos, angle: r.vehicle.angle },
      wheels: r.vehicle.wheels.map((wh) => {
        const p = wh.body.getPosition();
        return { x: p.x * PIXELS_PER_METER, y: p.y * PIXELS_PER_METER, angle: wh.body.getAngle() };
      }),
    }));
  }
  function lerpAngle(a: number, b: number, t: number): number {
    const d = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    return a + d * t;
  }
  let prevSnap: RacerSnap[] = snapRacers();
  let currSnap: RacerSnap[] = snapRacers();

  const stepper = new FixedStepper(
    world,
    (dt) => race.step(dt),
    () => { prevSnap = currSnap; currSnap = snapRacers(); },
  );

  createTuningPanel(respawn);
  addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "r") respawn();
    // T key — switch to the other track (reloads page with new track param, car is preserved)
    if (e.key.toLowerCase() === "t") {
      const nextTrackIdx = (selectedTrackIdx + 1) % TRACK_OPTIONS.length;
      switchTrack(nextTrackIdx, selectedCarIdx);
    }
    // Escape — toggle pause while race is running
    if (e.key === "Escape" && race.state === "running") {
      paused = !paused;
      pauseOverlay.style.display = paused ? "flex" : "none";
    }
    // Space / B — fire held bonus (only while running)
    if ((e.key === " " || e.key.toLowerCase() === "b") && race.state === "running") {
      e.preventDefault();
      race.firePlayerBonus();
    }
  });

  const player = () => race.racers[0];

  /** Convert world pixel coords → label-canvas device pixel coords using the current VP matrix. */
  function worldToScreen(wx: number, wy: number, vp: Float32Array, cw: number, ch: number): [number, number] {
    const nx = vp[0] * wx + vp[4] * wy + vp[12];
    const ny = vp[1] * wx + vp[5] * wy + vp[13];
    return [(nx + 1) / 2 * cw, (1 - ny) / 2 * ch];
  }

  function updateCamera(dt: number) {
    const W = canvas.width, H = canvas.height;
    const v = player().vehicle;
    const speed = v.speedKmh / 3.6;
    const t = Math.min(1, Math.max(0, speed / GamePlay.cameraMaxZoomSpeed));
    const gdxZoom = GamePlay.cameraMinZoom + (GamePlay.cameraMaxZoom - GamePlay.cameraMinZoom) * t;
    const viewWidthPx = GamePlay.cameraViewportWidth * PIXELS_PER_METER * gdxZoom;
    const viewHeightPx = viewWidthPx * (H / W);
    cam.zoom = W / viewWidthPx;
    const adv = Math.min(viewWidthPx, viewHeightPx) * GamePlay.cameraAdvancePercent;
    const a = v.angle, p = v.pixelPos;
    const k = 1 - Math.exp(-GamePlay.cameraSmooth * dt);
    cam.cx += (p.x + Math.cos(a) * adv - cam.cx) * k;
    cam.cy += (p.y + Math.sin(a) * adv - cam.cy) * k;
    // camera shake: oscillating offset that decays exponentially
    if (shakeAmt > 0.05) {
      shakePhaseX += dt * 38; shakePhaseY += dt * 41;
      cam.cx += Math.sin(shakePhaseX) * shakeAmt;
      cam.cy += Math.sin(shakePhaseY) * shakeAmt;
      shakeAmt *= Math.pow(0.02, dt); // ~50ms half-life
    } else {
      shakeAmt = 0;
    }
  }

  // --- position-change + lap-complete notifications ---
  let lastPos = ROSTER.length;
  let posFlashTimer = 0;
  let prevLapCount = 1;
  let lapFlashMsg = "";
  let lapFlashTimer = 0;
  // finish overlay + wrong-way state
  let finishShown = false;
  let wrongWayTimer = 0;
  let paused = false;
  // music playback state
  let musicStarted = false;
  let prevRaceDistance = 0;
  // lap delta timing
  let lastLapTime = 0;
  let prevBestLapForDelta = Infinity;
  let lapDeltaColor = "#fff";

  let last = performance.now();
  let frames = 0, fpsTime = 0, fps = 0;

  function frame(now: number) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (paused) { requestAnimationFrame(frame); return; }
    stepper.advance(dt);
    const alpha = stepper.alpha;

    // --- VFX particle system step + disruption/smoke trigger ---
    vfx.step(dt);
    if (race.state === "running") {
      // Compute VP early so we can convert world→screen for particle spawn positions.
      // (The full render VP is recomputed below after resizeToDisplay; use canvas dims as-is
      // for the particle spawn since a 1-frame offset is imperceptible.)
      const vpEarly = cam.viewProj(canvas.width, canvas.height);
      const lw = labelsCanvas.width, lh = labelsCanvas.height;
      for (let i = 0; i < race.racers.length; i++) {
        const r = race.racers[i];
        const wasDisrupted = prevDisrupted.has(i);
        const nowDisrupted = r.vehicle.isDisrupted;
        // Onset transition → explosion burst
        if (!wasDisrupted && nowDisrupted) {
          const snap = currSnap[i]?.body;
          const wx = snap?.x ?? r.vehicle.pixelPos.x;
          const wy = snap?.y ?? r.vehicle.pixelPos.y;
          const [sx, sy] = worldToScreen(wx, wy, vpEarly, lw, lh);
          vfx.explosion(sx / devicePixelRatio, sy / devicePixelRatio);
        }
        // Continuous smoke while disrupted
        if (nowDisrupted) {
          const snap = currSnap[i]?.body;
          const wx = snap?.x ?? r.vehicle.pixelPos.x;
          const wy = snap?.y ?? r.vehicle.pixelPos.y;
          const [sx, sy] = worldToScreen(wx, wy, vpEarly, lw, lh);
          vfx.smoke(sx / devicePixelRatio, sy / devicePixelRatio);
          prevDisrupted.add(i);
        } else {
          prevDisrupted.delete(i);
        }

        // Turbo flame: emit while any racer is boosting on a TURBO tile
        if (r.vehicle.isBoosting) {
          const snap = currSnap[i]?.body;
          const wx = snap?.x ?? r.vehicle.pixelPos.x;
          const wy = snap?.y ?? r.vehicle.pixelPos.y;
          const [sx, sy] = worldToScreen(wx, wy, vpEarly, lw, lh);
          const angle = currSnap[i]?.body.angle ?? r.vehicle.body.getAngle();
          vfx.turboFlame(sx / devicePixelRatio, sy / devicePixelRatio, angle);
        }
      }

      // Wheel dust: only for the player, when drifting on a non-road surface
      {
        const pVeh = player().vehicle;
        const pVel = pVeh.body.getLinearVelocity();
        const pAngle = pVeh.body.getAngle();
        const pSpeed = Math.sqrt(pVel.x ** 2 + pVel.y ** 2);
        const pFwdX = Math.cos(pAngle), pFwdY = Math.sin(pAngle);
        const pFwdSpeed = pVel.x * pFwdX + pVel.y * pFwdY;
        const pLateralSpeed = Math.sqrt(Math.max(0, pSpeed ** 2 - pFwdSpeed ** 2));
        if (pVeh.groundMaterial !== "ROAD" && pLateralSpeed > 1.5) {
          const snap = currSnap[0]?.body;
          const wx = snap?.x ?? pVeh.pixelPos.x;
          const wy = snap?.y ?? pVeh.pixelPos.y;
          const [sx, sy] = worldToScreen(wx, wy, vpEarly, lw, lh);
          vfx.wheelDust(sx / devicePixelRatio, sy / devicePixelRatio, pVeh.groundMaterial);
        }
      }
    }

    updateCamera(dt);

    // update audio each frame (engine pitch + squeal gate)
    audio.update(player().vehicle.speedKmh, player().vehicle.isDrifting);

    // engine loop SFX: start when race goes running, update each frame, stop on finish
    if (race.state === "running" || race.state === "finished") {
      audio.updateEngine(player().vehicle.speedKmh);
    }

    // tire screech: compute lateral slide velocity and drive setScreech each frame
    if (race.state === "running") {
      const pVeh = player().vehicle;
      const vel = pVeh.body.getLinearVelocity();
      const angle = pVeh.body.getAngle();
      const speed = Math.sqrt(vel.x ** 2 + vel.y ** 2);
      const fwdX = Math.cos(angle), fwdY = Math.sin(angle);
      const fwdSpeed = vel.x * fwdX + vel.y * fwdY;
      const lateralSpeed = Math.sqrt(Math.max(0, speed ** 2 - fwdSpeed ** 2));
      const screechIntensity = Math.min(1, Math.max(0, (lateralSpeed - 1.5) / 4));
      audio.setScreech(screechIntensity);
    } else {
      audio.setScreech(0);
    }

    // music: start on countdown begin, stop when race finishes
    if (!musicStarted && race.state === "countdown" && music) {
      musicStarted = true;
      music.start();
    }
    if (race.state === "finished" && musicStarted && music) {
      musicStarted = false;
      music.stop();
      audio.stopEngine();
    }

    // position-change + lap-complete notifications
    if (race.state === "running") {
      const curPos = race.positionOf(player());
      if (curPos !== lastPos) {
        posFlashTimer = 2.5;
        lastPos = curPos;
      }
      if (posFlashTimer > 0) posFlashTimer -= dt;

      const curLap = player().lap.displayLap;
      const curLapTime = player().lap.lapTime;
      if (curLap > prevLapCount) {
        const justFinished = lastLapTime; // saved from previous frame — the completed lap's duration
        const newBest = player().lap.bestLapTime;
        let deltaStr: string;
        if (prevBestLapForDelta === Infinity) {
          deltaStr = justFinished.toFixed(2) + "s";
          lapDeltaColor = "#ccc";
        } else {
          const delta = justFinished - prevBestLapForDelta;
          if (delta < -0.005) {
            deltaStr = `NEW BEST  ${newBest.toFixed(2)}s`;
            lapDeltaColor = "#4f4";
          } else {
            deltaStr = `+${delta.toFixed(2)}s`;
            lapDeltaColor = "#f66";
          }
        }
        prevBestLapForDelta = newBest;
        lapFlashMsg = `LAP ${curLap}!  ${deltaStr}`;
        lapFlashTimer = 3;
        prevLapCount = curLap;
      }
      lastLapTime = curLapTime;
      if (lapFlashTimer > 0) lapFlashTimer -= dt; else lapFlashMsg = "";

      // wrong-way detector: raceDistance should strictly increase while going forward
      const curDist = player().lap.raceDistance;
      const goingBack = curDist < prevRaceDistance - 0.08;
      wrongWayTimer = goingBack ? wrongWayTimer + dt : Math.max(0, wrongWayTimer - dt * 3);
      prevRaceDistance = curDist;
      wrongWayEl.style.opacity = wrongWayTimer > 0.6 ? "1" : "0";
    }

    resizeToDisplay(canvas);
    const W = canvas.width, H = canvas.height;
    const vp = cam.viewProj(W, H);

    // speed lines: radiate from the car's screen position
    {
    }

    // --- ambient snowfall: spawn flakes at top of camera view each frame ---
    {
      const viewW = canvas.width / cam.zoom;
      const viewH = canvas.height / cam.zoom;
      const spawnCount = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < spawnCount && particles.length < MAX_PARTICLES; i++) {
        const sx = cam.cx + (Math.random() - 0.5) * viewW * 1.1;
        const sy = cam.cy - viewH * 0.55; // just above top of view
        const life = 2.5 + Math.random() * 1.5;
        particles.push({ x: sx, y: sy, vx: (Math.random() - 0.5) * 8, vy: 18 + Math.random() * 12, life, maxLife: life });
      }
    }

    // --- collect skid patches and spawn snow particles ---
    race.racers.forEach((r) => {
      if (race.state !== "running" || r.lap.finished) return;
      if (!r.vehicle.isDrifting) return;
      for (const wh of r.vehicle.wheels) {
        if (!wh.drifting) continue;
        const wp = wh.body.getPosition();
        const px = wp.x * PIXELS_PER_METER, py = wp.y * PIXELS_PER_METER;
        skidMarks.addPatch(px, py, wh.body.getAngle());
        // spawn snow spray particles (only for a few wheels to keep count low)
        if (particles.length < MAX_PARTICLES && Math.random() < 0.5) {
          const vb = wh.body.getLinearVelocity();
          const spd = Math.hypot(vb.x, vb.y);
          const angle = Math.atan2(vb.y, vb.x) + (Math.random() - 0.5) * 1.8;
          const speed = spd * PIXELS_PER_METER * (0.2 + Math.random() * 0.4);
          const life = 0.25 + Math.random() * 0.2;
          particles.push({ x: px, y: py, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life, maxLife: life });
        }
      }
    });

    // update particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.88; p.vy *= 0.88; // drag
      p.life -= dt;
      if (p.life <= 0) particles.splice(i, 1);
    }
    const particleSprites: Sprite[] = particles.map((p) => {
      const t = p.life / p.maxLife;
      const isSmoke = p.cr !== undefined;
      const isAmbient = !isSmoke && p.maxLife > 2;
      const sz = isSmoke ? 5 + t * 16 : isAmbient ? 1.5 + t * 0.5 : 3 + t * 4;
      const alpha = isSmoke ? t * t * 0.6 : isAmbient ? t * 0.45 : t * 0.7;
      return { x: p.x, y: p.y, w: sz, h: sz, rot: 0, ...rectUV(0, 0, 1, 1),
        r: p.cr ?? 1, g: p.cg ?? 1, b: p.cb ?? 1, a: alpha };
    });

    // group car sprites by texture; collect wheels
    const carsByDef: Record<string, Sprite[]> = {};
    for (const id of defIds) carsByDef[id] = [];
    const wheelSprites: Sprite[] = [];
    race.racers.forEach((r, i) => {
      const cfg = ROSTER[i];
      const tex = carTex[cfg.defId];
      const prev = prevSnap[i], curr = currSnap[i];
      const ix = prev.body.x + (curr.body.x - prev.body.x) * alpha;
      const iy = prev.body.y + (curr.body.y - prev.body.y) * alpha;
      const ia = lerpAngle(prev.body.angle, curr.body.angle, alpha);
      // base tint from roster, then disruption flash (orange/red pulse)
      const baseTint = tintFor(cfg);
      let tintR = baseTint.r ?? 1, tintG = baseTint.g ?? 1, tintB = baseTint.b ?? 1;
      let tintA = 1;
      if (r.vehicle.isDisrupted) {
        const flash = Math.sin(r.vehicle.disruptedTimer * 40) > 0;
        if (flash) { tintR = 1.0; tintG = 0.25; tintB = 0.1; }
      } else if (r.vehicle.isRescuing) {
        // Fade out + blue tint as rescue teleport progresses
        const progress = r.vehicle.rescueTimer / r.vehicle.RESCUE_DURATION;
        tintA = 0.3 + 0.7 * progress; // fades out toward 0.3 at rescue completion
        tintR = 0.7; tintG = 0.8; tintB = 1.0;
      }
      carsByDef[cfg.defId].push({ x: ix, y: iy, w: tex.width, h: tex.height, rot: ia, ...rectUV(0, 0, 1, 1), r: tintR, g: tintG, b: tintB, a: tintA });
      if (tireTex) {
        for (let wi = 0; wi < r.vehicle.wheels.length; wi++) {
          const pw = prev.wheels[wi], cw = curr.wheels[wi];
          const wx = pw.x + (cw.x - pw.x) * alpha;
          const wy = pw.y + (cw.y - pw.y) * alpha;
          const wa = lerpAngle(pw.angle, cw.angle, alpha);
          wheelSprites.push({ x: wx, y: wy, w: tireTex.width, h: tireTex.height, rot: wa, ...rectUV(0, 0, 1, 1) });
        }
      }
    });

    const encoder = gpu.device.createCommandEncoder();
    // skid marks pass: accumulate dark patches into the persistent RTT texture
    skidMarks.flush(gpu.device, encoder);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: gpu.context.getCurrentTexture().createView(),
        clearValue: { r: 0.1, g: 0.1, b: 0.12, a: 1 },
        loadOp: "clear", storeOp: "store",
      }],
    });
    // draw order: tiles → skid marks → wheels → cars → particles → debug
    tileBatch.setCamera(vp); tileBatch.draw(pass, tileSprites);
    skidBatch.setCamera(vp); skidBatch.draw(pass, [skidSprite]);
    if (tireBatch) { tireBatch.setCamera(vp); tireBatch.draw(pass, wheelSprites); }
    for (const id of defIds) { carBatch[id].setCamera(vp); carBatch[id].draw(pass, carsByDef[id]); }
    if (particleSprites.length) { particleBatch.setCamera(vp); particleBatch.draw(pass, particleSprites); }
    if (showCollision) { debugBatch.setCamera(vp); debugBatch.draw(pass, collisionSprites); }
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);

    frames++; fpsTime += dt;
    if (fpsTime >= 0.5) { fps = Math.round(frames / fpsTime); frames = 0; fpsTime = 0; }
    hud.innerHTML = buildHud(fps);

    // lap-delta overlay — colored pill: green=new best, red=slower, gray=first lap
    if (lapFlashMsg && lapFlashTimer > 0) {
      lapDeltaEl.textContent = lapFlashMsg;
      lapDeltaEl.style.color = lapDeltaColor;
      lapDeltaEl.style.textShadow = `0 0 10px ${lapDeltaColor}`;
      lapDeltaEl.style.opacity = lapFlashTimer > 0.5 ? "1" : (lapFlashTimer / 0.5).toFixed(2);
    } else {
      lapDeltaEl.style.opacity = "0";
    }

    // centered countdown / GO! overlay
    {
      let label = "";
      let color = "#fff";
      let size = "10rem";
      if (race.state === "countdown") {
        const n = Math.ceil(race.countdown);
        label = String(n);
        color = n === 1 ? "#f55" : n === 2 ? "#fa0" : "#8cf";
      } else if (race.goTimer > 0) {
        label = "GO!";
        color = "#4f4";
        size = "13rem";
      }
      if (label !== lastCountdownLabel) {
        lastCountdownLabel = label;
        if (label) {
          countdownEl.style.fontSize = size;
          countdownEl.style.color = color;
          countdownEl.style.opacity = "1";
          countdownEl.textContent = label;
          // countdown beeps
          if (label === "GO!") {
            audio.beep(1.5);
            audio.startEngine();
          } else {
            audio.beep(1.0);
          }
          if (label === "GO!") {
            countdownEl.style.transition = "";
            countdownEl.style.transform = "scale(1.35)";
            requestAnimationFrame(() => {
              countdownEl.style.transition = "transform 0.3s ease-out";
              countdownEl.style.transform = "scale(1)";
            });
          } else {
            countdownEl.style.transition = "";
            countdownEl.style.transform = "";
          }
        } else {
          countdownEl.style.opacity = "0";
          countdownEl.style.transition = "";
          countdownEl.style.transform = "";
        }
      }
    }
    minimap.update(race.racers.map((r) => ({ ...r.vehicle.pixelPos, angle: r.vehicle.angle, isPlayer: r.isPlayer, finished: r.lap.finished, position: race.positionOf(r) })));

    // --- floating position labels above cars ---
    {
      const lw = labelsCanvas.width, lh = labelsCanvas.height;
      labelsCtx.clearRect(0, 0, lw, lh);
      // Draw Canvas2D particle effects (explosions/smoke) on the same overlay, below the text labels
      vfx.draw(labelsCtx, devicePixelRatio);
      const dpr = devicePixelRatio;
      for (let ri = 0; ri < race.racers.length; ri++) {
        const r = race.racers[ri];
        const pos = race.positionOf(r);
        const psnap = prevSnap[ri].body, csnap = currSnap[ri].body;
        const px = psnap.x + (csnap.x - psnap.x) * alpha;
        const py = psnap.y + (csnap.y - psnap.y) * alpha;
        // project world px → label-canvas device px via shared helper
        const [sx, sy] = worldToScreen(px, py, vp, lw, lh);
        const fontSize = 11 * dpr;
        labelsCtx.font = `bold ${fontSize}px monospace`;
        const label = `P${pos}`;
        const tw = labelsCtx.measureText(label).width;
        const padX = 5 * dpr, padY = 2 * dpr;
        const bw = tw + padX * 2, bh = fontSize + padY * 2;
        const bx = sx - bw / 2, by = sy - 30 * dpr - bh;
        // skip the position pill for the player — HUD already shows player position
        if (!r.isPlayer) {
          labelsCtx.fillStyle = "rgba(14,22,42,0.85)";
          labelsCtx.beginPath();
          labelsCtx.roundRect(bx, by, bw, bh, 4 * dpr);
          labelsCtx.fill();
          labelsCtx.fillStyle = "#ddd";
          labelsCtx.textAlign = "left";
          labelsCtx.textBaseline = "top";
          labelsCtx.fillText(label, bx + padX, by + padY);
          // name tag below the pill for AI cars
          labelsCtx.font = `${Math.round(10 * dpr)}px monospace`;
          labelsCtx.fillStyle = "rgba(180,195,225,0.6)";
          labelsCtx.textAlign = "center";
          labelsCtx.textBaseline = "top";
          labelsCtx.fillText(ROSTER[ri]?.name ?? "", sx, by + bh + 2 * dpr);
        }
      }
    }

    // --- finish-screen overlay (fades in once when race ends) ---
    if (race.state === "finished" && !finishShown) {
      finishShown = true;
      const order = race.standings();
      const playerFinishPos = order.findIndex((r) => r.isPlayer) + 1;
      const playerWon = playerFinishPos === 1;
      const medals = ["1st", "2nd", "3rd", "4th"];
      const medalColors = ["#FFD700", "#C0C0C0", "#CD7F32", "#888"];
      const placeLabel = ["", "2nd place", "3rd place", "4th place"][playerFinishPos - 1] ?? "";

      function fmtTime(s: number): string {
        const m = Math.floor(s / 60);
        const sec = (s % 60).toFixed(2).padStart(5, "0");
        return `${m}:${sec}`;
      }

      const headline = playerWon
        ? `<div style="font-size:3.4rem;color:#FFD700;text-shadow:0 0 32px #fa0,0 0 8px #fff;margin-bottom:.5rem;letter-spacing:.12em">YOU WIN!</div>`
        : `<div style="font-size:3.2rem;color:#4f4;text-shadow:0 0 28px #2d2;margin-bottom:.3rem;letter-spacing:.1em">FINISHED!</div>
           <div style="font-size:1.1rem;color:#aaa;margin-bottom:1rem;letter-spacing:.06em">${placeLabel}</div>`;

      finishOverlayEl.innerHTML = `
        <div style="font-size:.75rem;letter-spacing:.35em;color:#666;margin-bottom:.5rem">RACE COMPLETE</div>
        ${headline}
        <div style="display:flex;flex-direction:column;gap:.6rem;min-width:320px;margin-top:.4rem">
          ${order.map((r, i) => {
            const isWinner = i === 0;
            const bestLap = r.lap.bestLapTime;
            const bestStr = bestLap < Infinity ? fmtTime(bestLap) : "—";
            return `
            <div style="display:flex;align-items:center;gap:1rem;padding:.6rem 1.2rem;
              background:rgba(255,255,255,${isWinner ? "0.16" : r.isPlayer ? "0.13" : "0.06"});
              border-radius:8px;border-left:3px solid ${medalColors[i]};
              ${isWinner ? `box-shadow:0 0 12px rgba(255,215,0,0.18);` : ""}">
              <span style="color:${medalColors[i]};font-size:${isWinner ? "1.15rem" : "1rem"};font-weight:${isWinner ? "900" : "bold"};min-width:2.8rem">${medals[i]}</span>
              <span style="color:${isWinner ? "#FFD700" : r.isPlayer ? "#FFD700" : "#ccc"};font-size:${isWinner ? "1.15rem" : "1rem"};font-weight:${isWinner ? "900" : "normal"};flex:1;text-shadow:${isWinner ? "0 0 12px rgba(255,215,0,0.5)" : "none"}">${r.name}</span>
              <span style="color:#888;font-size:.8rem;min-width:4rem;text-align:right" title="best lap">${bestStr}</span>
              <span style="color:#999;font-size:.95rem;min-width:4rem;text-align:right">${r.lap.totalTime.toFixed(1)}s</span>
            </div>`;
          }).join("")}
        </div>
        <div style="font-size:.65rem;color:#444;letter-spacing:.08em;margin-top:.5rem;text-align:right;min-width:320px;padding-right:.2rem">best lap · total time</div>
      `;

      // action buttons styled to match pause overlay
      const btnCss = [
        "font-family:monospace", "font-size:1.05rem", "font-weight:bold",
        "letter-spacing:.15em", "cursor:pointer",
        "padding:.65rem 2.2rem", "margin:.35rem",
        "border-radius:8px", "border:2px solid #FFD700",
        "background:rgba(255,215,0,0.1)", "color:#FFD700",
      ].join(";");

      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;flex-wrap:wrap;justify-content:center;margin-top:1.4rem;";

      const raceAgainBtn = document.createElement("button");
      raceAgainBtn.textContent = "▶  RACE AGAIN";
      raceAgainBtn.style.cssText = btnCss;
      raceAgainBtn.addEventListener("click", () => respawn());

      const menuBtn = document.createElement("button");
      menuBtn.textContent = "⌂  MENU";
      menuBtn.style.cssText = btnCss;
      menuBtn.addEventListener("click", () => { location.href = location.pathname; });

      btnRow.appendChild(raceAgainBtn);
      btnRow.appendChild(menuBtn);
      finishOverlayEl.appendChild(btnRow);

      finishOverlayEl.style.opacity = "1";
      finishOverlayEl.style.pointerEvents = "auto";
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function buildHud(fps: number): string {
    const pl = player();
    const trackOpt = TRACK_OPTIONS[selectedTrackIdx];
    const trackLabel = `${trackOpt.emoji} ${trackOpt.label}`;

    if (race.state === "finished") {
      const order = race.standings();
      const lines = order.map((r, i) => `  ${i + 1}. ${r.name}${r.isPlayer ? " (you)" : ""}  ${r.lap.totalTime.toFixed(1)}s`);
      return `FINISHED — final standings:\n${lines.join("\n")}\n\nR to race again`;
    }
    const pos = race.positionOf(pl);
    const lap = `${pl.lap.displayLap}/${pl.lap.totalLaps}`;
    const speed = pl.vehicle.speedKmh.toFixed(0);
    const best = pl.lap.bestLapTime === Infinity ? "" : `  best ${pl.lap.bestLapTime.toFixed(2)}s`;
    const fpsStr = showCollision ? `${fps}fps  ` : "";
    const turboStr = pl.vehicle.isBoosting
      ? `<span style="color:#FFD700;font-weight:900;font-size:1.1rem;"> ⚡ TURBO</span>`
      : "";
    // held bonus indicator
    const heldBonus = race.bonusManager?.heldBonus(0) ?? null;
    const BONUS_ICON: Record<string, string> = { TURBO: "⚡", GUN: "🔫", MINE: "💣" };
    const bonusStr = heldBonus
      ? ` <span style="color:#0f0;font-weight:bold"> [${BONUS_ICON[heldBonus] ?? heldBonus} SPACE]</span>`
      : "";
    return (
      `<span style="font-size:1.4rem;color:#FFD700;font-weight:900">P${pos}</span>` +
      `  Lap ${lap}  ${speed} km/h${best}${turboStr}${bonusStr}<br>` +
      `<span style="font-size:0.7rem;color:#666">${fpsStr}${trackLabel}</span>`
    );
  }

  (window as unknown as { __pw: unknown }).__pw = {
    get state() { return race.state; },
    get pos() { return player().vehicle.pixelPos; },
    get speed() { return player().vehicle.speedKmh; },
    get playerPos() { return race.positionOf(player()); },
    get standings() { return race.standings().map((r) => ({ name: r.name, dist: +r.lap.raceDistance.toFixed(2), lap: r.lap.displayLap, finished: r.lap.finished })); },
    get racers() { return race.racers; },
    get trackName() { return trackName; },
    forceStart() { race.state = "running"; race.countdown = 0; },
    selectTrack(name: TrackName) { switchTrack(TRACK_OPTIONS.findIndex((t) => t.name === name), selectedCarIdx); },
    cam, track, GamePlay, respawn, lapTable, waypoints,
  };
}

main().catch(fatal);
