import { useEffect, useMemo, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { describe, fmtTemp, shape, type Weather } from "../weather";

type Place = { name: string; full: string; lat: number; lon: number };

const dayFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "short" });
const hourFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit" });

/** The weather now, the next 24 hours and a week ahead, for a city picked by name. */
export function WeatherTab({
  api,
  weather,
  onPick,
  onTypeStart,
}: {
  api: Bridge | null;
  weather: Weather | null;
  onPick: (p: Place) => void;
  onTypeStart: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Place[]>([]);
  const timer = useRef(0);

  useEffect(() => {
    clearTimeout(timer.current);
    if (q.trim().length < 2) {
      setFound([]);
      return;
    }
    timer.current = window.setTimeout(() => api?.call<Place[]>("city_search", { q }).then((r) => setFound(r ?? [])), 450);
  }, [q, api]);

  const data = useMemo(() => (weather && weather.points.length ? shape(weather) : null), [weather]);

  if (!weather || searching || !data) {
    return (
      <div className="tab-weather">
        <div className="tab-bar">
          <input
            className="search"
            placeholder="Город, например «Казань»"
            value={q}
            onFocus={onTypeStart}
            onChange={(e) => setQ(e.target.value)}
          />
          {weather && (
            <button className="text-btn" onClick={() => setSearching(false)}>
              Отмена
            </button>
          )}
        </div>
        <div className="list">
          {found.map((p) => (
            <div
              key={`${p.lat},${p.lon}`}
              className="clip"
              onClick={() => {
                onPick(p);
                setSearching(false);
                setQ("");
              }}
            >
              <div className="clip-text">
                <b>{p.name}</b> <span className="muted">{p.full}</span>
              </div>
            </div>
          ))}
          {!found.length && (
            <div className="empty">
              {q.trim().length >= 2
                ? "Ищу…"
                : "Выбери город один раз — прогноз будет приходить от MET Norway. Город не определяется по адресу в сети."}
            </div>
          )}
        </div>
      </div>
    );
  }

  const { cur, hours, days } = data;
  const d = describe(cur.symbol);
  const today = days[0];
  return (
    <div className="tab-weather">
      <div className="w-now">
        <span className="w-icon">{d.icon}</span>
        <div className="w-main">
          <div className="w-temp">{fmtTemp(cur.temp)}</div>
          <div className="w-desc">
            {d.text}
            {today ? ` · ${fmtTemp(today.max)} / ${fmtTemp(today.min)}` : ""}
          </div>
        </div>
        <div className="w-facts">
          <span>💨 {Math.round(cur.wind)} м/с</span>
          <span>💧 {Math.round(cur.humidity)}%</span>
          <span>⏲ {Math.round(cur.pressure * 0.750062)} мм</span>
        </div>
        <button className="w-city" title="Сменить город" onClick={() => setSearching(true)}>
          {weather.city}
        </button>
      </div>
      <div className="w-hours">
        {hours.map((h, i) => (
          <div key={h.t} className="w-hour">
            <span className="muted">{i === 0 ? "Сейчас" : hourFmt.format(h.t)}</span>
            <span className="w-h-icon">{describe(h.symbol).icon}</span>
            <span>{fmtTemp(h.temp)}</span>
          </div>
        ))}
      </div>
      <div className="w-days">
        {days.map((day, i) => (
          <div key={day.t} className="w-day">
            <span className="w-d-name">{i === 0 ? "Сегодня" : dayFmt.format(day.t)}</span>
            <span>{describe(day.symbol).icon}</span>
            <span className="muted">{fmtTemp(day.min)}</span>
            <span>{fmtTemp(day.max)}</span>
          </div>
        ))}
      </div>
      <div className="w-credit">MET Norway · CC BY 4.0</div>
    </div>
  );
}
