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

  turboFlame(x: number, y: number, angle: number) {
    // Offset spawn point to the rear of the car
    const bx = x - Math.sin(angle) * 14;
    const by = y + Math.cos(angle) * 14;
    const backVx = -Math.sin(angle) * 80;
    const backVy = Math.cos(angle) * 80;
    // Bright yellow core
    this.emit(bx, by, 2, {
      vxRange: 30, vyBias: 0, life: 0.18, lifeJitter: 0.06,
      r: 255, g: 230, b: 60, size: 5,
    });
    // Orange outer flame with backward directional bias
    const before = this.particles.length;
    this.emit(bx, by, 3, {
      vxRange: 50, life: 0.12, lifeJitter: 0.04,
      r: 255, g: 120, b: 20, size: 3,
    });
    for (let i = before; i < this.particles.length; i++) {
      this.particles[i].vx += backVx;
      this.particles[i].vy += backVy;
    }
  }

  wheelDust(x: number, y: number, material: string) {
    let r = 200, g = 195, b = 190; // default road dust (light gray)
    if (material === "SNOW" || material === "ICE") { r = 230; g = 240; b = 255; }  // white-blue snow
    else if (material === "SAND")  { r = 210; g = 180; b = 110; }                  // sandy brown
    else if (material === "WATER") { r = 160; g = 200; b = 230; }                  // blue-white spray

    this.emit(x, y, 1, {
      vxRange: 25,
      vyBias: -15,   // slight upward drift
      life: 0.35,
      lifeJitter: 0.1,
      r, g, b,
      size: 3,
    });
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
