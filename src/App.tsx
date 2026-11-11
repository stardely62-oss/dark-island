import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge, type AgentEvent, type Battery, type Bridge, type Clip, type Cursor, type Media, type Presence, type ShelfItem, type Volume } from "./ipc";
import { Liquid, type Shape } from "./liquid";
import {
  BatteryIcon,
  CapsIcon,
  GlobeIcon,
  Next,
  Note,
  Pause,
  Play,
  Prev,
  Ring,
  Speaker,
  TabClip,
  TabHome,
  TabNote,
  TabShelf,
  TabControls,
  TabSettings,
  TabWeather,
  TabAi,
  BellIcon,
  TimerIcon,
} from "./components/Icons";
import { ClipboardTab } from "./panels/Clipboard";
import { ShelfTab } from "./panels/Shelf";
import { NoteTab } from "./panels/Note";
import { ControlsTab } from "./panels/Controls";
import { SettingsTab } from "./panels/Settings";
import { CommandBar, commandHeight } from "./panels/CommandBar";
import { applyTheme, useSettings, type Shortcut } from "./settings";
import { WeatherTab } from "./panels/Weather";
import { Launcher } from "./panels/Launcher";
import { AiTab } from "./panels/Ai";
import { nextRepeat, type Reminder } from "./reminders";
import { fmtTemp, rainSoon, type Weather } from "./weather";
import { WeatherIcon } from "./components/WeatherIcon";
import { lineAt, parseLrc, type Line } from "./lyrics";
import { fmtClock, remaining, useTimer } from "./timer";
import { chime } from "./chime";
import { Bars } from "./components/Bars";
import { Buddy, animateBuddies, type Mood } from "./components/Buddy";
import { shiftHue, useAccent } from "./accent";

type Mode = "idle" | "media" | "hud" | "expanded" | "strip" | "card" | "timer" | "command" | "ask" | "agent" | "tucked" | "download" | "dictation" | "recording";
type Tab = "home" | "clip" | "shelf" | "note" | "weather" | "ai" | "controls" | "settings";
type MusicPill = "compact" | "wide" | "player" | "lyrics";
type Card = {
  key: number;
  kind: "caps" | "layout" | "timer" | "info" | "agent" | "capture" | "notify" | "reminder";
  reminder?: Reminder;
  thumb?: string | null;
  swatch?: string;
  /** What a click on the card does. */
  open?: { path?: string; url?: string; app?: string; reveal?: string };
  title: string;
  sub?: string;
  sticky?: boolean;
  mood?: Mood;
  ms?: number;
};

const EXPAND_DELAY = 110;
// From the strip the cursor has to rest a bit longer: it is often just
// passing by the top edge of a full-screen video.
const EXPAND_DELAY_STRIP = 260;
const COLLAPSE_DELAY = 380;
const HUD_MS = 1500;
const CARD_MS = 1400;
const DEFAULT_ACCENT = "rgb(142 162 255)";
const PANEL_W = 460;

function sizeOf(
  mode: Mode,
  opts: {
    media?: boolean;
    battery?: boolean;
    tab?: Tab;
    rows?: number;
    card?: Card | null;
    music?: MusicPill;
    temp?: boolean;
    launcher?: boolean;
    /** Measured height of the tab's content, for tabs that fit their content. */
    fit?: number;
  } = {},
): Shape {
  switch (mode) {
    case "tucked":
      return { w: 160, h: 0 };
    case "download":
      return { w: 340, h: 34 };
    case "dictation":
      return { w: 230, h: 34 };
    case "recording":
      return { w: 180, h: 32 };
    case "command":
      return { w: 560, h: commandHeight(opts.rows ?? 0) };
    case "ask":
      return { w: 410, h: 116 };
    case "agent":
      return { w: 300, h: 34 };
    case "expanded":
      if (opts.fit) return { w: PANEL_W, h: Math.min(292, Math.max(120, Math.ceil(opts.fit))) };
      if (opts.tab && opts.tab !== "home") return { w: PANEL_W, h: 286 };
      return opts.media ? { w: PANEL_W, h: opts.launcher ? 292 : 246 } : { w: PANEL_W, h: opts.launcher ? 212 : 168 };
    case "strip":
      return { w: 150, h: 5 };
    case "card":
      return opts.card?.kind === "reminder"
        ? { w: 400, h: 92 }
        : opts.card?.kind === "agent" || opts.card?.kind === "capture" || opts.card?.kind === "notify"
        ? { w: 380, h: 60 }
        : { w: 250, h: 34 };
    case "timer":
      return { w: 172, h: 32 };
    case "media":
      return opts.music === "wide"
        ? { w: 340, h: 38 }
        : opts.music === "player"
          ? { w: 360, h: 44 }
          : opts.music === "lyrics"
            ? { w: 410, h: 38 }
            : { w: 236, h: 34 };
    case "hud":
      return { w: 236, h: 34 };
    default:
      return { w: (opts.battery ? 214 : 140) + (opts.temp ? 52 : 0), h: 32 };
  }
}

