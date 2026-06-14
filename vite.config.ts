import { defineConfig } from "vite";

// Dedicated dev-server port (kept distinct from the user's other WebGPU servers: doom 5180, kart 5182).
export default defineConfig({
  server: { port: 5200, host: true, strictPort: true },
  build: { target: "esnext" },
});
