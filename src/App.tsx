import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type Battery, type Bridge, type Cursor, type Media, type Volume } from "./ipc";
import { Liquid, type Shape } from "./liquid";
import { BatteryIcon, Next, Note, Pause, Play, Prev, Speaker } from "./components/Icons";
import { Bars } from "./components/Bars";
import { useAccent } from "./accent";

type Mode = "idle" | "media" | "hud" | "expanded";

const EXPAND_DELAY = 110;
const COLLAPSE_DELAY = 380;
const HUD_MS = 1500;
const DEFAULT_ACCENT = "rgb(142 162 255)";

function sizeOf(mode: Mode, hasMedia: boolean, hasBattery: boolean): Shape {
  switch (mode) {
    case "expanded":
      return hasMedia ? { w: 420, h: 232 } : { w: 380, h: 138 };
    case "media":
    case "hud":
      return { w: 236, h: 34 };
    default:
      return hasBattery ? { w: 196, h: 32 } : { w: 124, h: 32 };
  }
}

export function App() {
  const [api, setApi] = useState<Bridge | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [battery, setBattery] = useState<Battery | null>(null);
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hud, setHud] = useState(false);
  const accent = useAccent(media?.cover ?? null) ?? DEFAULT_ACCENT;

  const mode: Mode = expanded ? "expanded" : hud ? "hud" : media?.playing ? "media" : "idle";
  const target = useMemo(() => sizeOf(mode, !!media, !!battery), [mode, media, battery]);

  // ---- data from the system --------------------------------------------
  const cursorRef = useRef<Cursor | null>(null);
  const kickRef = useRef<() => void>(() => {});
  const hudTimer = useRef<number>(0);
  const knownVolume = useRef<Volume | null>(null);

  useEffect(() => {
    let alive = true;
    const offs: (() => void)[] = [];
    bridge.then(async (b) => {
      if (!alive) return;
      setApi(b);
      offs.push(
        b.on("media", setMedia),
        b.on("battery", setBattery),
        b.on("volume", (v) => {
          const before = knownVolume.current;
          knownVolume.current = v;
          setVolume(v);
          if (before && v && (before.level !== v.level || before.muted !== v.muted)) {
            setHud(true);
            clearTimeout(hudTimer.current);
            hudTimer.current = window.setTimeout(() => setHud(false), HUD_MS);
          }
        }),
        b.on("cursor", (c) => {
          cursorRef.current = c.near || c.inside ? c : null;
          setHovered(c.inside);
          kickRef.current();
        }),
      );
      const s = await b.getState();
      if (!alive) return;
      setMedia(s.media);
      setVolume(s.volume);
      setBattery(s.battery);
      knownVolume.current = s.volume;
    });
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);

  // ---- hover -> expand ----------------------------------------------------
  useEffect(() => {
    const t = window.setTimeout(() => setExpanded(hovered), hovered ? EXPAND_DELAY : COLLAPSE_DELAY);
    return () => clearTimeout(t);
  }, [hovered]);
  useEffect(() => {
    if (expanded) setHud(false);
  }, [expanded]);

  // ---- the animation loop ------------------------------------------------
  const pathRef = useRef<SVGPathElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const liquid = useRef<Liquid | null>(null);
  if (!liquid.current) liquid.current = new Liquid(target);
  const drive = useRef({ target, music: 0 });
  drive.current.target = target;
  drive.current.music = media?.playing ? 1 : 0;

  useEffect(() => {
    if (!api) return;
    let raf = 0;
    let last = 0;
    let sent = { x: 0, y: 0, w: 0, h: 0 };
    let sentAt = 0;

    const frame = (now: number) => {
      const L = liquid.current!;
      const dt = last ? (now - last) / 1000 : 1 / 60;
      last = now;
      const cx = window.innerWidth / 2;
      const c = cursorRef.current;
      const active = L.step(dt, {
        target: drive.current.target,
        music: drive.current.music,
        cursor: c ? { x: c.x - cx, y: c.y } : null,
      });

      pathRef.current?.setAttribute("d", L.path(cx));
      const box = boxRef.current;
      if (box) {
        box.style.width = `${L.w}px`;
        box.style.height = `${L.h}px`;
        box.style.borderRadius = `0 0 ${L.radius}px ${L.radius}px`;
      }

      // Tell Rust which area should catch the mouse.
      const t = drive.current.target;
      const w = Math.max(L.w, t.w);
      const h = Math.max(L.h, t.h) + L.sag + 2;
      const rect = { x: cx - w / 2, y: 0, w, h };
      if (
        (now - sentAt > 33 || !active) &&
        (Math.abs(rect.w - sent.w) > 0.5 || Math.abs(rect.h - sent.h) > 0.5 || Math.abs(rect.x - sent.x) > 0.5)
      ) {
        api.setHitRect(rect);
        sent = rect;
        sentAt = now;
      }

      if (active) {
        raf = requestAnimationFrame(frame);
      } else {
        raf = 0;
        last = 0;
      }
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    kickRef.current = kick;
    kick();
    window.addEventListener("resize", kick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", kick);
    };
  }, [api]);

  useEffect(() => kickRef.current(), [target, media?.playing]);

  // ---- input -------------------------------------------------------------
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!api || !volume) return;
      const step = e.deltaY > 0 ? -0.02 : 0.02;
      api.volumeStep(step);
      setVolume({ ...volume, level: Math.min(1, Math.max(0, volume.level + step)) });
    },
    [api, volume],
  );

  return (
    <div className="stage">
      <svg className="body" width="100%" height="100%">
        <path ref={pathRef} />
      </svg>
      <div
        ref={boxRef}
        className={`box mode-${mode}`}
        onWheel={onWheel}
        onClick={() => !expanded && setExpanded(true)}
      >
        <View on={mode === "idle"} shape={sizeOf("idle", false, !!battery)}>
          <Idle battery={battery} />
        </View>
        <View on={mode === "media"} shape={sizeOf("media", true, false)}>
          {media && <CompactMedia media={media} accent={accent} />}
        </View>
        <View on={mode === "hud"} shape={sizeOf("hud", false, false)}>
          {volume && <VolumeHud volume={volume} />}
        </View>
        <View on={mode === "expanded"} shape={sizeOf("expanded", !!media, !!battery)}>
          <Expanded api={api} media={media} volume={volume} battery={battery} accent={accent} setVolume={setVolume} />
        </View>
      </div>
    </div>
  );
}