export function App() {
  const [api, setApi] = useState<Bridge | null>(null);
  const [media, setMedia] = useState<Media | null>(null);
  const [volume, setVolume] = useState<Volume | null>(null);
  const [battery, setBattery] = useState<Battery | null>(null);
  const [hovered, setHovered] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  // Opened on purpose (click, hotkey, files dragged in): stays open until a
  // click elsewhere or the hotkey again.
  const [pinned, setPinned] = useState(false);
  // After pasting from the clipboard tab the island folds even though the
  // cursor is still on it; hovering works again once the cursor has left.
  const [suppressed, setSuppressed] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [hud, setHud] = useState(false);
  const [card, setCard] = useState<Card | null>(null);
  // True while real audio levels arrive; otherwise the bars use a CSS loop.
  const [live, setLive] = useState(false);
  const [presence, setPresence] = useState<Presence>("normal");
  const [away, setAway] = useState(false);
  const [clips, setClips] = useState<Clip[]>([]);
  const [shelf, setShelf] = useState<ShelfItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  // Heights the fitting tabs measured for themselves (fonts differ between systems).
  const [fits, setFits] = useState<Partial<Record<Tab, number>>>({});
  const measures = useMemo(
    () =>
      Object.fromEntries(
        FIT.map((t) => [t, (h: number) => setFits((f) => (Math.abs((f[t] ?? 0) - h) < 1 ? f : { ...f, [t]: h }))]),
      ) as Record<Tab, (h: number) => void>,
    [],
  );
  const measure = (t: Tab) => measures[t];
  const [commandRows, setCommandRows] = useState(0);
  // Agents in a terminal: who is working, and a pending permission question.
  const [working, setWorking] = useState<Record<string, AgentEvent & { at: number }>>({});
  const [ask, setAsk] = useState<AgentEvent | null>(null);
  const [settings, setSetting] = useSettings(api);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [privacy, setPrivacy] = useState<{ mic: string[]; cam: string[]; micMuted: boolean }>({ mic: [], cam: [], micMuted: false });
  const [downloads, setDownloads] = useState<{ name: string; size: number; speed: number }[]>([]);
  const [foreground, setForeground] = useState("");
  const [lyrics, setLyrics] = useState<Line[] | null>(null);
  const musicPill = settings.musicPill as MusicPill;
  const [dictation, setDictation] = useState<{ state: string; level: number } | null>(null);
  const [recording, setRecording] = useState<number | null>(null);
  const [aiAsk, setAiAsk] = useState<string | null>(null);
  const reminders = (settings.reminders as Reminder[] | undefined) ?? [];
  useEffect(() => applyTheme((settings.islandTheme as string) ?? "dark"), [settings.islandTheme]);
  const cardScale = settings.cardLength === "short" ? 0.7 : settings.cardLength === "long" ? 1.8 : 1;
  const cardScaleRef = useRef(cardScale);
  cardScaleRef.current = cardScale;
  const sleeping = away && !media?.playing;
  const accent = useAccent(media?.cover ?? null) ?? DEFAULT_ACCENT;
  const accent2 = useMemo(() => shiftHue(accent, 45), [accent]);

  const cardTimer = useRef<number>(0);
  const showCard = useCallback((c: Omit<Card, "key">) => {
    clearTimeout(cardTimer.current);
    setCard({ ...c, key: Date.now() });
    if (!c.sticky)
      cardTimer.current = window.setTimeout(() => setCard(null), (c.ms ?? CARD_MS) * cardScaleRef.current);
  }, []);

  const timerRef = useRef<ReturnType<typeof useTimer>>(null!);
  const timer = useTimer((total) => {
    chime();
    showCard({ kind: "timer", title: "Таймер", sub: `${fmtClock(total)} — готово`, sticky: true });
    window.setTimeout(chime, 2500);
  });

  timerRef.current = timer;
  const expanded = (hoverOpen && !suppressed) || pinned;
  const agentBusy = Object.keys(working).length > 0;
  const tucked =
    !commandOpen &&
    (settings.autoHide || (foreground !== "" && (settings.hideForApps as string[]).some((a) => a.toLowerCase().replace(/\.exe$/, "") === foreground)));
  const mode: Mode = commandOpen
    ? "command"
    : expanded
      ? "expanded"
      : ask
        ? "ask"
        : card
          ? "card"
          : hud
            ? "hud"
            : dictation
              ? "dictation"
              : recording
                ? "recording"
                : tucked
              ? "tucked"
              : presence === "strip"
                ? "strip"
                : agentBusy
                  ? "agent"
                  : downloads.length
                    ? "download"
                    : timer.active
                      ? "timer"
                      : media?.playing
                        ? "media"
                        : "idle";
  const launcherOn = (settings.launcher as Shortcut[]).length > 0 || tab === "home";
  const target = useMemo(
    () =>
      sizeOf(mode, {
        media: !!media,
        battery: !!battery,
        tab,
        rows: commandRows,
        card,
        music: musicPill === "lyrics" && !lyrics?.length ? "wide" : musicPill,
        temp: !!weather && settings.weatherOnPill,
        launcher: launcherOn,
        fit: FIT.includes(tab) ? fits[tab] : undefined,
      }),
    [mode, media, battery, tab, commandRows, card, musicPill, lyrics, weather, settings.weatherOnPill, launcherOn, fits],
  );

  // ---- data from the system --------------------------------------------
  const cursorRef = useRef<Cursor | null>(null);
  const kickRef = useRef<() => void>(() => {});
  const hudTimer = useRef<number>(0);
  const knownVolume = useRef<Volume | null>(null);
  const bandsRef = useRef<number[]>([0, 0, 0, 0, 0, 0]);
  const liveTimer = useRef<number>(0);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;

  useEffect(() => {
    let alive = true;
    const offs: (() => void)[] = [];
    bridge.then(async (b) => {
      if (!alive) return;
      setApi(b);
      offs.push(
        b.on("media", setMedia),
        b.on("battery", setBattery),
        b.on("presence", setPresence),
        b.on("away", setAway),
        b.on("clips", setClips),
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
        b.on("audio", (bands) => {
          bandsRef.current = bands;
          if (bands.some((v) => v > 0.02)) {
            setLive(true);
            clearTimeout(liveTimer.current);
            liveTimer.current = window.setTimeout(() => setLive(false), 2500);
          }
          kickRef.current();
        }),
        b.on("cursor", (c) => {
          cursorRef.current = c.near || c.inside ? c : null;
          setHovered(c.inside);
          kickRef.current();
        }),
        b.on("keys", (k) => {
          if (expandedRef.current) return;
          if (k.what === "caps") showCard({ kind: "caps", title: "Caps Lock", sub: k.caps ? "включён" : "выключен" });
          else if (k.layout) showCard({ kind: "layout", title: "Раскладка", sub: k.layout });
        }),
        b.on("agent", (e) => onAgentRef.current(e)),
        b.on("weather", setWeather),
        b.on("dictation", (d) => {
          if (d.state === "rec" || d.state === "busy") setDictation({ state: d.state, level: d.level ?? 0 });
          else {
            setDictation(null);
            if (d.state === "done") showCard({ kind: "capture", title: "Текст вставлен", sub: d.text, ms: 3500 });
            else showCard({ kind: "info", title: "Диктовка", sub: d.text ?? "ошибка", ms: 3500 });
          }
        }),
        b.on("recording", (r) => {
          if (r.on) setRecording(Date.now());
          else {
            setRecording(null);
            if (r.path) showCard({ kind: "capture", title: "Запись сохранена", sub: r.path.split(/[\\/]/).pop(), open: { reveal: r.path }, ms: 5000 });
            else if (r.error) showCard({ kind: "info", title: "Запись экрана", sub: r.error, ms: 4000 });
          }
        }),
        b.on("privacy", (p) => {
          // A card when a program starts using the microphone or the camera.
          setPrivacy((before) => {
            const fresh = [
              ...p.cam.filter((a) => !before.cam.includes(a)).map((a) => ["Камера", a]),
              ...p.mic.filter((a) => !before.mic.includes(a)).map((a) => ["Микрофон", a]),
            ];
            if (fresh.length) showCard({ kind: "info", title: fresh[0][0], sub: fresh[0][1], ms: 2500 });
            return p;
          });
        }),
        b.on("foreground", setForeground),
        b.on("downloads", setDownloads),
        b.on("download_done", (d) =>
          showCard({ kind: "capture", title: "Загружено", sub: d.name, open: { reveal: d.path }, ms: 5000 }),
        ),
        b.on("mic_muted", (m) => {
          setPrivacy((p) => ({ ...p, micMuted: m }));
          showCard({ kind: "info", title: "Микрофон", sub: m ? "выключен" : "включён" });
        }),
        b.on("vpn", (v) =>
          showCard({
            kind: "info",
            title: v.on ? "VPN включён" : "VPN выключен",
            sub: v.on ? [v.country, v.ip].filter(Boolean).join(" · ") || v.name || "" : "",
            ms: 2500,
          }),
        ),
        b.on("notification", (n) =>
          showCard({
            kind: "notify",
            title: n.title ? `${n.app} · ${n.title}` : n.app,
            sub: n.body || n.title,
            open: n.aumid ? { app: n.aumid } : undefined,
            ms: 5000,
          }),
        ),
        b.on("hotkey", (h) => {
          setSuppressed(false);
          if (h === "chat") {
            setTab("ai");
            setPinned(true);
            return;
          }
          if (h === "through") {
            setThroughRef.current();
            return;
          }
          if (h === "command") {
            setCommandOpen((o) => !o);
            return;
          }
          if (h === "clipboard") {
            setTab("clip");
            setPinned(true);
          } else {
            setTab("home");
            setPinned((p) => !(p || expandedRef.current));
          }
        }),
        b.on("capture", (r) => {
          const first = r.text.split("\n")[0];
          if (r.kind === "shot")
            showCard({ kind: "capture", title: "Снимок готов", sub: r.text, thumb: r.thumb, open: r.path ? { path: r.path } : undefined, ms: 4000 });
          else if (r.kind === "text") showCard({ kind: "capture", title: "Текст скопирован", sub: first, ms: 4000 });
          else if (r.kind === "qr")
            showCard({
              kind: "capture",
              title: "QR-код скопирован",
              sub: first,
              open: /^https?:\/\//.test(r.text) ? { url: r.text } : undefined,
              ms: 5000,
            });
          else if (r.kind === "link")
            showCard({ kind: "capture", title: "Ссылка скопирована", sub: r.text, open: { url: r.text }, ms: 5000 });
          else if (r.kind === "color") showCard({ kind: "capture", title: "Цвет скопирован", sub: r.text, swatch: r.text, ms: 3000 });
          else showCard({ kind: "info", title: "Снимок", sub: r.text });
        }),
        b.on("outside_click", () => {
          setPinned(false);
          setCommandOpen(false);
        }),
        b.on("drag", (d) => {
          if (d.type === "enter") {
            setSuppressed(false);
            setTab("shelf");
            setPinned(true);
            setDragOver(true);
          } else {
            setDragOver(false);
          }
        }),
        b.on("shelf", setShelf),
      );
      const [s, c, sh, w] = await Promise.all([
        b.getState(),
        b.call<Clip[]>("clip_list"),
        b.call<ShelfItem[]>("shelf_list"),
        b.call<Weather | null>("weather_get"),
      ]);
      setWeather(w ?? null);
      if (!alive) return;
      setMedia(s.media);
      setVolume(s.volume);
      setBattery(s.battery);
      setPresence(s.presence);
      setClips(c ?? []);
      setShelf(sh ?? []);
      knownVolume.current = s.volume;
    });
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, [showCard]);

  const setThroughRef = useRef(() => {});
  setThroughRef.current = () => {
    const on = !settings.through;
    setSetting({ through: on });
    showCard({ kind: "info", title: "Сквозной режим", sub: on ? "включён" : "выключен" });
  };

  // Song lyrics, only for the song that plays and only when turned on.
  const songKey = media && settings.lyrics ? `${media.artist}\u0001${media.title}` : "";
  useEffect(() => {
    setLyrics(null);
    if (!songKey || !api || !media) return;
    let alive = true;
    api
      .call<string | null>("lyrics_get", { artist: media.artist, title: media.title, duration: Math.round(media.durationMs / 1000) })
      .then((l) => alive && setLyrics(l ? parseLrc(l) : []));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, api]);

  // Reminders: a card with a chime that waits for an answer.
  const remRef = useRef(reminders);
  remRef.current = reminders;
  const setReminders = useCallback((r: Reminder[]) => setSetting({ reminders: r }), [setSetting]);
  useEffect(() => {
    const check = () => {
      const now = Date.now();
      const due = remRef.current.find((r) => r.at <= now);
      if (!due) return;
      // Move it on first (repeating ones to the next time), so it fires once.
      const rest = remRef.current
        .map((r) => (r.id === due.id ? (r.repeat ? { ...r, at: nextRepeat(r.repeat, new Date(now + 60_000)) } : null) : r))
        .filter((r): r is Reminder => r !== null);
      setSetting({ reminders: rest });
      chime();
      showCard({ kind: "reminder", title: "Напоминание", sub: due.text, sticky: true, reminder: due });
    };
    check();
    const id = window.setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [setSetting, showCard]);
  const snooze = (r: Reminder) => {
    setReminders([...remRef.current, { ...r, id: `${r.id}s`, repeat: undefined, at: Date.now() + 10 * 60_000 }]);
    setCard(null);
  };

  // A card about an hour before rain or snow, once per spell.
  const rainShown = useRef(0);
  useEffect(() => {
    if (!weather || !settings.rainWarning) return;
    const check = () => {
      const r = rainSoon(weather);
      if (r && Date.now() - rainShown.current > 3 * 3_600_000) {
        rainShown.current = Date.now();
        showCard({ kind: "info", title: r.snow ? "Скоро снег" : "Скоро дождь", sub: `через ${r.minutes} мин`, ms: 4000 });
      }
    };
    check();
    const id = window.setInterval(check, 10 * 60_000);
    return () => clearInterval(id);
  }, [weather, settings.rainWarning, showCard]);

  // ---- agents ----------------------------------------------------------------
  const onAgentRef = useRef<(e: AgentEvent) => void>(() => {});
  onAgentRef.current = (e: AgentEvent) => {
    const name = e.agent === "codex" ? "Codex" : "Claude";
    const where = e.project ? ` · ${e.project}` : "";
    const stopWorking = () =>
      setWorking((w) => {
        const { [e.session]: _, ...rest } = w;
        return rest;
      });
    const clearAsk = () => setAsk((a) => (a && a.session === e.session ? null : a));
    switch (e.state) {
      case "working":
        setWorking((w) => ({ ...w, [e.session]: { ...e, at: Date.now() } }));
        clearAsk();
        break;
      case "ask":
        setAsk(e);
        chime();
        break;
      case "waiting":
        clearAsk();
        stopWorking();
        showCard({ kind: "agent", title: `${name} ждёт${where}`, sub: e.detail, mood: "ask", ms: 4000 });
        break;
      case "done":
        clearAsk();
        stopWorking();
        showCard({ kind: "agent", title: `${name} закончил${where}`, sub: e.detail || "Готово", mood: "done", ms: 5000 });
        break;
      case "info":
        showCard({ kind: "agent", title: `${name}${where}`, sub: e.detail, mood: "ask", ms: 3500 });
        break;
      case "end":
        clearAsk();
        stopWorking();
        break;
    }
  };
  // A session that went quiet for ten minutes is not working any more.
  useEffect(() => {
    if (!agentBusy) return;
    const id = window.setInterval(() => {
      const now = Date.now();
      setWorking((w) => {
        const keep = Object.fromEntries(Object.entries(w).filter(([, v]) => now - v.at < 600_000));
        return Object.keys(keep).length === Object.keys(w).length ? w : keep;
      });
    }, 30_000);
    return () => clearInterval(id);
  }, [agentBusy]);
  const answer = (allow: boolean) => {
    if (!ask) return;
    api?.call("agents_answer", { id: ask.askId, allow });
    setAsk(null);
  };

  // ---- hover -> expand ----------------------------------------------------
  useEffect(() => {
    if (!hovered) setSuppressed(false);
    const delay = !hovered ? COLLAPSE_DELAY : presence === "strip" ? EXPAND_DELAY_STRIP : EXPAND_DELAY;
    const t = window.setTimeout(() => setHoverOpen(hovered), delay);
    return () => clearTimeout(t);
  }, [hovered, presence]);
  useEffect(() => {
    if (expanded) setHud(false);
  }, [expanded]);

  // The note and the search box need the keyboard: the island takes it while
  // open and gives it back to the previous window when it folds.
  const focusTaken = useRef(false);
  const takeFocus = useCallback(() => {
    setPinned(true);
    if (!focusTaken.current) {
      focusTaken.current = true;
      api?.call("take_focus");
    }
  }, [api]);
  useEffect(() => {
    if (!expanded && focusTaken.current) {
      focusTaken.current = false;
      (document.activeElement as HTMLElement | null)?.blur();
      api?.call("release_focus");
    }
  }, [expanded, api]);
  useEffect(() => {
    if (commandOpen) takeFocus();
    else if (focusTaken.current && !expanded) {
      focusTaken.current = false;
      api?.call("release_focus");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandOpen]);
  const commandActions = useMemo(
    () => ({
      startTimer: (ms: number) => timerRef.current.start(ms),
      system: (id: string) => {
        if (id === "settings" || id === "clipboard") {
          setTab(id === "settings" ? "settings" : "clip");
          setPinned(true);
          return;
        }
        if (id === "lock" || id === "sleep") {
          api?.call("power", { action: id });
          return;
        }
        api?.call<{ wifi: boolean; bluetooth: boolean; dark: boolean }>("controls_get").then((c) => {
          const on = !c[id as "wifi" | "bluetooth" | "dark"];
          api?.call("controls_set", { what: id, on });
          showCard({ kind: "info", title: id === "dark" ? "Тема" : id === "wifi" ? "Wi-Fi" : "Bluetooth", sub: on ? (id === "dark" ? "тёмная" : "включён") : id === "dark" ? "светлая" : "выключен" });
        });
      },
      close: () => {
        setCommandOpen(false);
        setPinned(false);
      },
      ask: (q: string) => {
        setCommandOpen(false);
        setTab("ai");
        setPinned(true);
        setAiAsk(q);
      },
      remind: (r: Reminder) => {
        setSetting({ reminders: [...remRef.current, r].sort((a, b) => a.at - b.at) });
        showCard({ kind: "info", title: "Напомню", sub: r.text, ms: 2000 });
      },
    }),
    [api, showCard, setSetting],
  );
  const dismiss = useCallback(() => {
    focusTaken.current = false;
    setPinned(false);
    setSuppressed(true);
  }, []);

  // ---- the animation loop ------------------------------------------------
  const pathRef = useRef<SVGPathElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<SVGPathElement>(null);
  const dropsRef = useRef<SVGPathElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<HTMLDivElement>(null);
  const blobRefs = [useRef<SVGEllipseElement>(null), useRef<SVGEllipseElement>(null), useRef<SVGEllipseElement>(null)];
  const liquid = useRef<Liquid | null>(null);
  if (!liquid.current) liquid.current = new Liquid(target);
  const drive = useRef({ target, music: 0, reach: true, through: false });
  drive.current.target = target;
  // The strip stays calm over full-screen video: no dancing to the music.
  drive.current.music = media?.playing && mode !== "strip" && mode !== "command" ? 1 : 0;
  drive.current.reach = mode !== "strip" && mode !== "tucked";
  drive.current.through = !!settings.through && !expanded && mode !== "ask" && !commandOpen;

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
        bands: bandsRef.current,
        cursor: c && drive.current.reach ? { x: c.x - cx, y: c.y } : null,
      });

      const d = L.path(cx);
      pathRef.current?.setAttribute("d", d);
      clipRef.current?.setAttribute("d", d);
      dropsRef.current?.setAttribute("d", L.dropsPath(cx));
      dropsRef.current?.setAttribute("opacity", L.dropsOpacity.toFixed(3));
      paintLight(L, cx, drive.current.target.h > 60, glowRef.current, blobRefs.map((r) => r.current));
      const box = boxRef.current;
      if (box) {
        box.style.width = `${L.w}px`;
        box.style.height = `${L.h}px`;
        box.style.borderRadius = `0 0 ${L.radius}px ${L.radius}px`;
      }

      animateBuddies(L, c && c.near ? c : null);
      const dots = dotsRef.current;
      if (dots) dots.style.left = `${cx + L.w / 2 + 7}px`;

      // Equaliser bars follow the same smoothed levels as the edge.
      const lv = L.levels;
      const bars = [0.6 * lv[0] + 0.4 * lv[1], lv[2], lv[3], 0.5 * (lv[4] + lv[5])];
      document.querySelectorAll<HTMLElement>(".bars.live").forEach((el) => {
        el.querySelectorAll<HTMLElement>("span").forEach((bar, i) => {
          bar.style.transform = `scaleY(${(0.22 + 0.78 * bars[i]).toFixed(3)})`;
        });
      });

      // Tell Rust which area should catch the mouse.
      const t = drive.current.target;
      const w = Math.max(L.w, t.w);
      const h = Math.max(L.h, t.h) + L.sag + 2;
      // Through mode: the folded island lets every click through and never opens on hover.
      const rect = drive.current.through ? { x: 0, y: 0, w: 0, h: 0 } : { x: cx - w / 2, y: 0, w, h };
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

  useEffect(() => kickRef.current(), [target, media?.playing, mode, settings.through]);

  // ---- input -------------------------------------------------------------
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      // Lists scroll in the other tabs; the wheel is volume only on the pill and Home.
      if (!api || !volume || commandOpen || (expanded && tab !== "home")) return;
      const step = e.deltaY > 0 ? -0.02 : 0.02;
      api.volumeStep(step);
      setVolume({ ...volume, level: Math.min(1, Math.max(0, volume.level + step)) });
    },
    [api, volume, expanded, tab, commandOpen],
  );

  const frame = (t: Tab, body: React.ReactNode) => (
    <View
      key={t}
      on={mode === "expanded" && tab === t}
      shape={sizeOf("expanded", { media: !!media, tab: t, fit: FIT.includes(t) ? fits[t] : undefined })}
      onMeasure={FIT.includes(t) ? measure(t) : undefined}
    >
      <div className={`expanded ${FIT.includes(t) ? "fit" : ""}`}>
        <Header battery={battery} tab={tab} setTab={setTab} />
        {body}
      </div>
    </View>
  );

  return (
    <div
      className="stage"
      style={{ opacity: (expanded || commandOpen ? (settings.openOpacity as number) ?? 1 : (settings.pillOpacity as number) ?? 1) as number }}
    >
      <div ref={glowRef} className="glow" style={{ "--a": accent, "--b": accent2 } as React.CSSProperties} />
      <svg className="body" width="100%" height="100%">
        <defs>
          <clipPath id="island-clip">
            <path ref={clipRef} />
          </clipPath>
          <radialGradient id="light-a">
            <stop offset="0" stopColor={accent} stopOpacity="1" />
            <stop offset="0.55" stopColor={accent} stopOpacity="0.35" />
            <stop offset="1" stopColor={accent} stopOpacity="0" />
          </radialGradient>
          <radialGradient id="light-b">
            <stop offset="0" stopColor={accent2} stopOpacity="1" />
            <stop offset="0.55" stopColor={accent2} stopOpacity="0.35" />
            <stop offset="1" stopColor={accent2} stopOpacity="0" />
          </radialGradient>
        </defs>
        <path ref={pathRef} className="shape" />
        <g clipPath="url(#island-clip)">
          <ellipse ref={blobRefs[0]} fill="url(#light-a)" opacity="0" />
          <ellipse ref={blobRefs[1]} fill="url(#light-b)" opacity="0" />
          <ellipse ref={blobRefs[2]} fill="url(#light-a)" opacity="0" />
        </g>
        <path ref={dropsRef} className="shape" />
      </svg>
      <div
        ref={dotsRef}
        className={`privacy ${mode === "tucked" || mode === "strip" || mode === "expanded" || mode === "command" ? "hide" : ""}`}
        title={[...privacy.cam.map((a) => `Камера: ${a}`), ...privacy.mic.map((a) => `Микрофон: ${a}`)].join("\n")}
      >
        {privacy.cam.length > 0 && <i className="cam" />}
        {privacy.mic.length > 0 && <i className={`mic ${privacy.micMuted ? "muted" : ""}`} />}
      </div>
      <div
        ref={boxRef}
        className={`box mode-${mode}`}
        onWheel={onWheel}
        onClick={() => {
          if (mode === "recording") {
            api?.call("record_toggle_cmd");
            return;
          }
          if (mode === "dictation") {
            api?.call("dictate_toggle");
            return;
          }
          if (mode === "card" && card?.kind === "reminder") return;
          if (mode === "card" && card?.open) {
            if (card.open.path) api?.call("open_path", { path: card.open.path });
            if (card.open.url) api?.call("open_url", { url: card.open.url });
            if (card.open.app) api?.call("app_launch", { id: card.open.app });
            if (card.open.reveal) api?.call("reveal_path", { path: card.open.reveal });
            setCard(null);
          } else if (card?.sticky) setCard(null);
          else if (!expanded) {
            setSuppressed(false);
            setPinned(true);
          }
        }}
      >
        <View on={mode === "idle"} shape={sizeOf("idle", { battery: !!battery, temp: !!weather && settings.weatherOnPill })}>
          <Idle battery={battery} sleeping={sleeping} weather={settings.weatherOnPill ? weather : null} />
        </View>
        {(["compact", "wide", "player", "lyrics"] as MusicPill[]).map((style) => (
          <View key={style} on={mode === "media" && target.w === sizeOf("media", { music: style }).w} shape={sizeOf("media", { music: style })}>
            {media && <CompactMedia media={media} accent={accent} live={live} style={style} api={api} lyrics={lyrics} />}
          </View>
        ))}
        <View on={mode === "dictation"} shape={sizeOf("dictation")}>
          {dictation && <DictationPill state={dictation.state} level={dictation.level} />}
        </View>
        <View on={mode === "recording"} shape={sizeOf("recording")}>
          {recording && <RecordingPill since={recording} />}
        </View>
        <View on={mode === "download"} shape={sizeOf("download")}>
          <DownloadPill list={downloads} />
        </View>
        <View on={mode === "hud"} shape={sizeOf("hud")}>
          {volume && <VolumeHud volume={volume} />}
        </View>
        <View on={mode === "timer"} shape={sizeOf("timer")}>
          <TimerPill timer={timer} />
        </View>
        <View on={mode === "card"} shape={sizeOf("card", { card })}>
          {card && <CardView card={card} onDone={() => setCard(null)} onSnooze={snooze} />}
        </View>
        {frame(
          "home",
          <HomeTab
            api={api}
            media={media}
            volume={volume}
            accent={accent}
            live={live}
            setVolume={setVolume}
            sleeping={sleeping}
            lyrics={lyrics}
            launcher={settings.launcher as Shortcut[]}
            setLauncher={(l) => setSetting({ launcher: l })}
            onTypeStart={takeFocus}
          />,
        )}
        {frame("clip", <ClipboardTab api={api} clips={clips} onUsed={dismiss} onTypeStart={takeFocus} />)}
        {frame("shelf", <ShelfTab api={api} items={shelf} setItems={setShelf} dragOver={dragOver} />)}
        {frame("note", <NoteTab api={api} timer={timer} onTypeStart={takeFocus} reminders={reminders} setReminders={setReminders} />)}
        {frame(
          "ai",
          <AiTab
            api={api}
            settings={settings}
            visible={mode === "expanded" && tab === "ai"}
            onTypeStart={takeFocus}
            ask={aiAsk}
            onAsked={() => setAiAsk(null)}
            openSettings={() => setTab("settings")}
          />,
        )}
        {frame(
          "weather",
          <WeatherTab
            api={api}
            weather={weather}
            onTypeStart={takeFocus}
            onPick={(p) => setSetting({ weatherCity: { name: p.name, lat: p.lat, lon: p.lon } })}
          />,
        )}
        {frame(
          "controls",
          <ControlsTab
            api={api}
            visible={mode === "expanded" && tab === "controls"}
            lastColor={((settings.colorHistory as string[] | undefined) ?? [])[0] ?? null}
            onTool={(m) => {
              dismiss();
              api?.call("capture_start", { mode: m });
            }}
            micMuted={privacy.micMuted}
            onMic={() =>
              api?.call<boolean | null>("mic_toggle").then((m) => {
                if (m === null || m === undefined) return;
                setPrivacy((p) => ({ ...p, micMuted: m }));
              })
            }
            onCopyColor={(c) => {
              navigator.clipboard?.writeText(c).catch(() => {});
              showCard({ kind: "capture", title: "Цвет скопирован", sub: c, swatch: c, ms: 2500 });
            }}
          />,
        )}
        {frame(
          "settings",
          <SettingsTab
            api={api}
            settings={settings}
            set={setSetting}
            visible={mode === "expanded" && tab === "settings"}
            onTypeStart={takeFocus}
          />,
        )}
        <View on={mode === "agent"} shape={sizeOf("agent")}>
          <AgentPill working={working} />
        </View>
        <View on={mode === "ask"} shape={sizeOf("ask")}>
          {ask && <AskCard ask={ask} onAnswer={answer} />}
        </View>
        <View on={mode === "command"} shape={sizeOf("command", { rows: 6 })} top>
          <CommandBar api={api} open={commandOpen} engine={settings.searchEngine} actions={commandActions} onCount={setCommandRows} />
        </View>
      </div>
    </div>
  );
}

