import { t } from "./i18n";
// MET Norway symbol codes → an emoji and a few Russian words.

export type Point = {
  t: number;
  temp: number;
  wind: number;
  humidity: number;
  pressure: number;
  symbol: string;
  precip: number;
  symbol6: string;
};
export type Weather = { city: string; points: Point[]; at: number };

const BASE: Record<string, [string, string]> = {
  clearsky: ["☀️", t("ясно")],
  fair: ["🌤️", t("малооблачно")],
  partlycloudy: ["⛅", t("переменная облачность")],
  cloudy: ["☁️", t("облачно")],
  fog: ["🌫️", t("туман")],
  lightrain: ["🌦️", t("небольшой дождь")],
  rain: ["🌧️", t("дождь")],
  heavyrain: ["🌧️", t("ливень")],
  lightrainshowers: ["🌦️", t("кратковременный дождь")],
  rainshowers: ["🌦️", t("ливни")],
  heavyrainshowers: ["🌧️", t("сильные ливни")],
  lightsleet: ["🌨️", t("небольшой мокрый снег")],
  sleet: ["🌨️", t("мокрый снег")],
  heavysleet: ["🌨️", t("сильный мокрый снег")],
  lightsleetshowers: ["🌨️", t("мокрый снег")],
  sleetshowers: ["🌨️", t("мокрый снег")],
  heavysleetshowers: ["🌨️", t("мокрый снег")],
  lightsnow: ["🌨️", t("небольшой снег")],
  snow: ["❄️", t("снег")],
  heavysnow: ["❄️", t("снегопад")],
  lightsnowshowers: ["🌨️", t("небольшой снег")],
  snowshowers: ["🌨️", t("снег")],
  heavysnowshowers: ["❄️", t("снегопад")],
};

export function describe(symbol: string): { icon: string; text: string; night: boolean; wet: boolean } {
  const [code, part] = symbol.split("_");
  const night = part === "night";
  let base = code.replace(/andthunder$/, "");
  const thunder = base !== code;
  let [icon, text] = BASE[base] ?? ["🌡️", ""];
  if (night && (base === "clearsky" || base === "fair")) icon = "🌙";
  if (thunder) {
    icon = "⛈️";
    text = t("{0}, гроза", text);
  }
  base = base.toLowerCase();
  return { icon, text, night, wet: /rain|sleet|snow/.test(base) };
}

export const fmtTemp = (t: number) => `${t > 0.5 ? "" : t < -0.5 ? "−" : ""}${Math.abs(Math.round(t))}°`;

/** The point closest to now, the next 24 hours and 7 days (local time). */
export function shape(w: Weather, now = Date.now()) {
  const pts = w.points;
  const cur = pts.reduce((best, p) => (Math.abs(p.t - now) < Math.abs(best.t - now) ? p : best), pts[0]);
  const hours = pts.filter((p) => p.t >= now - 30 * 60_000).slice(0, 24);
  const byDay = new Map<string, Point[]>();
  for (const p of pts) {
    const d = new Date(p.t);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    byDay.set(key, [...(byDay.get(key) ?? []), p]);
  }
  const days = [...byDay.values()].slice(0, 7).map((list) => {
    const noon = list.reduce((b, p) => (Math.abs(new Date(p.t).getHours() - 13) < Math.abs(new Date(b.t).getHours() - 13) ? p : b));
    return {
      t: list[0].t,
      min: Math.min(...list.map((p) => p.temp)),
      max: Math.max(...list.map((p) => p.temp)),
      symbol: noon.symbol6 || noon.symbol,
      precip: list.reduce((s, p) => s + p.precip, 0),
    };
  });
  return { cur, hours, days };
}

/** Minutes until rain or snow starts within the next two hours, if it is dry now. */
export function rainSoon(w: Weather, now = Date.now()): { minutes: number; snow: boolean } | null {
  const next = w.points.filter((p) => p.t >= now - 30 * 60_000 && p.t <= now + 2 * 3_600_000);
  if (!next.length || next[0].precip >= 0.1) return null;
  const wet = next.find((p) => p.precip >= 0.3);
  if (!wet) return null;
  return { minutes: Math.max(5, Math.round((wet.t - now) / 60_000)), snow: /snow|sleet/.test(wet.symbol) };
}
