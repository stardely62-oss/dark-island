// A small equaliser. Without real audio analysis yet, it is a calm,
// rounded animation rather than jittery bars.
export function Bars({ playing, color, height = 14 }: { playing: boolean; color: string; height?: number }) {
  return (
    <div className={`bars ${playing ? "on" : ""}`} style={{ height, color }} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} style={{ animationDelay: `${-i * 0.37}s`, animationDuration: `${0.9 + (i % 2) * 0.35}s` }} />
      ))}
    </div>
  );
}