/** Tabs whose panel takes the height of its content. */
const FIT: Tab[] = ["home", "controls", "weather"];

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "home", label: "Главная", icon: <TabHome /> },
  { id: "clip", label: "Буфер", icon: <TabClip /> },
  { id: "shelf", label: "Полка", icon: <TabShelf /> },
  { id: "note", label: "Заметка и таймер", icon: <TabNote /> },
  { id: "weather", label: "Погода", icon: <TabWeather /> },
  { id: "ai", label: "ИИ: чат и текст", icon: <TabAi /> },
  { id: "controls", label: "Управление", icon: <TabControls /> },
  { id: "settings", label: "Настройки", icon: <TabSettings /> },
];

function Header({ battery, tab, setTab }: { battery: Battery | null; tab: Tab; setTab: (t: Tab) => void }) {
  const now = useClock();
  return (
    <header>
      <span className="clock" title={dateFmt.format(now)}>
        {timeFmt.format(now)}
      </span>
      <span className="grow" />
      {battery && (
        <span className="battery">
          <span className="pct">{battery.percent}%</span>
          <BatteryIcon {...battery} />
        </span>
      )}
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "on" : ""}
            aria-label={t.label}
            title={t.label}
            onClick={(e) => {
              e.stopPropagation();
              setTab(t.id);
            }}
          >
            {t.icon}
          </button>
        ))}
      </nav>
    </header>
  );
}

