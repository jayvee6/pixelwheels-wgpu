// Minimap overlay — Canvas2D element over the WebGPU canvas.
// Draws the racing line (waypoints) as a thick closed stroke for the track shape,
// then racer dots (gold = player, red = AI) each frame.

const MM_SIZE = 140;    // CSS pixels
const MM_MARGIN = 10;   // from top-right corner
const ROAD_STROKE = 18; // minimap pixels representing ~road width

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale: number;
  private ox: number;
  private oy: number;
  private bgBitmap: ImageBitmap | null = null;
  private dpr: number;

  constructor(
    container: HTMLElement,
    trackW: number,
    trackH: number,
    waypoints: Array<{ x: number; y: number }>,
  ) {
    this.dpr = devicePixelRatio || 1;
    const px = Math.round(MM_SIZE * this.dpr);

    this.canvas = document.createElement("canvas");
    this.canvas.width = px;
    this.canvas.height = px;
    this.canvas.style.cssText = [
      "position:fixed",
      `bottom:${MM_MARGIN}px`,
      `left:${MM_MARGIN}px`,
      `width:${MM_SIZE}px`,
      `height:${MM_SIZE}px`,
      "border-radius:8px",
      "background:rgba(8,10,16,0.72)",
      "pointer-events:none",
      "z-index:10",
    ].join(";");
    container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext("2d")!;

    // Fit the track into the canvas with padding
    const pad = ROAD_STROKE * this.dpr;
    const scaleX = (px - pad * 2) / trackW;
    const scaleY = (px - pad * 2) / trackH;
    this.scale = Math.min(scaleX, scaleY);
    this.ox = (px - trackW * this.scale) / 2;
    this.oy = (px - trackH * this.scale) / 2;

    this._buildBg(waypoints, px);
  }

  private async _buildBg(waypoints: Array<{ x: number; y: number }>, px: number) {
    const off = new OffscreenCanvas(px, px);
    const ctx = off.getContext("2d")!;

    if (waypoints.length < 2) return;

    // Draw track corridor as closed thick polyline
    ctx.strokeStyle = "rgba(100,115,140,0.85)";
    ctx.lineWidth = ROAD_STROKE * this.dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = 0; i < waypoints.length; i++) {
      const [x, y] = this._mm(waypoints[i].x, waypoints[i].y);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    // Thin center line for the racing line
    ctx.strokeStyle = "rgba(180,200,230,0.4)";
    ctx.lineWidth = 1.5 * this.dpr;
    ctx.beginPath();
    for (let i = 0; i < waypoints.length; i++) {
      const [x, y] = this._mm(waypoints[i].x, waypoints[i].y);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();

    this.bgBitmap = await createImageBitmap(off);
  }

  private _mm(wx: number, wy: number): [number, number] {
    return [this.ox + wx * this.scale, this.oy + wy * this.scale];
  }

  update(racers: Array<{ x: number; y: number; angle: number; isPlayer: boolean; finished: boolean; position: number }>) {
    const ctx = this.ctx;
    const px = this.canvas.width;
    ctx.clearRect(0, 0, px, px);
    if (this.bgBitmap) ctx.drawImage(this.bgBitmap, 0, 0);

    for (const r of racers) {
      const [mx, my] = this._mm(r.x, r.y);
      const radius = (r.isPlayer ? 5 : 3.5) * this.dpr;
      const color = r.finished ? "#888" : r.isPlayer ? "#FFD700" : "#FF5555";

      // direction arrow: small triangle pointing in vehicle heading
      const arrowLen = (r.isPlayer ? 8 : 6) * this.dpr;
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(r.angle + Math.PI / 2); // +90 because y-down
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, -arrowLen * 0.6);
      ctx.lineTo(-arrowLen * 0.35, arrowLen * 0.4);
      ctx.lineTo(arrowLen * 0.35, arrowLen * 0.4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // dot center
      ctx.beginPath();
      ctx.arc(mx, my, radius * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();

      // position label
      ctx.font = `bold ${Math.round(6.5 * this.dpr)}px monospace`;
      ctx.fillStyle = r.isPlayer ? "#FFF" : "rgba(255,255,255,0.7)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`P${r.position}`, mx, my + arrowLen * 0.85);
    }
  }

  destroy() {
    this.canvas.remove();
    this.bgBitmap?.close();
  }
}
