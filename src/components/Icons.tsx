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

// ---- line icons for tabs and actions (24×24, stroke) ----

const line = (size: number, body: React.ReactNode, sw = 1.9) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {body}
  </svg>
);

export const TabHome = ({ size = 17 }: P) => line(size, <><path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1Z" /></>);
export const TabClip = ({ size = 17 }: P) =>
  line(size, <><rect x="6" y="4.5" width="12" height="16" rx="2.2" /><path d="M9.5 4.5V4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v.5" /><path d="M9 10h6M9 13.5h6M9 17h3.5" /></>);
export const TabShelf = ({ size = 17 }: P) =>
  line(size, <><path d="M3.5 13.5 6 6.5a1.5 1.5 0 0 1 1.4-1h9.2a1.5 1.5 0 0 1 1.4 1l2.5 7" /><path d="M3.5 13.5h5l1.2 2h4.6l1.2-2h5V18a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18Z" /></>);
export const TabNote = ({ size = 17 }: P) =>
  line(size, <><path d="M5 4.5h10.5L19 8v11.5H5Z" /><path d="M8.5 10h7M8.5 13.5h7M8.5 17h4" /></>);
export const PinIcon = ({ size = 15 }: P) => line(size, <><path d="M14.5 3.5 20.5 9.5l-3 1-4 4 .5 4-1.5 1.5-4.5-4.5L4 19.5M8 11.5l-1.5-1.5L8 8.5l4-.5 4-4" /></>, 1.8);
export const TrashIcon = ({ size = 15 }: P) => line(size, <><path d="M4.5 7h15M9.5 7V5h5v2M6.5 7l1 12.5h9l1-12.5" /></>, 1.8);
export const CloseIcon = ({ size = 13 }: P) => line(size, <path d="m6 6 12 12M18 6 6 18" />, 2.2);
export const FolderIcon = ({ size = 30 }: P) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h6.2l2.6 2.6h12.2A2.5 2.5 0 0 1 29 11.1v13.4a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 3 24.5Z" fill="#f5c451" />
    <path d="M3 12.5h26v12a2.5 2.5 0 0 1-2.5 2.5h-21A2.5 2.5 0 0 1 3 24.5Z" fill="#ffd66b" />
  </svg>
);
export function FileIcon({ size = 30, ext }: P & { ext: string }) {
  const hue = [...ext].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 200);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M7 3h12l7 7v17a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="#e9ebf2" />
      <path d="M19 3v5a2 2 0 0 0 2 2h5" fill="#c9ccd8" />
      <rect x="5" y="17" width="17" height="8" rx="2" fill={`hsl(${hue} 60% 48%)`} />
      <text x="13.5" y="23.2" textAnchor="middle" fontSize="5.6" fontWeight="700" fill="#fff" fontFamily="Segoe UI, sans-serif">
        {ext.slice(0, 4).toUpperCase()}
      </text>
    </svg>
  );
}
export const ResetIcon = ({ size = 16 }: P) => line(size, <><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 4.5v3.5H8" /></>);
export const CapsIcon = ({ size = 17 }: P) => line(size, <><path d="M12 4 4.5 12H9v4.5h6V12h4.5Z" /><path d="M9 20h6" /></>);
export const GlobeIcon = ({ size = 17 }: P) => line(size, <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.4 2.3 3.5 5 3.5 8s-1.1 5.7-3.5 8c-2.4-2.3-3.5-5-3.5-8s1.1-5.7 3.5-8Z" /></>, 1.7);
export const TimerIcon = ({ size = 17 }: P) => line(size, <><circle cx="12" cy="13" r="7.5" /><path d="M12 9v4l2.5 2M9.5 3h5" /></>);
export function Ring({ size = 18, progress, color }: { size?: number; progress: number; color: string }) {
  const r = 7.2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r={r} fill="none" stroke="rgb(255 255 255 / .16)" strokeWidth="2.6" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeDasharray={`${(c * Math.max(0, Math.min(1, progress))).toFixed(2)} ${c.toFixed(2)}`}
        transform="rotate(-90 9 9)"
      />
    </svg>
  );
}

export const TabControls = ({ size = 17 }: P) =>
  line(size, <><rect x="3.5" y="7" width="17" height="10" rx="5" /><circle cx="15.5" cy="12" r="2.6" /></>);
export const TabSettings = ({ size = 17 }: P) =>
  line(size, <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" /></>);
export const TabWeather = ({ size = 17 }: P) =>
  line(size, <><path d="M7.5 18.5h9a4 4 0 0 0 .4-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7.5 18.5Z" /></>);
export const BellIcon = ({ size = 20 }: P) =>
  line(size, <><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>);
