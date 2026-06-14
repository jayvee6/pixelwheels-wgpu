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
}
