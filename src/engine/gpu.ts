// WebGPU device/context bring-up. One device per session; the canvas context is configured opaque
// (fullscreen game — no DOM compositing). Throws a descriptive error if WebGPU is unavailable.
export interface GpuContext {
  device: GPUDevice;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
  canvas: HTMLCanvasElement;
}

export async function initWebGPU(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!("gpu" in navigator)) {
    throw new Error("WebGPU is not available in this browser. Try Chrome/Edge 113+ or Safari 18+.");
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter found.");
  const device = await adapter.requestDevice();
  device.lost.then((info) => {
    // Surface device loss instead of silently freezing.
    console.error("WebGPU device lost:", info.message, info.reason);
  });

  const context = canvas.getContext("webgpu");
  if (!context) throw new Error("Failed to get a WebGPU canvas context.");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });

  return { device, context, format, canvas };
}

/** Resize the canvas backing store to the display size × dpr. Returns true if it changed. */
export function resizeToDisplay(canvas: HTMLCanvasElement, maxDpr = 2): boolean {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}
