// Persistent skid-mark accumulation via a track-sized RTT texture.
// Each frame any wheel is drifting, small dark patches are rendered into this texture
// with loadOp:"load" so marks accumulate indefinitely. The texture is composited as a
// full-track sprite between the tile layer and the car layer in the main pass.
//
// Coordinate mapping: track-pixel space → NDC for the skid texture (y flipped, pixel y-down).

const SKID_SHADER = /* wgsl */ `
struct TrackSize { wh: vec2f, _pad: vec2f }
struct Patch { pos: vec2f, angle: f32, _pad: f32 }

@group(0) @binding(0) var<uniform> track: TrackSize;
@group(0) @binding(1) var<storage, read> patches: array<Patch>;

const CORNERS = array<vec2f, 6>(
  vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
  vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5),
);
const PW = 3.5;  // skid patch width (track-pixels)
const PH = 8.0;  // skid patch height / contact-patch length

@vertex fn vs(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) ii: u32,
) -> @builtin(position) vec4f {
  let p = patches[ii];
  let corner = CORNERS[vi] * vec2f(PW, PH);
  let c = cos(p.angle); let s = sin(p.angle);
  // rotate in y-down pixel space
  let rot = vec2f(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
  let px = p.pos + rot;
  // pixel → NDC; flip y because track pixels are y-down but NDC is y-up
  let ndc = px / track.wh * 2.0 - vec2f(1.0);
  return vec4f(ndc.x, -ndc.y, 0.0, 1.0);
}

@fragment fn fs() -> @location(0) vec4f {
  // dark blue-gray snow-compressed tire mark; straight (non-premultiplied) alpha
  return vec4f(0.03, 0.04, 0.06, 0.38);
}
`;

const MAX_PATCHES_PER_FRAME = 512;
const FLOATS_PER_PATCH = 4; // pos.x, pos.y, angle, _pad

export class SkidMarks {
  private pipeline: GPURenderPipeline;
  private uniformBuf: GPUBuffer;
  private patchBuf: GPUBuffer;
  private bindGroup: GPUBindGroup;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  private cpu: Float32Array<ArrayBuffer>;
  private count = 0;

  constructor(device: GPUDevice, trackW: number, trackH: number) {
    // Half-resolution — skid marks don't need pixel-perfect detail.
    const tw = Math.ceil(trackW / 2);
    const th = Math.ceil(trackH / 2);

    this.texture = device.createTexture({
      label: "skid-marks",
      size: [tw, th],
      format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.view = this.texture.createView();

    const module = device.createShaderModule({ label: "skid-shader", code: SKID_SHADER });
    this.pipeline = device.createRenderPipeline({
      label: "skid-pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module, entryPoint: "fs",
        targets: [{
          format: "rgba8unorm",
          blend: {
            // standard straight-alpha "over" composite
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    // vec2f (8 bytes) padded to 16 for uniform buffer minimum binding size
    this.uniformBuf = device.createBuffer({
      label: "skid-track-size",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.uniformBuf, 0, new Float32Array([tw, th, 0, 0]));

    this.patchBuf = device.createBuffer({
      label: "skid-patches",
      size: MAX_PATCHES_PER_FRAME * FLOATS_PER_PATCH * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.cpu = new Float32Array(MAX_PATCHES_PER_FRAME * FLOATS_PER_PATCH) as Float32Array<ArrayBuffer>;

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuf } },
        { binding: 1, resource: { buffer: this.patchBuf } },
      ],
    });
  }

  /** Queue a skid patch at a track-pixel position and wheel angle. */
  addPatch(x: number, y: number, angle: number) {
    if (this.count >= MAX_PATCHES_PER_FRAME) return;
    const o = this.count * FLOATS_PER_PATCH;
    this.cpu[o] = x; this.cpu[o + 1] = y; this.cpu[o + 2] = angle;
    this.count++;
  }

  /** Clear the accumulation texture (call on race restart). */
  clear(encoder: GPUCommandEncoder) {
    const pass = encoder.beginRenderPass({
      label: "skid-marks-clear",
      colorAttachments: [{
        view: this.view,
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.end();
    this.count = 0;
  }

  /** Render queued patches into the accumulation texture. Must be called before the main render pass. */
  flush(device: GPUDevice, encoder: GPUCommandEncoder) {
    if (this.count === 0) return;
    device.queue.writeBuffer(this.patchBuf, 0, this.cpu, 0, this.count * FLOATS_PER_PATCH);

    const pass = encoder.beginRenderPass({
      label: "skid-marks-pass",
      colorAttachments: [{
        view: this.view,
        loadOp: "load",   // preserve accumulated marks from previous frames
        storeOp: "store",
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6, this.count);
    pass.end();

    this.count = 0;
  }
}