function TimerPill({ timer }: { timer: ReturnType<typeof useTimer> }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!timer.running) return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [timer.running]);
  const left = remaining(timer.state);
  return (
    <div className="compact timer-pill">
      <Ring size={18} progress={timer.state.total ? left / timer.state.total : 0} color="#ff9f43" />
      <Buddy size={22} />
      <span className={`time ${timer.running ? "" : "paused"}`}>{fmtClock(left)}</span>
    </div>
  );
}

function CardView({ card, onDone, onSnooze }: { card: Card; onDone: () => void; onSnooze: (r: Reminder) => void }) {
  if (card.kind === "reminder" && card.reminder) {
    const r = card.reminder;
    return (
      <div className="reminder-card" key={card.key}>
        <div className="rc-head">
          <Buddy size={28} mood="ask" />
          <div className="agent-text">
            <div className="card-title">Напоминание</div>
            <div className="rc-text">{r.text}</div>
          </div>
        </div>
        <div className="ask-buttons">
          <button className="text-btn" onClick={(e) => (e.stopPropagation(), onSnooze(r))}>
            Через 10 минут
          </button>
          <button className="text-btn solid accent" onClick={(e) => (e.stopPropagation(), onDone())}>
            Готово
          </button>
        </div>
      </div>
    );
  }
  if (card.kind === "capture" || card.kind === "notify") {
    return (
      <div className={`compact card card-agent ${card.open ? "clickable" : ""}`} key={card.key}>
        {card.thumb ? (
          <img className="card-thumb" src={card.thumb} alt="" />
        ) : card.swatch ? (
          <span className="card-swatch" style={{ background: card.swatch }} />
        ) : (
          <span className="card-icon">{card.kind === "notify" ? <BellIcon /> : <TabClip size={20} />}</span>
        )}
        <div className="agent-text">
          <div className="card-title">{card.title}</div>
          {card.sub && <div className="agent-sub">{card.sub}</div>}
        </div>
        {card.open && <span className="card-open">{card.open.reveal ? "Показать" : "Открыть"}</span>}
      </div>
    );
  }
  if (card.kind === "agent") {
    return (
      <div className="compact card card-agent" key={card.key}>
        <Buddy size={30} mood={card.mood ?? null} />
        <div className="agent-text">
          <div className="card-title">{card.title}</div>
          {card.sub && <div className="agent-sub">{card.sub}</div>}
        </div>
      </div>
    );
  }
  const icon =
    card.kind === "caps" ? <CapsIcon /> : card.kind === "layout" ? <GlobeIcon /> : card.kind === "timer" ? <TimerIcon /> : null;
  return (
    <div className={`compact card card-${card.kind}`} key={card.key}>
      <span className="card-icon">{icon}</span>
      <span className="card-title">{card.title}</span>
      <span className="card-sub">{card.sub}</span>
    </div>
  );
}

