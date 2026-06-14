// Procedural chiptune music for Pixel Wheels — fully synthesized via Web Audio API.
// No asset files. Classic SNES/Genesis racing feel.
//
// Architecture:
//   5 voices: Lead (filtered square + vibrato), Bass (filtered sawtooth), Pad (3× detuned sines),
//             Drums (kick=2 sines, snare=noise+snap, hihat=filtered noise)
//   Song: D major, 160 BPM, 4/4
//   A section 8 bars (chords: D D G A D D Bm A), B section 8 bars (G A Bm A G A D D)
//   Total 16 bars, seamless loop.
//
// Scheduling: Web Audio currentTime lookahead pattern.
// Each note = one or more oscillators + envelope gain node, disconnected on ended (no leaks).

type Voice = "lead" | "bass" | "pad" | "kick" | "snare" | "hihat";

interface NoteEvent {
  time: number;   // seconds from song start
  voice: Voice;
  freq?: number;  // Hz (undefined for drums)
  dur: number;    // gate duration in seconds
  vel: number;    // 0..1
}

export class ChiptunePlayer {
  private ctx: AudioContext;
  private musicGain: GainNode;

  private playing = false;
  private muted = false;
  private _volume = 0.55; // mix level under engine SFX

  // scheduler state
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private songStartTime = 0;  // ctx.currentTime when bar 1 beat 1 starts
  private nextNoteIndex = 0;  // index into the pre-built note event list (monotonically increasing for looping)
  private readonly LOOKAHEAD = 0.12; // seconds to schedule ahead
  private readonly SCHEDULE_INTERVAL = 80; // ms between scheduler wakeups

  // song data (built once, reused for all loops)
  private cachedNotes: NoteEvent[] = [];
  private songDuration = 0;

  // all active audio source nodes (for immediate stop/cleanup)
  private activeNodes: Array<{ src: AudioScheduledSourceNode; gain: GainNode }> = [];

  // ─── Constants ───────────────────────────────────────────────────────────

  private static readonly BPM = 160;
  private static readonly BEAT = 60 / ChiptunePlayer.BPM;
  private static readonly BAR = ChiptunePlayer.BEAT * 4;

