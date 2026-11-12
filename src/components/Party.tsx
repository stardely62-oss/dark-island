import { useMemo } from "react";
import { Buddy } from "./Buddy";
import "./party.css";

const COLORS = ["#ff6f9c", "#ffd84a", "#7fd0ff", "#7cbf5a", "#c27ce0", "#ff9f43"];

/** A pixel cake with three candles; the flames go out when he blows. */
function Cake() {
  const r = (x: number, y: number, w: number, h: number, fill: string, cls?: string) => (
    <rect x={x} y={y} width={w} height={h} fill={fill} className={cls} />
  );
  return (
    <svg className="party-cake" viewBox="0 -6 18 16" width={72} height={64} shapeRendering="crispEdges" aria-hidden>
      {r(0, 9, 18, 1, "#d9d9e3")}
      {r(1, 3, 16, 6, "#f7d9e3")}
      {r(1, 3, 16, 1, "#ff6f9c")}
      {r(1, 4, 1, 1, "#ff6f9c")}{r(5, 4, 1, 2, "#ff6f9c")}{r(9, 4, 1, 1, "#ff6f9c")}{r(13, 4, 1, 2, "#ff6f9c")}{r(16, 4, 1, 1, "#ff6f9c")}
      {r(1, 6, 16, 1, "#c98a4b")}
      {r(3, 7, 1, 1, "#ffd84a")}{r(8, 8, 1, 1, "#7fd0ff")}{r(13, 7, 1, 1, "#7cbf5a")}
      {r(4, 0, 1, 3, "#6f8dff")}{r(8, 0, 1, 3, "#ffd84a")}{r(12, 0, 1, 3, "#7cbf5a")}
      <g className="party-flames">
        {r(4, -2, 1, 2, "#ffb43a", "f1")}{r(8, -2, 1, 2, "#ffb43a", "f2")}{r(12, -2, 1, 2, "#ffb43a", "f3")}
        {r(4, -1, 1, 1, "#fff2a8")}{r(8, -1, 1, 1, "#fff2a8")}{r(12, -1, 1, 1, "#fff2a8")}
      </g>
      <g className="party-smoke">
        {r(4, -3, 1, 1, "#bbb", "s1")}{r(8, -3, 1, 1, "#bbb", "s2")}{r(12, -3, 1, 1, "#bbb", "s3")}
      </g>
    </svg>
  );
}

/**
 * The birthday show: he carries the cake in, sets it down, blows the
 * candles out and claps under a rain of confetti.
 */
export function PartyScene({ title, sub, onClose }: { title: string; sub: string; onClose: () => void }) {
  const bits = useMemo(
    () =>
      Array.from({ length: 46 }, (_, i) => ({
        left: Math.random() * 100,
        delay: 3.3 + Math.random() * 2.2,
        dur: 1.8 + Math.random() * 1.6,
        color: COLORS[i % COLORS.length],
        spin: Math.random() < 0.5 ? -1 : 1,
        w: 4 + Math.round(Math.random() * 3),
        drift: Math.round((Math.random() - 0.5) * 60),
      })),
    [],
  );
  return (
    <div className="party" onClick={onClose}>
      <div className="party-flags" aria-hidden>
        {Array.from({ length: 13 }, (_, i) => (
          <i key={i} style={{ background: COLORS[i % COLORS.length], animationDelay: `${i * 0.06}s` }} />
        ))}
      </div>
      <div className="party-title">
        <b>{title}</b>
        <span>{sub}</span>
      </div>
      <div className="party-floor" />
      <div className="party-cake-at">
        <Cake />
      </div>
      <div className="party-buddy">
        <Buddy size={78} still wear="party" className="party-me" />
        <div className="party-puff" aria-hidden>
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="party-confetti" aria-hidden>
        {bits.map((b, i) => (
          <i
            key={i}
            style={
              {
                left: `${b.left}%`,
                background: b.color,
                width: b.w,
                height: b.w * 1.6,
                animationDelay: `${b.delay}s`,
                animationDuration: `${b.dur}s`,
                "--spin": b.spin,
                "--drift": `${b.drift}px`,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
    </div>
  );
}