/**
 * Light inside and around the island, in the colours of the album art:
 * three soft blobs drift along the lower edge like a lava lamp, each glowing
 * with its own part of the sound (bass, mids, highs), and a halo below the
 * island breathes with the music and flares on beats.
 */
function paintLight(
  L: Liquid,
  cx: number,
  tall: boolean,
  glow: HTMLDivElement | null,
  blobs: (SVGEllipseElement | null)[],
) {
  const m = L.music;
  const lv = L.levels;
  const parts = [0.6 * lv[0] + 0.4 * lv[1], 0.5 * (lv[2] + lv[3]), 0.5 * (lv[4] + lv[5])];
  const half = L.w / 2;
  const reach = Math.max(0, half - 26);
  const speeds = [0.11, 0.17, 0.23];
  const phases = [0, 2.1, 4.2];
  // A small pill is mostly light already, and an open panel is for reading:
  // keep both subtler than the island's edge itself.
  const k = tall ? 0.5 : 0.7;
  blobs.forEach((el, i) => {
    if (!el) return;
    const level = parts[i];
    const x = cx + reach * 0.8 * Math.sin(L.t * speeds[i] * Math.PI * 2 + phases[i]);
    const rx = Math.min(L.w * 0.36, 130) * (0.85 + 0.3 * level);
    const ry = (tall ? 26 : 18) + 16 * level + 6 * L.beat;
    el.setAttribute("cx", x.toFixed(1));
    el.setAttribute("cy", (L.h + 6).toFixed(1));
    el.setAttribute("rx", rx.toFixed(1));
    el.setAttribute("ry", ry.toFixed(1));
    el.setAttribute("opacity", (m * k * (0.12 + 0.55 * level + 0.2 * L.beat)).toFixed(3));
  });
  if (glow) {
    const e = L.energy;
    glow.style.width = `${L.w * 0.86}px`;
    glow.style.top = `${L.h - 26}px`;
    glow.style.left = `${cx}px`;
    glow.style.opacity = Math.min(1, m * (0.18 + 0.6 * e + 0.35 * L.beat)).toFixed(3);
    glow.style.transform = `translateX(-50%) scale(${(1 + 0.08 * e + 0.12 * L.beat).toFixed(3)})`;
  }
}

