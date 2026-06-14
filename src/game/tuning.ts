// Live tuning panel for handling feel (per project preference: tune with sliders, bake defaults after).
// Mutates the shared GamePlay object; vehicle.ts reads it each fixed step so most changes apply live.
// Density / CoG need a respawn (handled by the onRespawn callback).
import { GamePlay } from "./constants.ts";

interface SliderSpec { key: keyof typeof GamePlay; min: number; max: number; step: number; label: string; respawn?: boolean }

const SPECS: SliderSpec[] = [
  { key: "maxDrivingForce", min: 0, max: 120, step: 1, label: "drive force" },
  { key: "maxLateralImpulse", min: 0, max: 10, step: 0.1, label: "lateral grip" },
  { key: "brakingLateralFactor", min: 0.05, max: 1, step: 0.05, label: "brake grip ÷" },
  { key: "driftImpulseReduction", min: 0, max: 2, step: 0.05, label: "drift slip" },
  { key: "stoppedMaxSteer", min: 10, max: 120, step: 1, label: "steer @stop" },
  { key: "lowSpeedMaxSteer", min: 1, max: 40, step: 1, label: "steer @low" },
  { key: "highSpeedMaxSteer", min: 1, max: 20, step: 1, label: "steer @high" },
  { key: "steerStep", min: 0.01, max: 0.3, step: 0.01, label: "steer ramp" },
  { key: "vehicleDensity", min: 0.05, max: 2, step: 0.05, label: "body density", respawn: true },
  { key: "tireBaseDensity", min: 1, max: 40, step: 1, label: "tire density", respawn: true },
  { key: "groundDragFactor", min: 0, max: 20, step: 0.5, label: "ground drag" },
  { key: "cameraMinZoom", min: 0.2, max: 2, step: 0.05, label: "cam zoom min" },
  { key: "cameraMaxZoom", min: 0.5, max: 4, step: 0.05, label: "cam zoom max" },
  { key: "cameraSmooth", min: 1, max: 30, step: 1, label: "cam smooth" },
];

export function createTuningPanel(onRespawn: () => void) {
  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;top:12px;right:12px;width:240px;max-height:90vh;overflow:auto;" +
    "background:rgba(20,20,28,0.85);color:#ddd;font:11px/1.4 ui-monospace,monospace;" +
    "padding:10px;border-radius:8px;z-index:10;backdrop-filter:blur(4px);";
  const title = document.createElement("div");
  title.textContent = "tuning (H to hide)";
  title.style.cssText = "font-weight:bold;margin-bottom:8px;color:#fff;";
  panel.appendChild(title);

  for (const spec of SPECS) {
    const row = document.createElement("label");
    row.style.cssText = "display:block;margin:6px 0;";
    const val = document.createElement("span");
    const setLabel = () => { val.textContent = ` ${spec.label}: ${GamePlay[spec.key].toFixed(2)}`; };
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min); input.max = String(spec.max); input.step = String(spec.step);
    input.value = String(GamePlay[spec.key]);
    input.style.cssText = "width:100%;";
    input.addEventListener("input", () => {
      GamePlay[spec.key] = Number(input.value);
      setLabel();
      if (spec.respawn) onRespawn();
    });
    setLabel();
    row.appendChild(val);
    row.appendChild(input);
    panel.appendChild(row);
  }

  const btn = document.createElement("button");
  btn.textContent = "Respawn car (R)";
  btn.style.cssText = "width:100%;margin-top:8px;padding:4px;cursor:pointer;";
  btn.addEventListener("click", onRespawn);
  panel.appendChild(btn);

  document.body.appendChild(panel);
  addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "h") panel.style.display = panel.style.display === "none" ? "block" : "none";
  });
  return panel;
}
