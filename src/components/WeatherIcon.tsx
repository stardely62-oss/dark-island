// Weather icons drawn as SVG, so they look the same on every system
// (emoji differ in size and baseline between fonts).

const SUN = "#ffc94a";
const MOON = "#e6e0c8";
const CLOUD = "#d9dee8";
const CLOUD_DARK = "#9aa3b2";
const RAIN = "#5fb4ff";
const SNOW = "#ffffff";
const BOLT = "#ffd84a";

function Sun({ x = 12, y = 12, r = 4.6 }: { x?: number; y?: number; r?: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={r} fill={SUN} />
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return (
          <line
            key={i}
            x1={x + Math.cos(a) * (r + 1.8)}
            y1={y + Math.sin(a) * (r + 1.8)}
            x2={x + Math.cos(a) * (r + 3.6)}
            y2={y + Math.sin(a) * (r + 3.6)}
            stroke={SUN}
            strokeWidth={1.6}
            strokeLinecap="round"
          />
        );
      })}
    </g>
  );
}

const Moon = ({ x = 12, y = 11 }: { x?: number; y?: number }) => (
  <path d={`M${x + 3} ${y - 6.5}a6.5 6.5 0 1 0 4.5 10.6A5.2 5.2 0 0 1 ${x + 3} ${y - 6.5}Z`} fill={MOON} />
);

const Cloud = ({ dark = false, dy = 0 }: { dark?: boolean; dy?: number }) => (
  <path
    d={`M7.2 ${19 + dy}h10.3a3.8 3.8 0 0 0 .5-7.6 5.4 5.4 0 0 0-10.4 1.4A3.1 3.1 0 0 0 7.2 ${19 + dy}Z`}
    fill={dark ? CLOUD_DARK : CLOUD}
  />
);

function Drops({ n, color = RAIN }: { n: number; color?: string }) {
  const xs = n === 1 ? [12] : n === 2 ? [9.5, 14.5] : [8, 12, 16];
  return (
    <g stroke={color} strokeWidth={1.7} strokeLinecap="round">
      {xs.map((x) => (
        <line key={x} x1={x} y1={20.2} x2={x - 1} y2={22.6} />
      ))}
    </g>
  );
}

function Flakes({ n }: { n: number }) {
  const xs = n === 1 ? [12] : n === 2 ? [9.5, 14.5] : [8, 12, 16];
  return (
    <g fill={SNOW}>
      {xs.map((x) => (
        <circle key={x} cx={x - 0.5} cy={21.6} r={1.1} />
      ))}
    </g>
  );
}

/** An icon for a MET Norway symbol code, e.g. "partlycloudy_night", "lightrainshowersandthunder_day". */
export function WeatherIcon({ symbol, size = 22 }: { symbol: string; size?: number }) {
  const [code, part] = symbol.split("_");
  const night = part === "night";
  const thunder = code.includes("thunder");
  const base = code.replace(/andthunder$/, "");
  const light = base.startsWith("light");
  const heavy = base.startsWith("heavy");
  const showers = base.includes("showers");
  const n = light ? 1 : heavy ? 3 : 2;

  let body: React.ReactNode;
  if (base === "clearsky") body = night ? <Moon /> : <Sun />;
  else if (base === "fair")
    body = (
      <>
        {night ? <Moon x={11} y={10} /> : <Sun x={10} y={9.5} r={4} />}
        <path d="M11 19.5h7a3 3 0 0 0 .3-6 4.2 4.2 0 0 0-8 1.1A2.5 2.5 0 0 0 11 19.5Z" fill={CLOUD} />
      </>
    );
  else if (base === "partlycloudy")
    body = (
      <>
        {night ? <Moon x={9} y={8} /> : <Sun x={9} y={8.5} r={3.8} />}
        <Cloud dy={0} />
      </>
    );
  else if (base === "cloudy") body = <Cloud />;
  else if (base === "fog")
    body = (
      <g stroke={CLOUD} strokeWidth={1.8} strokeLinecap="round">
        <line x1={4.5} y1={9} x2={19.5} y2={9} />
        <line x1={6.5} y1={13} x2={17.5} y2={13} />
        <line x1={4.5} y1={17} x2={19.5} y2={17} />
      </g>
    );
  else {
    const wet = /snow/.test(base) ? <Flakes n={n} /> : /sleet/.test(base) ? (
      <>
        <Drops n={1} />
        <Flakes n={1} />
      </>
    ) : (
      <Drops n={n} />
    );
    body = (
      <>
        {showers && (night ? <Moon x={9} y={6} /> : <Sun x={8.5} y={7} r={3.4} />)}
        <Cloud dark={heavy || thunder} dy={-2} />
        {wet}
        {thunder && <path d="m12.6 15.5-2.6 3.8h2.4l-1.2 3.4 3.4-4.6h-2.4l1.1-2.6Z" fill={BOLT} />}
      </>
    );
  }
  return (
    <svg className="wicon" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {body}
    </svg>
  );
}
