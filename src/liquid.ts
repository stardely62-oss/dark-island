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

// Beats: a kick that clearly stands out from the recent bass level.
const BEAT_MIN_GAP = 0.3; // s
const BEAT_BODY = 55; // px/s: the body gets a soft push down
const BEAT_EDGE = 32; // px/s: and a ripple runs along the edge

// Drops: now and then, on a strong beat, a drop swells on the edge,
// breaks off and melts away as it falls.
const DROPS = true;
const DROP_GAP = 1.6; // s, at least
const DROP_SWELL = 0.3; // s to swell before it breaks off
const DROP_R = 4.2; // px
const DROP_LIFE = 0.65; // s
const DROP_NECK = 0.11; // s the drop stays joined to the edge by a thinning neck

const N = 28; // points along the lower edge
const SUB = 3; // physics substeps per frame

// Size springs. Growing: a little under critical damping, one soft
// overshoot like a drop of liquid. Shrinking: close to critical, so the
// island settles into the pill without bouncing back out.
const GROW_K = 220;
const GROW_C = 22;
const SHRINK_K = 150;
const SHRINK_C = 24;

// Edge chain.
const EDGE_K = 70; // pull towards the target shape
const EDGE_T = 2600; // tension between neighbours: the smoothing force
const EDGE_D = 10; // damping
const INERTIA = 0.028; // how much the edge lags behind the body's motion
const EDGE_MAX = 18; // px, hard safety limit

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
  private _music = 0;
  /** Smoothed band levels, 0..1. */
  readonly levels = new Float32Array(6);
  t = 0;
  /** 0..1, flashes on a beat and fades over a quarter of a second. */
  beat = 0;
  /** Falling drops, in island coordinates (x from the centre). */
  drops: { x: number; y: number; vy: number; r: number; life: number; age: number }[] = [];
  /** A drop that is forming on the edge. */
  private swell: { x: number; t: number } | null = null;
  private bassAvg = 0;
  private lastBeat = -9;
  private lastDrop = -9;

  constructor(shape: Shape) {
    this.w = shape.w;
    this.h = shape.h;
  }

  get music() {
    return this._music;
  }

  /** Average of the smoothed band levels. */
  get energy() {
    let e = 0;
    for (let k = 0; k < 6; k++) e += this.levels[k];
    return e / 6;
  }

  get radius() {
    return Math.min(this.h / 2, MAX_RADIUS);
  }

  /** Advances the simulation; returns false once everything is at rest. */
  step(dtRaw: number, d: Drive): boolean {
    const dt = Math.min(dtRaw, 1 / 30);
    this.t += dt;

    this._music += (d.music - this._music) * Math.min(1, dt * 3);
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

    // Beat detection on the raw bass, against its own recent average.
    const rawBass = (0.6 * (d.bands[0] ?? 0) + 0.4 * (d.bands[1] ?? 0)) * d.music;
    this.bassAvg += (rawBass - this.bassAvg) * (1 - Math.exp(-dt / 0.8));
    let hit = 0;
    if (
      d.music > 0.5 &&
      rawBass > 0.32 &&
      rawBass > this.bassAvg * 1.18 + 0.06 &&
      this.t - this.lastBeat > BEAT_MIN_GAP
    ) {
      hit = Math.min(1, 0.3 + (rawBass - this.bassAvg) * 3);
      this.lastBeat = this.t;
    }
    this.beat = Math.max(this.beat * Math.exp(-dt / 0.25), hit);

    // Body size.
    const tw = d.target.w + BASS_GROW * bass;
    const [kw, cw] = tw >= this.w ? [GROW_K, GROW_C] : [SHRINK_K, SHRINK_C];
    const [kh, ch] = d.target.h >= this.h ? [GROW_K, GROW_C] : [SHRINK_K, SHRINK_C];
    const aw = kw * (tw - this.w) - cw * this.vw;
    const ah = kh * (d.target.h - this.h) - ch * this.vh;
    this.vw += aw * dt;
    this.vh += ah * dt;
    if (hit) {
      this.vh += BEAT_BODY * hit;
      this.vw -= BEAT_BODY * 0.5 * hit;
    }
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
    const m = this._music;
    if (hit && DROPS && hit > 0.55 && !this.swell && this.t - this.lastDrop > DROP_GAP && Math.random() < 0.7) {
      this.swell = { x: (Math.random() - 0.5) * span * 0.6, t: 0 };
    }
    const sw = this.swell;
    const swellK = sw ? Math.sin((Math.PI / 2) * Math.min(1, sw.t / DROP_SWELL)) : 0;
    for (let i = 0; i < N; i++) {
      const u = i / (N - 1);
      const x = -span / 2 + u * span;
      let g = 0;
      if (pull > 0) g += pull * Math.exp(-((x - cx) ** 2) / (2 * SIGMA * SIGMA));
      if (sw) g += 16 * swellK * Math.exp(-((x - sw.x) ** 2) / (2 * 16 * 16));
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

    if (hit) for (let i = 1; i < N - 1; i++) this.v[i] += BEAT_EDGE * hit * env[i];

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

    // The swelling drop breaks off; the edge, suddenly let go, springs back.
    if (sw) {
      sw.t += dt;
      if (sw.t >= DROP_SWELL || m < 0.5) {
        if (m >= 0.5) {
          this.drops.push({ x: sw.x, y: this.h + this.edgeAt(sw.x, span) + DROP_R * 0.8, vy: 25, r: DROP_R, life: 1, age: 0 });
          this.lastDrop = this.t;
        }
        this.swell = null;
      }
    }
    for (const dr of this.drops) {
      dr.vy += 380 * dt;
      dr.y += dr.vy * dt;
      dr.age += dt;
      if (dr.age > DROP_NECK) dr.life -= dt / DROP_LIFE;
    }
    this.drops = this.drops.filter((dr) => dr.life > 0);

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
    return !settled || energy > 0.05 || m > 0.001 || this._music > 0.001 || pull > 0 || loud > 0.005 || this.drops.length > 0 || this.beat > 0.01;
  }

  private edgeAt(x: number, span: number) {
    const i = Math.round(((x + span / 2) / span) * (N - 1));
    return this.y[Math.max(0, Math.min(N - 1, i))];
  }

  /** The forming and falling drops as an SVG path, centred on `cx`. */
  dropsPath(cx: number): string {
    const n = (v: number) => v.toFixed(2);
    const circle = (x: number, y: number, r: number) =>
      r < 0.3 ? "" : `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;
    let d = "";
    if (this.swell) {
      // A bead hanging under the bulge, growing with it.
      const span = Math.max(1, this.w - 2 * this.radius);
      const k = Math.min(1, this.swell.t / DROP_SWELL);
      const r = DROP_R * k;
      d += circle(cx + this.swell.x, this.h + this.edgeAt(this.swell.x, span) - r * 0.2, r);
    }
    const span = Math.max(1, this.w - 2 * this.radius);
    for (const dr of this.drops) {
      const r = dr.r * (0.35 + 0.65 * dr.life);
      const x = cx + dr.x;
      const edge = this.h + this.edgeAt(dr.x, span) - 1;
      // Joined to the edge by a neck at first; then the tail snaps up into
      // the drop and it falls as a ball, shrinking as it melts.
      const tail =
        dr.age < DROP_NECK ? dr.y - edge : Math.max(0, (dr.y - edge) * Math.exp(-(dr.age - DROP_NECK) / 0.05));
      d += tail > r ? tear(x, dr.y - tail, dr.y, r) : circle(x, dr.y, r);
    }
    return d;
  }

  /** Opacity for the drops layer: they fade as they melt. */
  get dropsOpacity() {
    let o = this.swell ? 1 : 0;
    for (const dr of this.drops) o = Math.max(o, Math.min(1, dr.life * 1.6));
    return o;
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
    const f = Math.min(SHOULDER, h / 3);
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

/** A drop hanging from (x, top) with its round end centred at (x, yc). */
function tear(x: number, top: number, yc: number, r: number): string {
  const n = (v: number) => v.toFixed(2);
  const neck = top + (yc - top) * 0.55;
  return (
    `M${n(x)} ${n(top)}` +
    `C${n(x + r * 0.22)} ${n(neck)} ${n(x + r)} ${n(yc - r * 0.95)} ${n(x + r)} ${n(yc)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x - r)} ${n(yc)}` +
    `C${n(x - r)} ${n(yc - r * 0.95)} ${n(x - r * 0.22)} ${n(neck)} ${n(x)} ${n(top)}Z`
  );
}
