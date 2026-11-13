import { useEffect, useMemo, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { describe, fmtTemp, shape, type Weather } from "../weather";
import { WeatherIcon } from "../components/WeatherIcon";

import { t, locale } from "../i18n";
type Place = { name: string; full: string; lat: number; lon: number };

const dayFmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
const hourFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit" });

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
            placeholder={t("Город, например «Казань»")}
            value={q}
            onFocus={onTypeStart}
            onChange={(e) => setQ(e.target.value)}
          />
          {weather && (
            <button className="text-btn" onClick={() => setSearching(false)}>
              {t("Отмена")}</button>
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
                ? t("Ищу…")
                : t("Выбери город один раз — прогноз будет приходить от MET Norway. Город не определяется по адресу в сети.")}
            </div>
          )}
        </div>
      </div>
    );
  }

  const { cur, hours, days } = data;
  const d = describe(cur.symbol);
  return (
    <div className="tab-weather">
      <div className="w-now">
        <span className="w-icon">
          <WeatherIcon symbol={cur.symbol} size={46} />
        </span>
        <div className="w-main">
          <div className="w-temp">{fmtTemp(cur.temp)}</div>
          <div className="w-desc">
            {d.text}
          </div>
        </div>
        <div className="w-facts">
          <span>
            <i>{t("ветер")}</i> {Math.round(cur.wind)} {" "}{t("м/с")}</span>
          <span>
            <i>{t("влажность")}</i> {Math.round(cur.humidity)}%
          </span>
          <span>
            <i>{t("давление")}</i> {Math.round(cur.pressure * 0.750062)} {" "}{t("мм")}</span>
        </div>
        <button className="w-city" title={t("Сменить город")} onClick={() => setSearching(true)}>
          {weather.city}
        </button>
      </div>
      <div
        className="w-hours"
        onWheel={(e) => {
          // The wheel scrolls the hours sideways.
          e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {hours.map((h, i) => (
          <div key={h.t} className="w-hour">
            <span className="muted">{i === 0 ? t("Сейчас") : hourFmt.format(h.t)}</span>
            <WeatherIcon symbol={h.symbol} size={22} />
            <span>{fmtTemp(h.temp)}</span>
          </div>
        ))}
      </div>
      <div className="w-days">
        {days.map((day, i) => (
          <div key={day.t} className="w-day">
            <span className="w-d-name">{i === 0 ? t("Сегодня") : dayFmt.format(day.t)}</span>
            <WeatherIcon symbol={day.symbol} size={22} />
            <span>{fmtTemp(day.max)}</span>
            <span className="muted">{fmtTemp(day.min)}</span>
          </div>
        ))}
      </div>
      <div className="w-credit">MET Norway · CC BY 4.0</div>
    </div>
  );
}
