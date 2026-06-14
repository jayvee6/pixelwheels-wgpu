// 2D world camera. World space is pixels, Y-down, origin top-left (matching the Tiled map).
// Produces a column-major mat4 mapping world px -> clip space, honoring center / zoom / rotation.
// rotation is the camera's own rotation in radians (heading-up follow cams pass the car's angle).
export class Camera2D {
  cx = 0;
  cy = 0;
  zoom = 1;       // screen px per world px
  rotation = 0;   // radians

  /** @param viewW @param viewH viewport size in device pixels (canvas.width/height). */
  viewProj(viewW: number, viewH: number): Float32Array<ArrayBuffer> {
    const c = Math.cos(-this.rotation);
    const s = Math.sin(-this.rotation);
    const kx = (2 * this.zoom) / viewW;
    const ky = (-2 * this.zoom) / viewH; // flip Y: world down -> clip up

    const a = kx * c, b = -kx * s;
    const d = ky * s, f = ky * c;
    const e = -(a * this.cx + b * this.cy);
    const g = -(d * this.cx + f * this.cy);

    // column-major
    return new Float32Array([
      a, d, 0, 0,
      b, f, 0, 0,
      0, 0, 1, 0,
      e, g, 0, 1,
    ]);
  }
}
