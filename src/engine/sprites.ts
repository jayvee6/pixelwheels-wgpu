// Instanced 2D sprite batch. Each sprite samples a UV rect from one texture atlas and is drawn as a
// rotated, scaled unit quad. Instance data lives in a storage buffer; the unit quad is generated in
// the vertex shader (no vertex buffer). Scale is applied BEFORE rotation so non-square sprites don't
// shear (first-party gotcha). One batch = one texture; the tilemap and each sprite sheet get a batch.

export interface Sprite {
  x: number; y: number;        // world center (px)
  w: number; h: number;        // world size (px)
  // UV basis: uv at quad corner (0,0) plus the U/V edge vectors. This expresses any of Tiled's 8
  // tile orientations (flip H/V/diagonal). For an unflipped rect use rectUV(...).
  uo: [number, number];        // uv origin (corner 0,0)
  uu: [number, number];        // uv U edge (corner 1,0 - 0,0)
  uv: [number, number];        // uv V edge (corner 0,1 - 0,0)
  rot?: number;                // radians
  r?: number; g?: number; b?: number; a?: number; // tint (default 1,1,1,1)
}

/** Unflipped axis-aligned UV rect helper. */
export function rectUV(u0: number, v0: number, u1: number, v1: number): Pick<Sprite, "uo" | "uu" | "uv"> {
  return { uo: [u0, v0], uu: [u1 - u0, 0], uv: [0, v1 - v0] };
}

const FLOATS_PER_SPRITE = 16; // pos2,size2,uvO2,uvU2,uvV2,tint4,rot1,pad1

const SHADER = /* wgsl */ `
struct Camera { viewProj: mat4x4f };
// tint (vec4f) is first to avoid a std140/430 alignment hole — keeps the struct exactly 64 bytes
// (16 floats), matching the CPU packing below.
struct Sprite {
  tint: vec4f,   // @0
  pos: vec2f,    // @16
  size: vec2f,   // @24
  uvO: vec2f,    // @32
  uvU: vec2f,    // @40
  uvV: vec2f,    // @48
  rot: f32,      // @56
  _pad: f32,     // @60
};

@group(0) @binding(0) var<uniform> cam: Camera;
@group(0) @binding(1) var<storage, read> sprites: array<Sprite>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var tex: texture_2d<f32>;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) tint: vec4f,
};

// two triangles of a unit quad, corners in [-0.5, 0.5]
const CORNERS = array<vec2f, 6>(
  vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
  vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5),
);
const QUV = array<vec2f, 6>(
  vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0),
  vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let s = sprites[ii];
  let corner = CORNERS[vi];
  let scaled = corner * s.size;                 // scale BEFORE rotate
  let c = cos(s.rot);
  let sn = sin(s.rot);
  let rotated = vec2f(scaled.x * c - scaled.y * sn, scaled.x * sn + scaled.y * c);
  let world = s.pos + rotated;

  var out: VSOut;
  out.pos = cam.viewProj * vec4f(world, 0.0, 1.0);
  let quv = QUV[vi];
  out.uv = s.uvO + quv.x * s.uvU + quv.y * s.uvV;
  out.tint = s.tint;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let texel = textureSample(tex, samp, in.uv);
  return texel * in.tint;
}
`;

export class SpriteBatch {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private sampler: GPUSampler;
  private camBuf: GPUBuffer;
  private instanceBuf: GPUBuffer;
  private capacity: number;
  private bindGroup: GPUBindGroup;
  private texView: GPUTextureView;
  private cpu: Float32Array<ArrayBuffer>;

  constructor(device: GPUDevice, format: GPUTextureFormat, texView: GPUTextureView, initialCapacity = 2048, filter: GPUFilterMode = "nearest") {
    console.assert(FLOATS_PER_SPRITE * 4 === 64, "Sprite struct layout mismatch — check WGSL field order");
    this.device = device;
    this.texView = texView;
    this.capacity = initialCapacity;
    this.cpu = new Float32Array(this.capacity * FLOATS_PER_SPRITE);

    const module = device.createShaderModule({ code: SHADER });
    this.pipeline = device.createRenderPipeline({
      label: "sprite-batch",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.sampler = device.createSampler({ magFilter: filter, minFilter: filter });
    this.camBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.instanceBuf = this.makeInstanceBuffer(this.capacity);
    this.bindGroup = this.makeBindGroup();
  }

  private makeInstanceBuffer(capacity: number): GPUBuffer {
    return this.device.createBuffer({
      label: "sprite-instances",
      size: capacity * FLOATS_PER_SPRITE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
  }

  // Bind group references only buffers + a stable texture view, so it survives writeBuffer and
  // canvas resize; only rebuilt when the instance buffer grows.
  private makeBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.camBuf } },
        { binding: 1, resource: { buffer: this.instanceBuf } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: this.texView },
      ],
    });
  }

  private ensureCapacity(n: number) {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    this.capacity = cap;
    this.cpu = new Float32Array(cap * FLOATS_PER_SPRITE);
    this.instanceBuf.destroy();
    this.instanceBuf = this.makeInstanceBuffer(cap);
    this.bindGroup = this.makeBindGroup();
  }

  /** Upload the camera matrix for this frame. */
  setCamera(viewProj: Float32Array<ArrayBuffer>) {
    this.device.queue.writeBuffer(this.camBuf, 0, viewProj);
  }

  /** Pack + upload + draw a list of sprites in one instanced draw. */
  draw(pass: GPURenderPassEncoder, sprites: Sprite[]) {
    const n = sprites.length;
    if (n === 0) return;
    this.ensureCapacity(n);
    const f = this.cpu;
    for (let i = 0; i < n; i++) {
      const s = sprites[i];
      const o = i * FLOATS_PER_SPRITE;
      f[o] = s.r ?? 1; f[o + 1] = s.g ?? 1; f[o + 2] = s.b ?? 1; f[o + 3] = s.a ?? 1; // tint @0
      f[o + 4] = s.x; f[o + 5] = s.y;            // pos @16
      f[o + 6] = s.w; f[o + 7] = s.h;            // size @24
      f[o + 8] = s.uo[0]; f[o + 9] = s.uo[1];    // uvO @32
      f[o + 10] = s.uu[0]; f[o + 11] = s.uu[1];  // uvU @40
      f[o + 12] = s.uv[0]; f[o + 13] = s.uv[1];  // uvV @48
      f[o + 14] = s.rot ?? 0;                    // rot @56
      // f[o + 15] padding @60
    }
    // pass the typed array directly; dataOffset/size are in ELEMENTS for a TypedArray
    this.device.queue.writeBuffer(this.instanceBuf, 0, f, 0, n * FLOATS_PER_SPRITE);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6, n);
  }
}
