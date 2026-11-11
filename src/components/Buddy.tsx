// Клодик: a tiny terracotta companion with a spark on its head (a nod to
// Claude's starburst). It breathes and blinks on its own (CSS), looks at the
// cursor, dances to the beat and squints happily on strong kicks (driven per
// frame by `animateBuddies`), and sleeps while you are away.

import type { Liquid } from "../liquid";

const RAYS = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);

export function Buddy({ size = 22, sleeping = false }: { size?: number; sleeping?: boolean }) {
  return (
    <svg className={`buddy ${sleeping ? "sleep" : ""}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <g className="bd-sway">
        <g className="bd-body">
          <ellipse cx="9" cy="22.1" rx="1.7" ry="1" fill="#b45d41" />
          <ellipse cx="15" cy="22.1" rx="1.7" ry="1" fill="#b45d41" />
          <path d="M12 7c4.8 0 7.9 3.2 7.9 8 0 4.5-3.2 7.1-7.9 7.1S4.1 19.5 4.1 15c0-4.8 3.1-8 7.9-8Z" fill="#d97757" />
          <path d="M8 9.6c1.1-.9 2.4-1.3 3.7-1.4" stroke="#f4b49b" strokeWidth=".9" strokeLinecap="round" fill="none" opacity=".7" />
          <circle cx="7.6" cy="16.8" r="1.15" fill="#f6a58c" opacity=".75" />
          <circle cx="16.4" cy="16.8" r="1.15" fill="#f6a58c" opacity=".75" />
          <g className="bd-gaze">
            <g className="bd-eyes">
              <ellipse className="bd-eye" cx="9.5" cy="14" rx="1.15" ry="1.6" fill="#2a1a14" />
              <ellipse className="bd-eye" cx="14.5" cy="14" rx="1.15" ry="1.6" fill="#2a1a14" />
              <circle cx="9.9" cy="13.3" r=".38" fill="#fff" />
              <circle cx="14.9" cy="13.3" r=".38" fill="#fff" />
            </g>
            <g className="bd-happy" stroke="#2a1a14" strokeWidth=".95" strokeLinecap="round" fill="none">
              <path d="M8.4 14.4q1.1-1.5 2.2 0" />
              <path d="M13.4 14.4q1.1-1.5 2.2 0" />
            </g>
            <g className="bd-closed" stroke="#2a1a14" strokeWidth=".9" strokeLinecap="round" fill="none">
              <path d="M8.4 14.2q1.1.8 2.2 0" />
              <path d="M13.4 14.2q1.1.8 2.2 0" />
            </g>
          </g>
          <path className="bd-mouth" d="M11.1 17q.9.7 1.8 0" stroke="#2a1a14" strokeWidth=".75" strokeLinecap="round" fill="none" />
          <g className="bd-spark" stroke="#f0a47f" strokeWidth="1.05" strokeLinecap="round">
            {RAYS.map((a) => (
              <line
                key={a}
                x1={12 + Math.cos(a) * 0.7}
                y1={4.3 + Math.sin(a) * 0.7}
                x2={12 + Math.cos(a) * (a % (Math.PI / 2) === 0 ? 2.5 : 1.8)}
                y2={4.3 + Math.sin(a) * (a % (Math.PI / 2) === 0 ? 2.5 : 1.8)}
              />
            ))}
          </g>
        </g>
      </g>
      <g className="bd-zz" fill="#cfd3ff" fontSize="5" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        <text x="18" y="7">z</text>
        <text x="20.5" y="3.6" fontSize="3.6">z</text>
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
      gx = (dx / len) * 1.9 * k;
      gy = (dy / len) * 1.2 * k;
    } else if (m > 0.01) {
      gx = Math.sin(L.t * 0.9) * 0.8 * m; // looks around, enjoying the music
    }
    const hop = -2.4 * beat * m;
    const tilt = Math.sin(L.t * 2 * Math.PI * 0.55) * (5 + 6 * mid) * m;
    // Either open or squinting, never a mix: CSS fades between the two.
    const happy = beat * m > 0.55 ? 1 : 0;
    el.style.setProperty("--gx", gx.toFixed(2));
    el.style.setProperty("--gy", gy.toFixed(2));
    el.style.setProperty("--hop", hop.toFixed(2));
    el.style.setProperty("--tilt", `${tilt.toFixed(2)}deg`);
    el.style.setProperty("--squash", (1 + 0.07 * beat * m).toFixed(3));
    el.classList.toggle("happy", happy === 1);
  });
}
