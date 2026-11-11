// The island's body: two springs for its size and a chain of coupled springs
// along the lower edge. The chain is what makes it "liquid": it lags behind
// when the island grows, wobbles back, reaches for a nearby cursor and
// sways with music.
//
// Smoothness is built in on purpose (the reference app's edge is spiky):
//  - the chain has strong tension, so neighbours pull each other level and
//    no point can form a sharp peak;
//  - every force is shaped by wide, soft curves (gaussians, long sine waves);
//  - an envelope pins the edge to zero at the corners;
//  - the edge is drawn as a Catmull-Rom spline, not straight segments.

export type Shape = { w: number; h: number };

export type Drive = {
  target: Shape;
  /** Cursor in island coordinates (0,0 = top centre of the island). */
  cursor: { x: number; y: number } | null;
  /** 0..1, how much the edge moves with music (1 while something plays). */
  music: number;
  /** Latest loudness of 6 bands, low → high, 0..1. Smoothed here. */
  bands: ArrayLike<number>;
};

// Music: band levels follow the sound quickly on the way up and slowly on
// the way down (like a VU meter), then the edge springs filter them again.
const ATTACK = 0.07; // s
const RELEASE = 0.3; // s
const BASS_SAG = 9; // px the middle of the edge drops on a kick
const MID_WAVE = 3.6; // px
const HIGH_WAVE = 2; // px
const SWAY = 0.8; // px, always there while music plays
const BASS_GROW = 4; // px the body widens on a kick

const N = 28; // points along the lower edge
const SUB = 3; // physics substeps per frame

// Size springs: a little under critical damping gives one soft overshoot.
const SIZE_K = 260;
const SIZE_C = 25;

// Edge chain.
const EDGE_K = 70; // pull towards the target shape
const EDGE_T = 2600; // tension between neighbours: the smoothing force
const EDGE_D = 10; // damping
const INERTIA = 0.028; // how much the edge lags behind the body's motion
const EDGE_MAX = 14; // px, hard safety limit

// Cursor attraction.
const REACH = 120; // px: distance at which the edge starts to reach
const PULL = 7; // px: max bulge
const SIGMA = 42; // px: width of the bulge

const SHOULDER = 9; // px: concave fillet that joins the island to the screen edge
const MAX_RADIUS = 34;

const env = new Float32Array(N);
for (let i = 0; i < N; i++) env[i] = Math.pow(Math.sin((Math.PI * i) / (N - 1)), 1.4);

export class Liquid {
  w: number;
  h: number;
  private vw = 0;
  private vh = 0;
  private y = new Float32Array(N);
  private v = new Float32Array(N);
  private goal = new Float32Array(N);
  private music = 0;
  /** Smoothed band levels, 0..1. */
  readonly levels = new Float32Array(6);
  private t = 0;

  constructor(shape: Shape) {
    this.w = shape.w;
    this.h = shape.h;
  }

  get radius() {
    return Math.min(this.h / 2, MAX_RADIUS);
  }

  /** Advances the simulation; returns false once everything is at rest. */
  step(dtRaw: number, d: Drive): boolean {
    const dt = Math.min(dtRaw, 1 / 30);
    this.t += dt;

    this.music += (d.music - this.music) * Math.min(1, dt * 3);
    const up = 1 - Math.exp(-dt / ATTACK);
    const down = 1 - Math.exp(-dt / RELEASE);
    let loud = 0;
    for (let k = 0; k < 6; k++) {
      const goal = (d.bands[k] ?? 0) * d.music;
      const cur = this.levels[k];
      this.levels[k] = cur + (goal - cur) * (goal > cur ? up : down);
      loud += this.levels[k];
    }
    const L = this.levels;
    const bass = 0.6 * L[0] + 0.4 * L[1];
    const mid = 0.5 * (L[2] + L[3]);
    const high = 0.5 * (L[4] + L[5]);

    // Body size.
    const tw = d.target.w + BASS_GROW * bass;
    const aw = SIZE_K * (tw - this.w) - SIZE_C * this.vw;
    const ah = SIZE_K * (d.target.h - this.h) - SIZE_C * this.vh;
    this.vw += aw * dt;
    this.vh += ah * dt;
    this.w += this.vw * dt;
    this.h += this.vh * dt;

    // Where the edge wants to be.
    const r = this.radius;
    const span = Math.max(1, this.w - 2 * r);
    let pull = 0;
    let cx = 0;
    if (d.cursor) {
      const half = this.w / 2;
      const dx = Math.max(0, Math.abs(d.cursor.x) - half);
      const dy = d.cursor.y - this.h;
      if (dy > -4) {
        const dist = Math.hypot(dx, Math.max(0, dy));
        const k = Math.max(0, 1 - dist / REACH);
        pull = PULL * k * k * (3 - 2 * k); // smoothstep
        cx = Math.max(-half + r, Math.min(half - r, d.cursor.x));
      }
    }
    const m = this.music;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const x = -span / 2 + u * span;
      let g = 0;
      if (pull > 0) g += pull * Math.exp(-((x - cx) ** 2) / (2 * SIGMA * SIGMA));
      if (m > 0.001) {
        // Bass: the whole edge sags, most in the middle. Mids and highs: long,
        // slow waves travelling in opposite directions — never short ripples.
        g +=
          BASS_SAG * bass * (0.55 + 0.45 * Math.sin(Math.PI * u)) +
          MID_WAVE * mid * Math.sin(2 * Math.PI * (1.0 * u - 0.3 * this.t)) +
          HIGH_WAVE * high * Math.sin(2 * Math.PI * (1.9 * u + 0.45 * this.t) + 1.3) +
          SWAY * m * Math.sin(2 * Math.PI * (1.1 * u - 0.4 * this.t));
      }
      this.goal[i] = g * env[i];
    }