/** A view is laid out at its final size and revealed by the growing body. */
function View({
  on,
  shape,
  children,
  top,
  onMeasure,
}: {
  on: boolean;
  shape: Shape;
  children: React.ReactNode;
  top?: boolean;
  onMeasure?: (h: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el || !onMeasure) return;
    const ro = new ResizeObserver(() => onMeasure(el.getBoundingClientRect().height));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onMeasure]);
  return (
    <div
      ref={ref}
      className={`view ${on ? "on" : ""}`}
      style={{ width: shape.w, height: top || onMeasure ? undefined : shape.h }}
      aria-hidden={!on}
    >
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
const dateFmt = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });

function Idle({ battery, sleeping, weather }: { battery: Battery | null; sleeping: boolean; weather: Weather | null }) {
  const now = useClock();
  const cur = weather?.points.length
    ? weather.points.reduce((b, p) => (Math.abs(p.t - now.getTime()) < Math.abs(b.t - now.getTime()) ? p : b))
    : null;
  return (
    <div className={`idle ${battery ? "with-battery" : ""}`}>
      <Buddy sleeping={sleeping} />
      <span className="time">{timeFmt.format(now)}</span>
      {cur && (
        <span className="pill-temp" title={weather?.city}>
          <WeatherIcon symbol={cur.symbol} size={17} />
          {fmtTemp(cur.temp)}
        </span>
      )}
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

function usePosition(media: Media, every = 500) {
  const now = useClock(every);
  return Math.min(media.durationMs || Infinity, media.positionMs + (media.playing ? now.getTime() - media.updatedAtMs : 0));
}

/** The pill while music plays: compact, wide (title + thin bar), mini player, or the current lyric line. */
function CompactMedia({
  media,
  accent,
  live,
  style,
  api,
  lyrics,
}: {
  media: Media;
  accent: string;
  live: boolean;
  style: MusicPill;
  api: Bridge | null;
  lyrics: Line[] | null;
}) {
  const pos = usePosition(media, style === "lyrics" ? 200 : 1000);
  const progress = media.durationMs ? pos / media.durationMs : 0;
  if (style === "compact") {
    return (
      <div className="compact">
        <Cover src={media.cover} size={22} radius={6} />
        <Buddy />
        <Bars playing={media.playing} live={live} color={accent} />
      </div>
    );
  }
  if (style === "player") {
    return (
      <div className="compact mini-player">
        <Cover src={media.cover} size={28} radius={7} />
        <div className="mp-text">
          <div className="mp-title">{media.title}</div>
          <div className="mp-bar">
            <i style={{ width: `${progress * 100}%`, background: accent }} />
          </div>
        </div>
        <button aria-label="Предыдущий" onClick={(e) => (e.stopPropagation(), api?.media("prev"))}>
          <Prev size={16} />
        </button>
        <button aria-label="Пауза" onClick={(e) => (e.stopPropagation(), api?.media("toggle"))}>
          {media.playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button aria-label="Следующий" onClick={(e) => (e.stopPropagation(), api?.media("next"))}>
          <Next size={16} />
        </button>
      </div>
    );
  }
  const i = style === "lyrics" && lyrics?.length ? lineAt(lyrics, pos) : -1;
  const line = i >= 0 ? lyrics![i].text || "♪" : null;
  return (
    <div className="compact wide-media">
      <Cover src={media.cover} size={24} radius={6} />
      <div className="mp-text">
        {line !== null ? (
          <div className="mp-lyric" key={i}>
            {line}
          </div>
        ) : (
          <div className="mp-title">
            {media.title}
            {media.artist ? <span className="muted"> · {media.artist}</span> : null}
          </div>
        )}
        <div className="mp-bar">
          <i style={{ width: `${progress * 100}%`, background: accent }} />
        </div>
      </div>
      <Bars playing={media.playing} live={live} color={accent} />
    </div>
  );
}

function DownloadPill({ list }: { list: { name: string; size: number; speed: number }[] }) {
  const first = list[0];
  if (!first) return null;
  const mb = (b: number) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} ГБ` : `${(b / (1 << 20)).toFixed(1)} МБ`);
  return (
    <div className="compact download-pill">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7fd0ff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 4v11M7 10.5 12 15.5l5-5M5 20h14" />
      </svg>
      <span className="dl-name">{list.length > 1 ? `Загрузок: ${list.length}` : first.name}</span>
      <span className="dl-size">
        {mb(first.size)}
        {first.speed > 0 ? ` · ${mb(first.speed)}/с` : ""}
      </span>
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

function HomeTab({
  api,
  media,
  volume,
  accent,
  live,
  setVolume,
  sleeping,
  lyrics,
  launcher,
  setLauncher,
  onTypeStart,
}: {
  api: Bridge | null;
  media: Media | null;
  volume: Volume | null;
  accent: string;
  live: boolean;
  setVolume: (v: Volume) => void;
  sleeping: boolean;
  lyrics: Line[] | null;
  launcher: Shortcut[];
  setLauncher: (l: Shortcut[]) => void;
  onTypeStart: () => void;
}) {
  const now = useClock(500);
  const pos = media
    ? Math.min(media.durationMs, media.positionMs + (media.playing ? now.getTime() - media.updatedAtMs : 0))
    : 0;
  const progress = media && media.durationMs > 0 ? pos / media.durationMs : 0;

  return (
    <>
      {media ? (
        <>
          <div className="track-info">
            <Cover src={media.cover} size={52} radius={12} />
            <div className="titles">
              <div className="title" title={media.title}>
                {media.title}
              </div>
              {lyrics?.length && lineAt(lyrics, pos) >= 0 ? (
                <div className="artist lyric-line" key={lineAt(lyrics, pos)}>
                  {lyrics[lineAt(lyrics, pos)].text || "♪"}
                </div>
              ) : (
                <div className="artist" title={media.artist}>
                  {media.artist || appName(media.app)}
                </div>
              )}
            </div>
            <Bars playing={media.playing} live={live} color={accent} height={18} />
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
          <Buddy size={34} sleeping={sleeping} />
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
      <Launcher api={api} items={launcher} setItems={setLauncher} onTypeStart={onTypeStart} />
    </>
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

function AgentPill({ working }: { working: Record<string, AgentEvent & { at: number }> }) {
  const list = Object.values(working);
  const first = list[0];
  const name = first?.agent === "codex" ? "Codex" : "Claude";
  return (
    <div className="compact agent-pill">
      <Buddy size={24} mood="work" />
      <span className="agent-label">
        {list.length > 1 ? `Агентов работает: ${list.length}` : `${name} работает`}
        {list.length === 1 && first.project ? <span className="agent-project"> · {first.project}</span> : null}
      </span>
      <span className="dots">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

function AskCard({ ask, onAnswer }: { ask: AgentEvent; onAnswer: (allow: boolean) => void }) {
  const [left, setLeft] = useState(ask.seconds);
  useEffect(() => {
    setLeft(ask.seconds);
    const t0 = Date.now();
    const id = window.setInterval(() => setLeft(Math.max(0, ask.seconds - Math.floor((Date.now() - t0) / 1000))), 250);
    return () => clearInterval(id);
  }, [ask]);
  const name = ask.agent === "codex" ? "Codex" : "Claude";
  return (
    <div className="ask">
      <div className="ask-head">
        <Buddy size={28} mood="ask" />
        <div className="ask-title">
          {name} просит разрешение{ask.project ? <span className="agent-project"> · {ask.project}</span> : null}
        </div>
        <Ring size={20} progress={ask.seconds ? left / ask.seconds : 0} color="#d97757" />
      </div>
      <div className="ask-detail">{ask.detail}</div>
      <div className="ask-buttons">
        <button className="text-btn" onClick={(e) => (e.stopPropagation(), onAnswer(false))}>
          Запретить
        </button>
        <button className="text-btn solid accent" onClick={(e) => (e.stopPropagation(), onAnswer(true))}>
          Разрешить
        </button>
      </div>
    </div>
  );
}

function DictationPill({ state, level }: { state: string; level: number }) {
  return (
    <div className="compact dictation-pill" title="Клик или Ctrl+Alt+D — закончить">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff6b5e" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <rect x="9" y="3" width="6" height="11" rx="3" fill="#ff6b5e" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      </svg>
      <span className="dl-name">{state === "busy" ? "Распознаю…" : "Говори…"}</span>
      {state === "rec" && (
        <span className="level">
          {[0.5, 0.8, 1, 0.8, 0.5].map((k, i) => (
            <i key={i} style={{ transform: `scaleY(${(0.15 + 0.85 * Math.min(1, level * k * 1.3)).toFixed(2)})` }} />
          ))}
        </span>
      )}
    </div>
  );
}

function RecordingPill({ since }: { since: number }) {
  const now = useClock(500);
  const s = Math.max(0, Math.floor((now.getTime() - since) / 1000));
  return (
    <div className="compact recording-pill" title="Клик — остановить (Ctrl+Alt+R)">
      <span className="rec-dot" />
      <span className="time">
        {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      </span>
      <span className="muted">стоп</span>
    </div>
  );
}
