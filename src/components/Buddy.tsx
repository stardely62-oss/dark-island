// Клодик: a tiny pixel-art companion in the spirit of Claude Code's mascot:
// a terracotta block with two tall eyes, little arms and four legs. It
// breathes and blinks on its own (CSS), looks at the cursor, dances to the
// beat, stepping its legs and squinting happily on strong kicks (driven per
// frame by `animateBuddies`), and sleeps while you are away.

import type { Liquid } from "../liquid";

const C = "#d97757";
const INK = "#1a1a1a";

/** One pixel. */
const P = ({ x, y, w = 1, h = 1, fill = C }: { x: number; y: number; w?: number; h?: number; fill?: string }) => (
  <rect x={x} y={y} width={w} height={h} fill={fill} />
);

/** work: typing away for an agent; ask: waiting for your answer; done: pleased. */
export type Mood = "work" | "ask" | "done" | null;

export function Buddy({ size = 26, sleeping = false, mood = null }: { size?: number; sleeping?: boolean; mood?: Mood }) {
  return (
    <svg
      className={`buddy ${sleeping && !mood ? "sleep" : ""} ${mood ? `mood-${mood}` : ""}`}
      width={size}
      height={(size * 11) / 15}
      viewBox="0 0 15 11"
      shapeRendering="crispEdges"
      aria-hidden
    >
      <g className="bd-sway">
        <g className="bd-legs">
          <g className="bd-leg-a">
            <P x={3} y={8} h={2} />
            <P x={9} y={8} h={2} />
          </g>
          <g className="bd-leg-b">
            <P x={5} y={8} h={2} />
            <P x={11} y={8} h={2} />
          </g>
        </g>
        <g className="bd-body">
          <P x={2} y={1} w={11} h={7} />
          <g className="bd-arm-l">
            <P x={0} y={4} w={2} h={2} />
          </g>
          <g className="bd-arm-r">
            <P x={13} y={4} w={2} h={2} />
          </g>
          <g className="bd-gaze">
            <g className="bd-eyes">
              <P x={5} y={3} h={2} fill={INK} />
              <P x={9} y={3} h={2} fill={INK} />
            </g>
            <g className="bd-happy" fill={INK}>
              <P x={4} y={4} fill={INK} />
              <P x={5} y={3} fill={INK} />
              <P x={6} y={4} fill={INK} />
              <P x={8} y={4} fill={INK} />
              <P x={9} y={3} fill={INK} />
              <P x={10} y={4} fill={INK} />
            </g>
            <g className="bd-closed">
              <P x={4} y={4} w={3} fill={INK} />
              <P x={8} y={4} w={3} fill={INK} />
            </g>
          </g>
        </g>
      </g>
      <g className="bd-mark" fill="#ffc58f" fontSize="5" fontWeight="800" fontFamily="Segoe UI, sans-serif">
        <text x="13" y="1.6">?</text>
      </g>
      <g className="bd-zz" fill="#cfd3ff" fontSize="4" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        <text x="12.5" y="1.5">z</text>
        <text x="14.3" y="-1" fontSize="3">z</text>
      </g>
    </svg>
  );
}

/**
 * Per-frame part of the companion: gaze, dancing and happy eyes. `cursor` is
 * in window coordinates, or null when it is far away.
 */
export function animateBuddies(L: Liquid, cursor: { x: number; y: number } | null) {
  const buddies = document.querySelectorAll<SVGSVGElement>(".view.on .buddy:not(.sleep)");
  const m = L.music;
  const beat = L.beat;
  const mid = 0.5 * (L.levels[2] + L.levels[3]);
  buddies.forEach((el) => {
    let gx = 0;
    let gy = 0;
    if (cursor) {
      const r = el.getBoundingClientRect();
      const dx = cursor.x - (r.left + r.width / 2);
      const dy = cursor.y - (r.top + r.height * 0.55);
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, len / 40);
      gx = (dx / len) * 0.9 * k;
      gy = (dy / len) * 0.6 * k;
    } else if (m > 0.01) {
      gx = Math.sin(L.t * 0.9) * 0.6 * m; // looks around, enjoying the music
    }
    const hop = -1.4 * beat * m;
    // Pixel art does not rotate well: it shuffles side to side instead.
    const shuffle = Math.sin(L.t * 2 * Math.PI * 0.55) * (0.5 + 0.6 * mid) * m;
    // Either open or squinting, never a mix: CSS fades between the two.
    const happy = beat * m > 0.55 ? 1 : 0;
    el.style.setProperty("--gx", gx.toFixed(2));
    el.style.setProperty("--gy", gy.toFixed(2));
    el.style.setProperty("--hop", hop.toFixed(2));
    el.style.setProperty("--sx", shuffle.toFixed(2));
    el.style.setProperty("--squash", (1 + 0.07 * beat * m).toFixed(3));
    el.classList.toggle("happy", happy === 1);
    el.classList.toggle("dance", m > 0.5);
  });
}