    // Edge chain, semi-implicit Euler in small substeps for stability.
    const h = dt / SUB;
    let energy = 0;
    for (let s = 0; s < SUB; s++) {
      for (let i = 1; i < N - 1; i++) {
        const lap = this.y[i - 1] - 2 * this.y[i] + this.y[i + 1];
        const a = EDGE_K * (this.goal[i] - this.y[i]) + EDGE_T * lap - EDGE_D * this.v[i] - INERTIA * ah * env[i];
        this.v[i] += a * h;
      }
      for (let i = 1; i < N - 1; i++) {
        this.y[i] = Math.max(-EDGE_MAX, Math.min(EDGE_MAX, this.y[i] + this.v[i] * h));
      }
    }
    for (let i = 0; i < N; i++) energy += Math.abs(this.v[i]) + Math.abs(this.goal[i] - this.y[i]);

    const settled =
      Math.abs(tw - this.w) < 0.05 &&
      Math.abs(d.target.h - this.h) < 0.05 &&
      Math.abs(this.vw) < 0.05 &&
      Math.abs(this.vh) < 0.05;
    if (settled) {
      this.w = tw;
      this.h = d.target.h;
      this.vw = this.vh = 0;
    }
    return !settled || energy > 0.05 || m > 0.001 || this.music > 0.001 || pull > 0 || loud > 0.005;
  }

  /** Lowest point of the edge below the body, for hit-testing. */
  get sag() {
    let s = 0;
    for (let i = 0; i < N; i++) s = Math.max(s, this.y[i]);
    return s;
  }

  /** SVG path of the island, horizontally centred on `cx`, top at y = 0. */
  path(cx: number): string {
    const w = this.w;
    const h = this.h;
    const r = this.radius;
    const f = SHOULDER;
    const k = 0.5523; // cubic approximation of a quarter circle
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const span = Math.max(0, w - 2 * r);

    const px: number[] = [];
    const py: number[] = [];
    for (let i = 0; i < N; i++) {
      px.push(x0 + r + (i / (N - 1)) * span);
      py.push(h + this.y[i]);
    }

    const n = (v: number) => v.toFixed(2);
    let d = `M${n(x0 - f)} 0`;
    d += `C${n(x0 - f * 0.45)} 0 ${n(x0)} ${n(f * 0.55)} ${n(x0)} ${n(f)}`;
    d += `L${n(x0)} ${n(Math.max(f, h - r))}`;
    d += `C${n(x0)} ${n(h - r + r * k)} ${n(x0 + r - r * k)} ${n(py[0])} ${n(px[0])} ${n(py[0])}`;
    for (let i = 0; i < N - 1; i++) {
      const i0 = Math.max(0, i - 1);
      const i3 = Math.min(N - 1, i + 2);
      const c1x = px[i] + (px[i + 1] - px[i0]) / 6;
      const c1y = py[i] + (py[i + 1] - py[i0]) / 6;
      const c2x = px[i + 1] - (px[i3] - px[i]) / 6;
      const c2y = py[i + 1] - (py[i3] - py[i]) / 6;
      d += `C${n(c1x)} ${n(c1y)} ${n(c2x)} ${n(c2y)} ${n(px[i + 1])} ${n(py[i + 1])}`;
    }
    d += `C${n(x1 - r + r * k)} ${n(py[N - 1])} ${n(x1)} ${n(h - r + r * k)} ${n(x1)} ${n(Math.max(f, h - r))}`;
    d += `L${n(x1)} ${n(f)}`;
    d += `C${n(x1)} ${n(f * 0.55)} ${n(x1 + f * 0.45)} 0 ${n(x1 + f)} 0Z`;
    return d;
  }
}
