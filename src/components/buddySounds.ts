// Клодик's little 8-bit noises, made on the spot (no sound files).
// Quiet, and off unless turned on in the settings.

let ctx: AudioContext | null = null;
let enabled = false;
let last = 0;

export function setSounds(on: boolean) {
  enabled = on;
}

/** Notes as [frequency Hz, start s, length s]; square waves like an old console. */
type Note = [number, number, number];

const SOUNDS: Record<string, { wave: OscillatorType; notes: Note[]; slide?: number; vol?: number }> = {
  hop: { wave: "square", notes: [[520, 0, 0.09]], slide: 1.8 },
  plop: { wave: "triangle", notes: [[220, 0, 0.12]], slide: 0.5, vol: 1.4 },
  surprised: { wave: "square", notes: [[660, 0, 0.05], [990, 0.06, 0.07]] },
  hop2: { wave: "square", notes: [[700, 0, 0.06]], slide: 1.4 },
  happy: { wave: "square", notes: [[784, 0, 0.07], [988, 0.08, 0.07], [1175, 0.16, 0.1]] },
  excited: { wave: "square", notes: [[659, 0, 0.06], [880, 0.07, 0.06], [1319, 0.14, 0.12]] },
  love: { wave: "triangle", notes: [[880, 0, 0.12], [1175, 0.14, 0.2]] },
  angry: { wave: "sawtooth", notes: [[180, 0, 0.12], [150, 0.13, 0.14]], vol: 0.6 },
  furious: { wave: "sawtooth", notes: [[160, 0, 0.08], [140, 0.09, 0.08], [120, 0.18, 0.16]], vol: 0.6 },
  dizzy: { wave: "triangle", notes: [[900, 0, 0.5]], slide: 0.4 },
  charged: { wave: "square", notes: [[523, 0, 0.05], [659, 0.06, 0.05], [784, 0.12, 0.05], [1047, 0.18, 0.12]] },
  eat: { wave: "square", notes: [[300, 0, 0.04], [300, 0.3, 0.04], [300, 0.6, 0.04], [300, 0.9, 0.04]], slide: 0.6 },
  ball: { wave: "triangle", notes: [[400, 0, 0.06], [400, 1.2, 0.06], [400, 2.4, 0.06]], slide: 1.6 },
  sleep: { wave: "triangle", notes: [[392, 0, 0.3], [330, 0.32, 0.4]], vol: 0.7 },
  wave: { wave: "square", notes: [[880, 0, 0.05], [1047, 0.07, 0.05]], vol: 0.6 },
};

export function sfx(name: string) {
  const s = SOUNDS[name];
  if (!enabled || !s) return;
  // Never a pile of noises at once.
  const now = performance.now();
  if (now - last < 120) return;
  last = now;
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime + 0.01;
    const vol = 0.035 * (s.vol ?? 1);
    for (const [f, start, len] of s.notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = s.wave;
      const t = t0 + start;
      o.frequency.setValueAtTime(f, t);
      if (s.slide) o.frequency.exponentialRampToValueAtTime(f * s.slide, t + len);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + len + 0.02);
    }
  } catch {
    /* audio unavailable */
  }
}
