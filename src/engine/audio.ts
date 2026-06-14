// Procedural Web Audio synthesis for Pixel Wheels.
// Engine hum: sawtooth oscillator pitched to speed.
// Tire squeal: looping bandpass-filtered white noise, gated on drift.
// Wall thud: one-shot sine with fast pitch-drop, volume scaled to impact speed.
// AudioContext is created on first init() call (must happen after a user gesture).

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private engOsc: OscillatorNode | null = null;
  private engGain: GainNode | null = null;
  private squealSrc: AudioBufferSourceNode | null = null;
  private squealGain: GainNode | null = null;

  // --- new SFX private fields ---
  private _engineOsc: OscillatorNode | null = null;
  private _engineGain: GainNode | null = null;
  private _engineRunning = false;

  private _screechGain: GainNode | null = null;
  private _screechNoise: AudioBufferSourceNode | null = null;

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();

    // Engine: sawtooth → lowpass → gain
    const lpf = this.ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 700;
    lpf.Q.value = 0.5;

    this.engGain = this.ctx.createGain();
    this.engGain.gain.value = 0;
    this.engGain.connect(this.ctx.destination);

    this.engOsc = this.ctx.createOscillator();
    this.engOsc.type = "sawtooth";
    this.engOsc.frequency.value = 80;
    this.engOsc.connect(lpf);
    lpf.connect(this.engGain);
    this.engOsc.start();

    // Tire squeal: 2-second white noise loop → bandpass → gain
    const noiseLen = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, noiseLen, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < noiseLen; i++) data[i] = Math.random() * 2 - 1;

    const bpf = this.ctx.createBiquadFilter();
    bpf.type = "bandpass";
    bpf.frequency.value = 1800;
    bpf.Q.value = 4;

    this.squealGain = this.ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealGain.connect(this.ctx.destination);

    bpf.connect(this.squealGain);

    this.squealSrc = this.ctx.createBufferSource();
    this.squealSrc.buffer = buffer;
    this.squealSrc.loop = true;
    this.squealSrc.connect(bpf);
    this.squealSrc.start();
  }

  resume() {
    this.ctx?.resume();
  }

  /** Expose the shared AudioContext so ChiptunePlayer can share it. */
  get audioCtx(): AudioContext | null {
    return this.ctx;
  }

  /** Master output node — route music through this to sit alongside SFX. */
  get masterOutput(): GainNode | null {
    // Return the engine gain as the shared output bus.
    // We create a dedicated master bus the first time this is called if needed.
    if (!this._masterBus) {
      if (!this.ctx) return null;
      this._masterBus = this.ctx.createGain();
      this._masterBus.gain.value = 1.0;
      this._masterBus.connect(this.ctx.destination);
    }
    return this._masterBus;
  }
  private _masterBus: GainNode | null = null;

  /** Call each frame with the player's current speed and drift state. */
  update(speedKmh: number, isDrifting: boolean) {
    if (!this.ctx || !this.engOsc || !this.engGain || !this.squealGain) return;
    const t = this.ctx.currentTime;
    // Pitch: 80Hz idle → ~230Hz at 100km/h
    this.engOsc.frequency.setTargetAtTime(80 + speedKmh * 1.5, t, 0.08);
    // Volume: quiet idle ramp to louder at speed
    this.engGain.gain.setTargetAtTime(0.08 + Math.min(speedKmh / 120, 1) * 0.14, t, 0.1);
    // Squeal: fade in on drift, out when grip resumes
    this.squealGain.gain.setTargetAtTime(isDrifting ? 0.11 : 0, t, 0.04);
  }

  /** One-shot thud on wall contact. intensity ∈ [0, 1] controls loudness. */
  impact(intensity: number) {
    if (!this.ctx) return;
    const vol = Math.min(intensity, 1) * 0.7;
    if (vol < 0.04) return;
    const t = this.ctx.currentTime;

    const osc = this.ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.12);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);

    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + 0.14);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  // -------------------------------------------------------------------------
  // Engine loop (pitched sawtooth — separate from the legacy engOsc in init)
  // -------------------------------------------------------------------------

  /** Start the independent engine-loop oscillator. Call once after init(). */
  startEngine() {
    if (!this.ctx || this._engineRunning) return;
    const master = this.masterOutput;
    if (!master) return;

    const bpf = this.ctx.createBiquadFilter();
    bpf.type = "bandpass";
    bpf.frequency.value = 400;
    bpf.Q.value = 8;

    this._engineGain = this.ctx.createGain();
    this._engineGain.gain.value = 0.08;
    this._engineGain.connect(master);

    this._engineOsc = this.ctx.createOscillator();
    this._engineOsc.type = "sawtooth";
    this._engineOsc.frequency.value = 80;
    this._engineOsc.connect(bpf);
    bpf.connect(this._engineGain);
    this._engineOsc.start();

    this._engineRunning = true;
  }

  /** Call every frame with the player's speed. Smoothly modulates pitch+volume. */
  updateEngine(speedKmh: number) {
    if (!this._engineRunning || !this._engineOsc || !this._engineGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    this._engineOsc.frequency.setTargetAtTime(80 + speedKmh * 1.4, t, 0.08);
    this._engineGain.gain.setTargetAtTime(
      0.04 + Math.min(speedKmh / 200, 1) * 0.09,
      t,
      0.08,
    );
  }

  /** Stop and tear down the engine-loop oscillator. */
  stopEngine() {
    if (this._engineOsc) {
      this._engineOsc.stop();
      this._engineOsc.disconnect();
      this._engineOsc = null;
    }
    if (this._engineGain) {
      this._engineGain.disconnect();
      this._engineGain = null;
    }
    this._engineRunning = false;
  }

  // -------------------------------------------------------------------------
  // Tire screech (drift)
  // -------------------------------------------------------------------------

  /**
   * Drive the drift screech each frame.
   * intensity ∈ [0, 1] — pass 0 to fade out and stop the noise source.
   */
  setScreech(intensity: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const master = this.masterOutput;
    if (!master) return;
    const t = ctx.currentTime;

    if (intensity > 0 && !this._screechNoise) {
      // Build a 0.5 s looped noise buffer
      const bufLen = Math.floor(ctx.sampleRate * 0.5);
      const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

      const bpf = ctx.createBiquadFilter();
      bpf.type = "bandpass";
      bpf.frequency.value = 300;
      bpf.Q.value = 3;

      this._screechGain = ctx.createGain();
      this._screechGain.gain.value = 0;
      this._screechGain.connect(master);

      bpf.connect(this._screechGain);

      this._screechNoise = ctx.createBufferSource();
      this._screechNoise.buffer = buf;
      this._screechNoise.loop = true;
      this._screechNoise.connect(bpf);
      this._screechNoise.start();
    }

    if (this._screechGain) {
      this._screechGain.gain.setTargetAtTime(intensity * 0.15, t, 0.05);
    }

    if (intensity === 0 && this._screechNoise) {
      // Ramp gain to silence then tear down
      this._screechGain?.gain.setTargetAtTime(0, t, 0.05);
      const noiseRef = this._screechNoise;
      const gainRef = this._screechGain;
      setTimeout(() => {
        noiseRef.stop();
        noiseRef.disconnect();
        gainRef?.disconnect();
      }, 150);
      this._screechNoise = null;
      this._screechGain = null;
    }
  }

  // -------------------------------------------------------------------------
  // Countdown beep
  // -------------------------------------------------------------------------

  /**
   * Short sine beep. pitch=1.0 → 440 Hz (for 3-2-1), pitch=1.5 → 660 Hz (GO!).
   */
  beep(pitch = 1.0) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const master = this.masterOutput;
    if (!master) return;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 440 * pitch;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.01);
    g.gain.linearRampToValueAtTime(0, t + 0.15);

    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + 0.15);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  // -------------------------------------------------------------------------
  // Bonus pickup chime
  // -------------------------------------------------------------------------

  /** Two-note ascending chime: D5 then F#5, 70 ms apart. */
  pickup() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const master = this.masterOutput;
    if (!master) return;

    const notes = [587, 740]; // D5, F#5
    notes.forEach((freq, i) => {
      const delay = i * 0.07;
      const t = ctx.currentTime + delay;

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.2, t);
      g.gain.linearRampToValueAtTime(0, t + 0.18);

      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + 0.18);
      osc.onended = () => { osc.disconnect(); g.disconnect(); };
    });
  }

  // -------------------------------------------------------------------------
  // Gun fire — "pew" laser
  // -------------------------------------------------------------------------

  /** Short descending square-wave sweep: 900 Hz → 400 Hz over 0.06 s. */
  shoot() {
    if (!this.ctx || !this._masterBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "square";
    // Frequency sweep: 900Hz → 400Hz over 0.06s (descending "pew")
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(400, t + 0.06);
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    osc.connect(g);
    g.connect(this._masterBus);
    osc.start(t);
    osc.stop(t + 0.1);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  // -------------------------------------------------------------------------
  // Mine explosion — low thud + noise burst
  // -------------------------------------------------------------------------

  /** Low sine body thud (120→30 Hz) plus a filtered noise burst. */
  boom() {
    if (!this.ctx || !this._masterBus) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Low body thud (sine sweep 120→30Hz)
    const body = ctx.createOscillator();
    const bodyGain = ctx.createGain();
    body.type = "sine";
    body.frequency.setValueAtTime(120, t);
    body.frequency.exponentialRampToValueAtTime(30, t + 0.25);
    bodyGain.gain.setValueAtTime(0.5, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    body.connect(bodyGain);
    bodyGain.connect(this._masterBus);
    body.start(t);
    body.stop(t + 0.3);
    body.onended = () => { body.disconnect(); bodyGain.disconnect(); };

    // Noise burst through lowpass
    const bufLen = Math.ceil(ctx.sampleRate * 0.25);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 400;
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.4, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    noise.connect(lp);
    lp.connect(noiseGain);
    noiseGain.connect(this._masterBus);
    noise.start(t);
    noise.onended = () => { noise.disconnect(); lp.disconnect(); noiseGain.disconnect(); };
  }
}
