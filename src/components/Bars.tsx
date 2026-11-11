// A small equaliser. With real audio levels (`live`) the animation loop sets
// each bar's height; without them it falls back to a calm CSS loop.
export function Bars({
  playing,
  live,
  color,
  height = 14,
}: {
  playing: boolean;
  live: boolean;
  color: string;
  height?: number;
}) {
  const mode = !playing ? "" : live ? "live" : "on";
  return (
    <div className={`bars ${mode}`} style={{ height, color }} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} style={{ animationDelay: `${-i * 0.37}s`, animationDuration: `${0.9 + (i % 2) * 0.35}s` }} />
      ))}
    </div>
  );
}
