// Particle system for explosions, smoke, and other visual effects.
// Purely Canvas2D — no WebGPU overhead for small transient effects.

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  r: number; g: number; b: number;
  size: number;
}

interface EmitConfig {
  vxRange: number;
  vyRange?: number;
  vyBias?: number;
  life: number;
  lifeJitter?: number;
  r: number; g: number; b: number;
  size: number;
}

export class ParticleSystem {
  private particles: Particle[] = [];

  emit(x: number, y: number, count: number, cfg: EmitConfig) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * cfg.vxRange;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed + (cfg.vyBias ?? 0),
        life: cfg.life + (Math.random() - 0.5) * (cfg.lifeJitter ?? 0),
        maxLife: cfg.life,
        r: cfg.r, g: cfg.g, b: cfg.b,
        size: cfg.size,
      });
    }
  }

  explosion(x: number, y: number) {
    // Orange core
    this.emit(x, y, 10, { vxRange: 150, life: 0.5, lifeJitter: 0.2, r: 255, g: 140, b: 20, size: 5 });
    // Red outer
    this.emit(x, y, 8, { vxRange: 220, life: 0.35, lifeJitter: 0.1, r: 220, g: 40, b: 10, size: 3 });
    // Bright center flash
    this.emit(x, y, 4, { vxRange: 60, life: 0.15, r: 255, g: 220, b: 100, size: 8 });
  }

  smoke(x: number, y: number) {
    this.emit(x, y, 2, { vxRange: 20, vyBias: -30, life: 0.4, lifeJitter: 0.15, r: 160, g: 140, b: 130, size: 4 });
  }

  step(dt: number) {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  /** Draw all live particles. Coordinates are in world-pixel space; dpr scales to physical pixels. */
  draw(ctx: CanvasRenderingContext2D, dpr: number) {
    for (const p of this.particles) {
      const alpha = Math.max(0, p.life / p.maxLife);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `rgb(${p.r},${p.g},${p.b})`;
      ctx.beginPath();
      ctx.arc(p.x * dpr, p.y * dpr, p.size * dpr * alpha, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