/** A view is laid out at its final size and revealed by the growing body. */
function View({ on, shape, children }: { on: boolean; shape: Shape; children: React.ReactNode }) {
  return (
    <div className={`view ${on ? "on" : ""}`} style={{ width: shape.w, height: shape.h }} aria-hidden={!on}>
      {children}
    </div>
  );
}

// ---- views ----------------------------------------------------------------

function useClock(everyMs = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" });

function Idle({ battery }: { battery: Battery | null }) {
  const now = useClock();
  return (
    <div className={`idle ${battery ? "with-battery" : ""}`}>
      <span className="time">{timeFmt.format(now)}</span>
      {battery && (
        <span className="battery">
          <span className="pct">{battery.percent}%</span>
          <BatteryIcon {...battery} />
        </span>
      )}
    </div>
  );
}

function Cover({ src, size, radius }: { src: string | null; size: number; radius: number }) {
  return (
    <div className="cover" style={{ width: size, height: size, borderRadius: radius }}>
      {src ? <img src={src} alt="" draggable={false} /> : <Note size={size * 0.55} />}
    </div>
  );
}

function CompactMedia({ media, accent }: { media: Media; accent: string }) {
  return (
    <div className="compact">
      <Cover src={media.cover} size={22} radius={6} />
      <Bars playing={media.playing} color={accent} />
    </div>
  );
}

function VolumeHud({ volume }: { volume: Volume }) {
  const level = volume.muted ? 0 : volume.level;
  return (
    <div className="compact hud">
      <Speaker level={volume.level} muted={volume.muted} />
      <div className="track">
        <div className="fill" style={{ width: `${level * 100}%` }} />
      </div>
      <span className="num">{Math.round(level * 100)}</span>
    </div>
  );
}

function fmtTime(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Expanded({
  api,
  media,
  volume,
  battery,
  accent,
  setVolume,
}: {
  api: Bridge | null;
  media: Media | null;
  volume: Volume | null;
  battery: Battery | null;
  accent: string;
  setVolume: (v: Volume) => void;
}) {
  const now = useClock(500);
  const pos = media
    ? Math.min(media.durationMs, media.positionMs + (media.playing ? now.getTime() - media.updatedAtMs : 0))
    : 0;
  const progress = media && media.durationMs > 0 ? pos / media.durationMs : 0;

  return (
    <div className="expanded">
      <header>
        <span className="clock">{timeFmt.format(now)}</span>
        <span className="date">{dateFmt.format(now)}</span>
        <span className="grow" />
        {battery && (
          <span className="battery">
            <span className="pct">{battery.percent}%</span>
            <BatteryIcon {...battery} />
          </span>
        )}
      </header>

      {media ? (
        <>
          <div className="track-info">
            <Cover src={media.cover} size={56} radius={13} />
            <div className="titles">
              <div className="title" title={media.title}>
                {media.title}
              </div>
              <div className="artist" title={media.artist}>
                {media.artist || appName(media.app)}
              </div>
            </div>
            <Bars playing={media.playing} color={accent} height={18} />
          </div>
          <div className="progress">
            <span>{fmtTime(pos)}</span>
            <div className="track">
              <div className="fill" style={{ width: `${progress * 100}%` }} />
            </div>
            <span>{media.durationMs ? `-${fmtTime(media.durationMs - pos)}` : ""}</span>
          </div>
          <div className="controls">
            <button aria-label="Предыдущий" onClick={() => api?.media("prev")}>
              <Prev size={26} />
            </button>
            <button className="main" aria-label={media.playing ? "Пауза" : "Играть"} onClick={() => api?.media("toggle")}>
              {media.playing ? <Pause size={32} /> : <Play size={32} />}
            </button>
            <button aria-label="Следующий" onClick={() => api?.media("next")}>
              <Next size={26} />
            </button>
          </div>
        </>
      ) : (
        <div className="empty">
          <Note size={18} />
          <span>Ничего не играет</span>
        </div>
      )}

      {volume && (
        <div className="volume">
          <button aria-label="Без звука" onClick={() => api?.muteToggle()}>
            <Speaker level={volume.level} muted={volume.muted} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume.muted ? 0 : volume.level}
            style={{ "--v": `${(volume.muted ? 0 : volume.level) * 100}%` } as React.CSSProperties}
            onChange={(e) => {
              const level = Number(e.target.value);
              setVolume({ level, muted: false });
              api?.volumeSet(level);
            }}
          />
          <span className="num">{Math.round((volume.muted ? 0 : volume.level) * 100)}</span>
        </div>
      )}
    </div>
  );
}

function appName(id: string) {
  const s = id.toLowerCase();
  const known: [string, string][] = [
    ["spotify", "Spotify"],
    ["yandex", "Яндекс Музыка"],
    ["chrome", "Chrome"],
    ["msedge", "Edge"],
    ["firefox", "Firefox"],
    ["opera", "Opera"],
    ["zunemusic", "Медиаплеер"],
    ["vlc", "VLC"],
    ["telegram", "Telegram"],
  ];
  for (const [k, v] of known) if (s.includes(k)) return v;
  return (id.split(/[\\/!]/).pop() ?? id).replace(/\.exe$/i, "");
}