  // MIDI note → Hz
  private static freq(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  // Chord root MIDI notes (bass octave — 2nd octave, MIDI 50s)
  private static readonly CHORD_ROOTS: Record<string, number> = {
    D: 50, G: 55, A: 57, Bm: 59,
  };

  // 16-bar chord progression
  private static readonly PROGRESSION: string[] = [
    // A section (8 bars)
    "D", "D", "G", "A", "D", "D", "Bm", "A",
    // B section (8 bars)
    "G", "A", "Bm", "A", "G", "A", "D", "D",
  ];

  // A-section lead melody: [sectionBar, beatOffset, midiNote, durationBeats]
  // D major scale: D4=62 E4=64 F#4=66 G4=67 A4=69 B4=71 C#5=73 D5=74 E5=76 F#5=78 G5=79 A5=81
  private static readonly A_MELODY: [number, number, number, number][] = [
    // Bar 0: pickup phrase
    [0, 0.0, 74, 0.5], [0, 0.5, 76, 0.5], [0, 1.0, 78, 0.75], [0, 1.75, 76, 0.25],
    [0, 2.0, 74, 0.5], [0, 2.5, 71, 0.5], [0, 3.0, 69, 1.0],
    // Bar 1: answer
    [1, 0.0, 71, 0.5], [1, 0.5, 74, 0.5], [1, 1.0, 76, 1.5],
    [1, 2.5, 74, 0.5], [1, 3.0, 71, 0.5], [1, 3.5, 69, 0.5],
    // Bar 2 (G chord): rising
    [2, 0.0, 67, 0.5], [2, 0.5, 69, 0.5], [2, 1.0, 71, 0.5], [2, 1.5, 74, 0.5],
    [2, 2.0, 76, 1.0], [2, 3.0, 74, 0.5], [2, 3.5, 71, 0.5],
    // Bar 3 (A chord): high energy
    [3, 0.0, 76, 0.25], [3, 0.25, 78, 0.25], [3, 0.5, 79, 0.5],
    [3, 1.0, 78, 0.5], [3, 1.5, 76, 0.5], [3, 2.0, 74, 0.5], [3, 2.5, 71, 1.5],
    // Bar 4 (D): hook repeat
    [4, 0.0, 74, 0.5], [4, 0.5, 76, 0.5], [4, 1.0, 78, 0.75], [4, 1.75, 76, 0.25],
    [4, 2.0, 74, 0.5], [4, 2.5, 71, 0.5], [4, 3.0, 74, 0.5], [4, 3.5, 76, 0.5],
    // Bar 5 (D): development
    [5, 0.0, 78, 1.0], [5, 1.0, 76, 0.5], [5, 1.5, 74, 0.5], [5, 2.0, 71, 2.0],
    // Bar 6 (Bm): contrast, lower
    [6, 0.0, 71, 0.5], [6, 0.5, 69, 0.5], [6, 1.0, 71, 0.5], [6, 1.5, 74, 0.5],
    [6, 2.0, 76, 0.5], [6, 2.5, 74, 0.5], [6, 3.0, 71, 1.0],
    // Bar 7 (A): build back to loop
    [7, 0.0, 69, 0.5], [7, 0.5, 71, 0.5], [7, 1.0, 74, 0.5], [7, 1.5, 76, 0.5],
    [7, 2.0, 78, 0.75], [7, 2.75, 76, 0.25], [7, 3.0, 74, 1.0],
  ];

  // B-section lead melody (higher register, more energy)
  private static readonly B_MELODY: [number, number, number, number][] = [
    // Bar 0 (G): starts high
    [0, 0.0, 79, 0.5], [0, 0.5, 78, 0.5], [0, 1.0, 76, 0.5], [0, 1.5, 74, 0.5],
    [0, 2.0, 76, 1.0], [0, 3.0, 74, 0.5], [0, 3.5, 71, 0.5],
    // Bar 1 (A): driving 16ths
    [1, 0.0, 69, 0.25],[1, 0.25, 71, 0.25],[1, 0.5, 74, 0.25],[1, 0.75, 76, 0.25],
    [1, 1.0, 78, 0.5], [1, 1.5, 79, 0.5], [1, 2.0, 78, 1.0], [1, 3.0, 76, 1.0],
    // Bar 2 (Bm)
    [2, 0.0, 74, 1.0], [2, 1.0, 71, 0.5], [2, 1.5, 74, 0.5],
    [2, 2.0, 76, 0.5], [2, 2.5, 74, 0.5], [2, 3.0, 71, 1.0],
    // Bar 3 (A)
    [3, 0.0, 76, 0.5], [3, 0.5, 78, 0.5], [3, 1.0, 79, 1.0],
    [3, 2.0, 78, 0.5], [3, 2.5, 76, 0.5], [3, 3.0, 74, 0.5], [3, 3.5, 71, 0.5],
    // Bar 4 (G)
    [4, 0.0, 69, 0.5], [4, 0.5, 71, 0.5], [4, 1.0, 74, 0.5], [4, 1.5, 71, 0.5],
    [4, 2.0, 74, 0.5], [4, 2.5, 76, 0.5], [4, 3.0, 78, 0.5], [4, 3.5, 79, 0.5],
    // Bar 5 (A): climax run
    [5, 0.0, 81, 0.75],[5, 0.75, 79, 0.25],[5, 1.0, 78, 0.5],[5, 1.5, 76, 0.5],
    [5, 2.0, 74, 0.5],[5, 2.5, 71, 1.5],
    // Bar 6 (D): resolving
    [6, 0.0, 74, 0.5],[6, 0.5, 76, 0.5],[6, 1.0, 78, 0.5],[6, 1.5, 74, 0.5],
    [6, 2.0, 71, 0.5],[6, 2.5, 69, 0.5],[6, 3.0, 71, 1.0],
    // Bar 7 (D): big finish leading to loop
    [7, 0.0, 74, 0.5],[7, 0.5, 76, 0.5],[7, 1.0, 78, 1.0],[7, 2.0, 81, 1.5],[7, 3.5, 79, 0.5],
  ];

  // ─── Constructor ─────────────────────────────────────────────────────────

  constructor(ctx: AudioContext, masterGain: GainNode) {
    this.ctx = ctx;

    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this._volume;
    this.musicGain.connect(masterGain);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  start(): void {
    if (this.playing) return;
    this.playing = true;
    this.nextNoteIndex = 0;
    this.songStartTime = this.ctx.currentTime + 0.05;
    this._ensureSong();
    this._scheduleLoop();
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.scheduleTimer !== null) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    const t = this.ctx.currentTime;
    for (const { src, gain } of this.activeNodes) {
      try {
        gain.gain.cancelScheduledValues(t);
        gain.gain.setTargetAtTime(0, t, 0.01);
        src.stop(t + 0.05);
      } catch { /* already stopped */ }
    }
    this.activeNodes = [];
    this.nextNoteIndex = 0;
  }

  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, v));
    if (!this.muted) {
      this.musicGain.gain.setTargetAtTime(this._volume, this.ctx.currentTime, 0.05);
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    const target = this.muted ? 0 : this._volume;
    this.musicGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  // ─── Song build ──────────────────────────────────────────────────────────

  private _ensureSong(): void {
    if (this.cachedNotes.length > 0) return;
    this.cachedNotes = this._buildSong();
    this.songDuration = 16 * ChiptunePlayer.BAR;
  }

  private _buildSong(): NoteEvent[] {
    const { BEAT, BAR, PROGRESSION, CHORD_ROOTS, A_MELODY, B_MELODY, freq } = ChiptunePlayer;
    const events: NoteEvent[] = [];
    const totalBars = 16;

    for (let bar = 0; bar < totalBars; bar++) {
      const barTime = bar * BAR;
      const chordName = PROGRESSION[bar];
      const isASection = bar < 8;
      const sectionBar = isASection ? bar : bar - 8;

      // ── DRUMS ──
      for (let beat = 0; beat < 4; beat++) {
        const beatT = barTime + beat * BEAT;

        // Kick on beats 1 & 3
        if (beat === 0 || beat === 2) {
          events.push({ time: beatT, voice: "kick", dur: BEAT * 0.4, vel: beat === 0 ? 0.9 : 0.75 });
        }
        // Snare on beats 2 & 4
        if (beat === 1 || beat === 3) {
          events.push({ time: beatT, voice: "snare", dur: BEAT * 0.3, vel: 0.7 });
        }
        // 8th-note hihats on every 8th, plus louder open hat on the "and" of beat 2 (beat 1 in 0-idx)
        for (let eighth = 0; eighth < 2; eighth++) {
          const isAndOf2 = beat === 1 && eighth === 1;
          events.push({
            time: beatT + eighth * BEAT * 0.5,
            voice: "hihat",
            dur: BEAT * (isAndOf2 ? 0.2 : 0.12),
            vel: isAndOf2 ? 0.50 : (eighth === 0 ? 0.35 : 0.22),
          });
        }
      }

      // ── BASS — boogie walking pattern (root, +7st, +12st, +7st, root, +5st, +7st, +5st) ──
      const rootMidi = CHORD_ROOTS[chordName] ?? 50;
      const bassPattern: [number, number][] = [
        [0.0, rootMidi],
        [0.5, rootMidi + 7],
        [1.0, rootMidi + 12],
        [1.5, rootMidi + 7],
        [2.0, rootMidi],
        [2.5, rootMidi + 5],
        [3.0, rootMidi + 7],
        [3.5, rootMidi + 5],
      ];
      for (const [beatOff, midiNote] of bassPattern) {
        events.push({
          time: barTime + beatOff * BEAT,
          voice: "bass",
          freq: freq(midiNote),
          dur: BEAT * 0.42,
          vel: 0.6,
        });
      }

      // ── PAD — one sustained chord per bar on beat 1 ──
      events.push({
        time: barTime,
        voice: "pad",
        freq: freq(rootMidi + 12), // one octave up from bass root
        dur: BAR - 0.04,
        vel: 0.12,
      });

      // ── LEAD ──
      const melody = isASection ? A_MELODY : B_MELODY;
      for (const [mBar, beatOff, midiNote, durBeats] of melody) {
        if (mBar !== sectionBar) continue;
        events.push({
          time: barTime + beatOff * BEAT,
          voice: "lead",
          freq: freq(midiNote),
          dur: durBeats * BEAT * 0.88,
          vel: 0.68,
        });
      }
    }

    events.sort((a, b) => a.time - b.time);
    return events;
  }

  // ─── Scheduler ───────────────────────────────────────────────────────────

  private _scheduleLoop(): void {
    if (!this.playing) return;

    const scheduleUntil = this.ctx.currentTime + this.LOOKAHEAD;
    const notes = this.cachedNotes;
    const songDur = this.songDuration;
    const n = notes.length;

    while (true) {
      const idx = this.nextNoteIndex % n;
      const loop = Math.floor(this.nextNoteIndex / n);
      const noteAbs = this.songStartTime + loop * songDur + notes[idx].time;
      if (noteAbs > scheduleUntil) break;
      this._playNote(notes[idx], noteAbs);
      this.nextNoteIndex++;
    }

    // prune stale node references (nodes past their stop time)
    if (this.activeNodes.length > 160) {
      // keep any that were scheduled within the last 2 seconds (rough heuristic)
      this.activeNodes = this.activeNodes.slice(-80);
    }

    this.scheduleTimer = setTimeout(() => this._scheduleLoop(), this.SCHEDULE_INTERVAL);
  }

  // ─── Per-voice synthesis ─────────────────────────────────────────────────

  private _playNote(note: NoteEvent, startTime: number): void {
    switch (note.voice) {
      case "lead":  this._lead(note, startTime); break;
      case "bass":  this._bass(note, startTime); break;
      case "pad":   this._pad(note, startTime); break;
      case "kick":  this._kick(note, startTime); break;
      case "snare": this._snare(note, startTime); break;
      case "hihat": this._hihat(note, startTime); break;
    }
  }

  // Lead: Square wave → lowpass BiquadFilter (2400Hz, Q 1.2) → ADSR gain + delayed vibrato.
  // The filtered square wave is THE classic SNES/Genesis lead synth sound.
  private _lead(note: NoteEvent, t: number): void {
    if (!note.freq) return;
    const ctx = this.ctx;
    const end = t + note.dur;
    const rel = 0.035;
    const stopAt = end + rel + 0.01;

    // Square wave oscillator
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = note.freq;

    // Classic lowpass — rolls off harshness, leaves the body
    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 2400;
    lpf.Q.value = 1.2;

    // Vibrato LFO at 6Hz, ramps in after 70ms
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 6;
    const lfoGain = ctx.createGain();
    lfoGain.gain.setValueAtTime(0, t);
    lfoGain.gain.setTargetAtTime(note.freq * 0.003, t + 0.07, 0.04);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);

    // ADSR envelope: 4ms attack, 50ms decay to 0.75× sustain, release 35ms
    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0.001, t);
    envGain.gain.linearRampToValueAtTime(note.vel, t + 0.004);
    envGain.gain.linearRampToValueAtTime(note.vel * 0.75, t + 0.054);
    envGain.gain.setValueAtTime(note.vel * 0.75, end);
    envGain.gain.linearRampToValueAtTime(0.0001, end + rel);

    osc.connect(lpf);
    lpf.connect(envGain);
    envGain.connect(this.musicGain);

    lfo.start(t); osc.start(t);
    lfo.stop(stopAt); osc.stop(stopAt);

    osc.onended = () => {
      envGain.disconnect(); lpf.disconnect(); lfoGain.disconnect();
      osc.disconnect(); lfo.disconnect();
    };
    this.activeNodes.push({ src: osc, gain: envGain });
  }

  // Bass: Sawtooth wave → lowpass BiquadFilter (600Hz, Q 0.8) → tight punchy envelope.
  // Lowpass on sawtooth = warm, growling synth bass (classic SNES/arcade).
  private _bass(note: NoteEvent, t: number): void {
    if (!note.freq) return;
    const ctx = this.ctx;
    const end = t + note.dur;
    const stopAt = end + 0.05;

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = note.freq;

    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 600;
    lpf.Q.value = 0.8;

    // Instant attack, exponential decay — punchy, no sustain
    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(note.vel * 0.6, t);
    envGain.gain.exponentialRampToValueAtTime(0.0001, end + 0.04);

    osc.connect(lpf);
    lpf.connect(envGain);
    envGain.connect(this.musicGain);

    osc.start(t);
    osc.stop(stopAt);

    osc.onended = () => {
      envGain.disconnect(); lpf.disconnect(); osc.disconnect();
    };
    this.activeNodes.push({ src: osc, gain: envGain });
  }

  // Pad: 3 slightly detuned sine oscillators for warm backing width.
  // Plays the chord root only (bass handles harmonic motion; width from detuning is enough).
  // Frequencies: freq (center), freq × 1.0023 (+4 cents), freq × 0.9977 (−4 cents).
  private _pad(note: NoteEvent, t: number): void {
    if (!note.freq) return;
    const ctx = this.ctx;
    const end = t + note.dur;
    const stopAt = end + 0.10;

    const detuneFactors = [1.0, 1.0023, 0.9977];

    for (const factor of detuneFactors) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = note.freq * factor;

      const envGain = ctx.createGain();
      // Immediate on, linear release over 0.08s at note end
      envGain.gain.setValueAtTime(note.vel, t);
      envGain.gain.setValueAtTime(note.vel, end);
      envGain.gain.linearRampToValueAtTime(0.0001, end + 0.08);

      osc.connect(envGain);
      envGain.connect(this.musicGain);

      osc.start(t);
      osc.stop(stopAt);

      osc.onended = () => {
        envGain.disconnect(); osc.disconnect();
      };
      this.activeNodes.push({ src: osc, gain: envGain });
    }
  }

  // Kick: Two oscillators summed — 160→25Hz pitched body (main impact) + 55Hz sub (weight).
  private _kick(note: NoteEvent, t: number): void {
    const ctx = this.ctx;

    // Main body: fast pitch drop 160→25Hz (90ms), strong transient
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(25, t + 0.090);

    const g = ctx.createGain();
    g.gain.setValueAtTime(note.vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.095);

    osc.connect(g);
    g.connect(this.musicGain);
    osc.start(t);
    osc.stop(t + 0.10);

    // Sub: 55Hz constant, 70ms — adds thud and low-end punch
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.value = 55;

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(note.vel * 0.8, t);
    subGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.070);

    sub.connect(subGain);
    subGain.connect(this.musicGain);
    sub.start(t);
    sub.stop(t + 0.075);

    osc.onended = () => { g.disconnect(); osc.disconnect(); };
    sub.onended = () => { subGain.disconnect(); sub.disconnect(); };
    this.activeNodes.push({ src: osc, gain: g });
    this.activeNodes.push({ src: sub, gain: subGain });
  }

  // Snare: bandpass noise body + FM snap tone for crack — classic YM2151 snare character.
  private _snare(note: NoteEvent, t: number): void {
    const ctx = this.ctx;

    // ── Noise body (bandpass at 1400Hz) ──
    const bufLen = Math.ceil(ctx.sampleRate * 0.12);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const noiseSrc = ctx.createBufferSource();
    noiseSrc.buffer = buf;

    const bpf = ctx.createBiquadFilter();
    bpf.type = "bandpass";
    bpf.frequency.value = 1400;
    bpf.Q.value = 1.2;

    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(note.vel * 0.9, t);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.10);

    noiseSrc.connect(bpf);
    bpf.connect(noiseGain);
    noiseGain.connect(this.musicGain);
    noiseSrc.start(t);
    noiseSrc.stop(t + 0.11);
    noiseSrc.onended = () => { bpf.disconnect(); noiseGain.disconnect(); noiseSrc.disconnect(); };
    this.activeNodes.push({ src: noiseSrc, gain: noiseGain });

    // ── FM snap tone (metallic crack on top) ──
    const snapMod = ctx.createOscillator();
    snapMod.type = "sine";
    snapMod.frequency.value = 400; // 2× carrier

    const snapModGain = ctx.createGain();
    snapModGain.gain.setValueAtTime(200 * 8, t);   // mod index 8 at carrier 200Hz
    snapModGain.gain.exponentialRampToValueAtTime(0.001, t + 0.020);

    const snapCar = ctx.createOscillator();
    snapCar.type = "sine";
    snapCar.frequency.value = 200;

    snapMod.connect(snapModGain);
    snapModGain.connect(snapCar.frequency);

    const snapGain = ctx.createGain();
    snapGain.gain.setValueAtTime(note.vel * 0.55, t);
    snapGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);

    snapCar.connect(snapGain);
    snapGain.connect(this.musicGain);

    const snapStop = t + 0.030;
    snapMod.start(t); snapCar.start(t);
    snapMod.stop(snapStop); snapCar.stop(snapStop);

    snapCar.onended = () => {
      snapGain.disconnect(); snapModGain.disconnect();
      snapCar.disconnect(); snapMod.disconnect();
    };
    this.activeNodes.push({ src: snapCar, gain: snapGain });
  }

  // Hi-hat: highpass-filtered noise, very short. Louder/longer for the open hat groove hit.
  private _hihat(note: NoteEvent, t: number): void {
    const ctx = this.ctx;

    const bufLen = Math.ceil(ctx.sampleRate * Math.max(note.dur + 0.01, 0.03));
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const hpf = ctx.createBiquadFilter();
    hpf.type = "highpass";
    hpf.frequency.value = 8000;

    const g = ctx.createGain();
    g.gain.setValueAtTime(note.vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + note.dur + 0.008);

    src.connect(hpf);
    hpf.connect(g);
    g.connect(this.musicGain);
    src.start(t);
    src.stop(t + note.dur + 0.01);
    src.onended = () => { hpf.disconnect(); g.disconnect(); src.disconnect(); };
    this.activeNodes.push({ src, gain: g });
  }
}
