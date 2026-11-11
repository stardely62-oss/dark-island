type P = { size?: number };

const svg = (size: number, body: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    {body}
  </svg>
);

export const Play = ({ size = 22 }: P) => svg(size, <path d="M8 5.6v12.8c0 .8.9 1.3 1.6.9l10-6.4c.6-.4.6-1.4 0-1.8l-10-6.4C8.9 4.3 8 4.8 8 5.6Z" />);
export const Pause = ({ size = 22 }: P) =>
  svg(size, <><rect x="6.5" y="5" width="4" height="14" rx="1.3" /><rect x="13.5" y="5" width="4" height="14" rx="1.3" /></>);
export const Next = ({ size = 22 }: P) =>
  svg(size, <><path d="M4 6.6v10.8c0 .8.9 1.3 1.6.8L13.5 13c.6-.4.6-1.3 0-1.7L5.6 5.8C4.9 5.3 4 5.8 4 6.6Z" /><rect x="16" y="5.5" width="3" height="13" rx="1.2" /></>);
export const Prev = ({ size = 22 }: P) =>
  svg(size, <><path d="M20 6.6v10.8c0 .8-.9 1.3-1.6.8L10.5 13a1 1 0 0 1 0-1.7l7.9-5.5c.7-.5 1.6 0 1.6.8Z" /><rect x="5" y="5.5" width="3" height="13" rx="1.2" /></>);
export const Note = ({ size = 22 }: P) =>
  svg(size, <path d="M9 17.5V6.6c0-.5.3-.9.8-1l8-1.9c.6-.1 1.2.3 1.2 1v10.8a2.8 2.8 0 1 1-2-2.7V7.4l-6 1.4v8.7a2.8 2.8 0 1 1-2-2.7" opacity=".9" />);

export function Speaker({ size = 18, level, muted }: P & { level: number; muted: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M4 9.5v5c0 .6.4 1 1 1h2.6l4.3 3.6c.6.5 1.6.1 1.6-.8V5.7c0-.9-1-1.3-1.6-.8L7.6 8.5H5c-.6 0-1 .4-1 1Z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="m17 9.5 5 5m0-5-5 5" />
      ) : (
        <>
          {level > 0.02 && <path d="M16.5 9.2a4 4 0 0 1 0 5.6" />}
          {level > 0.5 && <path d="M19.3 6.6a7.6 7.6 0 0 1 0 10.8" />}
        </>
      )}
    </svg>
  );
}

export function BatteryIcon({ percent, charging }: { percent: number; charging: boolean }) {
  const w = Math.max(1.5, (16 * percent) / 100);
  const color = charging ? "#5fd479" : percent <= 20 ? "#ff5f57" : "currentColor";
  return (
    <svg width={27} height={13} viewBox="0 0 27 13" aria-hidden>
      <rect x=".75" y=".75" width="22" height="11.5" rx="3.4" fill="none" stroke="currentColor" strokeOpacity=".45" strokeWidth="1.2" />
      <rect x="24.2" y="4.3" width="1.8" height="4.4" rx=".9" fill="currentColor" fillOpacity=".45" />
      <rect x="3" y="3" width={w} height="7" rx="1.8" fill={color} />
      {charging && <path d="M12.6 2.2 8.7 7h2.9l-1.1 3.8L14.4 6h-2.9l1.1-3.8Z" fill="#fff" stroke="#000" strokeWidth=".6" />}
    </svg>
  );
}
