// Load a PNG URL into a GPUTexture (RGBA8, no mips — pixel-art tiles sampled nearest).
export interface LoadedTexture {
  texture: GPUTexture;
  view: GPUTextureView;
  width: number;
  height: number;
}

export async function loadTexture(device: GPUDevice, url: string): Promise<LoadedTexture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch texture ${url}: ${res.status}`);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" });

  const texture = device.createTexture({
    label: url,
    size: [bitmap.width, bitmap.height, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: bitmap, flipY: false },
    { texture },
    [bitmap.width, bitmap.height],
  );
  return { texture, view: texture.createView(), width: bitmap.width, height: bitmap.height };
}
