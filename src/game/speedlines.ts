// Speed-line overlay — Canvas2D fullscreen element drawn over WebGPU canvas.
// At speeds above 60 km/h, radial lines sweep outward from screen center.
// Intensity scales with speed: more lines, longer reach, higher opacity at 120+ km/h.

export class SpeedLines {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private elapsed = 0;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = [
      "position:fixed",
      "inset:0",
      "width:100%",
      "height:100%",
      "pointer-events:none",
      "z-index:5",
    ].join(";");
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
    this._resize();
    window.addEventListener("resize", () => this._resize());
  }

  private _resize() {
    this.canvas.width = Math.round(window.innerWidth * devicePixelRatio);
    this.canvas.height = Math.round(window.innerHeight * devicePixelRatio);
  }

  update(dt: number, speedKmh: number, carSx?: number, carSy?: number) {
    this.elapsed += dt;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    // Start fading in at 60 km/h, full effect by 120 km/h
    const t = Math.max(0, Math.min(1, (speedKmh - 60) / 60));
    if (t <= 0.01) return;

    const cx = carSx ?? w / 2;
    const cy = carSy ?? h / 2;
    const diag = Math.hypot(cx, cy);
    const count = Math.round(8 + t * 18);

    ctx.save();
    ctx.strokeStyle = `rgba(210,225,255,${(t * 0.2).toFixed(3)})`;
    ctx.lineWidth = 1.2 * devicePixelRatio;

    for (let i = 0; i < count; i++) {
      const baseAngle = (i / count) * Math.PI * 2;
      // slow oscillation per line so lines breathe slightly at high speed
      const jitter = Math.sin(this.elapsed * 3.5 + i * 1.9) * 0.04 * t;
      const angle = baseAngle + jitter;
      const r0 = diag * (0.08 + t * 0.06);
      const r1 = diag * (0.55 + t * 0.45);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * r0, cy + Math.sin(angle) * r0);
      ctx.lineTo(cx + Math.cos(angle) * r1, cy + Math.sin(angle) * r1);
      ctx.stroke();
    }

    ctx.restore();
  }

  destroy() {
    this.canvas.remove();
  }
}
