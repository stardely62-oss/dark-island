import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { CommandBar, commandHeight } from "./panels/CommandBar";
import { applyTheme, useSettings, type Shortcut } from "./settings";
import { WeatherTab } from "./panels/Weather";
import { Launcher, useLauncherHotkeys } from "./panels/Launcher";
import { AiTab } from "./panels/Ai";
import { nextRepeat, type Reminder } from "./reminders";
import { describe, fmtTemp, rainSoon, type Weather } from "./weather";
import { WeatherIcon } from "./components/WeatherIcon";
import { lineAt, parseLrc, type Line } from "./lyrics";
import { fmtClock, remaining, useTimer } from "./timer";
import { chime } from "./chime";
import { Bars } from "./components/Bars";
import { BREAK_MOVES, BreakScene, MOVE_MS, PartyScene, StickerScene } from "./components/Party";
import { lang, setLang, locale } from "./i18n";
import { Buddy, animateBuddies, birthdayToday, buddy, buddyAge, climbOut, sfx, usePet, type Mood } from "./components/Buddy";
import { shiftHue, useAccent } from "./accent";

import { t } from "./i18n";
type Mode = "idle" | "media" | "hud" | "expanded" | "strip" | "card" | "timer" | "command" | "ask" | "agent" | "tucked" | "download" | "dictation" | "recording" | "obs" | "party";
type Tab = "home" | "clip" | "shelf" | "note" | "weather" | "ai" | "controls" | "settings";
type MusicPill = "compact" | "wide" | "player" | "lyrics" | "line";
type Pomo = { phase: "work" | "rest"; round: number };
type Card = {
  key: number;
  kind: "caps" | "layout" | "timer" | "info" | "agent" | "capture" | "notify" | "reminder" | "tour";
  /** For the tour: which step. */
  step?: number;
  reminder?: Reminder;
  thumb?: string | null;
  swatch?: string;
  /** What a click on the card does. */
  open?: { scene?: "party" | "break" | "sticker"; minutes?: number; sticker?: { title: string; hint: string; icon: string; color: string }; path?: string; url?: string; app?: string; reveal?: string; translate?: string; settings?: string; tab?: Tab };
  title: string;
  sub?: string;
  sticky?: boolean;
  /** Shown even while the island is hidden over a game (the good-luck wish). */
  peek?: boolean;
  /** What Klodik does while the card is up (he takes the icon's place). */
  act?: string;
  /** A small animated picture instead of the icon. */
  anim?: string;
  /** A camera flash over the card. */
  flash?: boolean;
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
    pomo?: boolean;
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
    case "obs":
      return { w: 210, h: 32 };
    case "command":
      return { w: 560, h: commandHeight(opts.rows ?? 0) };
    case "ask":
      return { w: 410, h: 116 };
    case "party":
      return { w: 440, h: 196 };
    case "agent":
      return { w: 300, h: 34 };
    case "expanded":
      if (opts.fit) return { w: PANEL_W, h: Math.min(340, Math.max(120, Math.ceil(opts.fit))) };
      // The AI tab has the most to show: a bit taller.
      if (opts.tab === "ai") return { w: PANEL_W, h: 316 };
      if (opts.tab && opts.tab !== "home") return { w: PANEL_W, h: 286 };
      return opts.media ? { w: PANEL_W, h: opts.launcher ? 292 : 246 } : { w: PANEL_W, h: opts.launcher ? 212 : 168 };
    case "strip":
      return { w: 150, h: 5 };
    case "card":
      return opts.card?.kind === "tour"
        ? { w: 430, h: 104 }
        : opts.card?.kind === "reminder"
        ? { w: 400, h: 92 }
        : opts.card?.kind === "agent" || opts.card?.kind === "capture" || opts.card?.kind === "notify"
        ? { w: 380, h: 60 }
        : // A one-line card grows with its words, up to a point.
          { w: Math.round(Math.min(470, Math.max(250, (opts.card?.act ? 84 : 60) + ((opts.card?.title.length ?? 0) + (opts.card?.sub?.length ?? 0)) * 7.4))), h: 34 };
    case "timer":
      return { w: opts.pomo ? 236 : 172, h: 32 };
    case "media":
      return opts.music === "wide"
        ? { w: 340, h: 38 }
        : opts.music === "player"
          ? { w: 360, h: 44 }
          : opts.music === "lyrics"
            ? { w: 410, h: 38 }
            : opts.music === "line"
              ? { w: 380, h: 32 }
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
  const hoverOpenRef = useRef(false);
  hoverOpenRef.current = hoverOpen;
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
  const presenceRef = useRef<Presence>("normal");
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
  const launcherFailed = useLauncherHotkeys(api, settings.launcher as Shortcut[]);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [privacy, setPrivacy] = useState<{ mic: string[]; cam: string[]; micMuted: boolean }>({ mic: [], cam: [], micMuted: false });
  const privacyRef = useRef<{ mic: string[]; cam: string[]; micMuted: boolean }>({ mic: [], cam: [], micMuted: false });
  const [downloads, setDownloads] = useState<{ name: string; size: number; speed: number; total: number }[]>([]);
  const obsLive = useRef(false);
  const [obs, setObs] = useState<{ recording: boolean; streaming: boolean; paused: boolean; since: number } | null>(null);
  const [foreground, setForeground] = useState("");
  const [lyrics, setLyrics] = useState<Line[] | null>(null);
  const musicPill = settings.musicPill as MusicPill;
  const [dictation, setDictation] = useState<{ state: string; level: number } | null>(null);
  const [recording, setRecording] = useState<number | null>(null);
  const [aiAsk, setAiAsk] = useState<string | null>(null);
  const [aiTool, setAiTool] = useState<{ text: string; action: "translate" } | null>(null);
  const reminders = (settings.reminders as Reminder[] | undefined) ?? [];
  useEffect(() => applyTheme((settings.islandTheme as string) ?? "dark"), [settings.islandTheme]);
  useEffect(
    () =>
      buddy.configure({
        life: settings.buddyLife,
        color: settings.buddyColor,
        hat: settings.buddyHat,
        name: settings.buddyName || t("Клодик"),
        sounds: settings.buddySounds,
        birthday: (settings.userBirthday as string) ?? "",
      }),
    [settings.buddyLife, settings.buddyColor, settings.buddyHat, settings.buddyName, settings.buddySounds, settings.userBirthday],
  );
  const buddyScale = settings.buddyScale;
  useEffect(() => document.documentElement.style.setProperty("--bd-size", `${Math.round(20 * buddyScale)}px`), [buddyScale]);
  const cardScale = settings.cardLength === "short" ? 0.7 : settings.cardLength === "long" ? 1.8 : 1;
  const cardScaleRef = useRef(cardScale);
  cardScaleRef.current = cardScale;
  const sleeping = away && !media?.playing;
  const accent = useAccent(media?.cover ?? null) ?? DEFAULT_ACCENT;
  const accent2 = useMemo(() => shiftHue(accent, 45), [accent]);

  const cardTimer = useRef<number>(0);
  // While the tour is on screen, other cards wait their turn instead of pushing it away.
  const touring = useRef(false);
  const waiting = useRef<Omit<Card, "key">[]>([]);
  const cardRef = useRef<Card | null>(null);
  const downloadsRef = useRef(0);
  // When the island last went away into a game (for the good-luck wish).
  const gameWish = useRef(0);
  const actionable = (c: Omit<Card, "key"> | null) =>
    !!c && (!!c.open || c.kind === "agent" || c.kind === "reminder" || c.kind === "tour");
  const showCard = useCallback((c: Omit<Card, "key">) => {
    // A card you can act on is not pushed away by a plain message: that waits.
    if ((touring.current && c.kind !== "tour") || (actionable(cardRef.current) && !actionable(c))) {
      waiting.current.push(c);
      return;
    }
    clearTimeout(cardTimer.current);
    if (c.act) buddy.act(c.act, c.sticky ? 6000 : Math.min(c.ms ?? 3000, 4200));
    // The timer starts once the card is on screen (see below): behind an
    // open island it would run out unseen.
    setCard({ ...c, key: Date.now() });
  }, []);

  // The birthday show in the open island (a hover on the birthday card starts it).
  // A scene in the open island: the birthday show or the break warm-up
  // (a hover on their card starts it).
  const [scene, setScene] = useState<{
    kind: "party" | "break" | "sticker";
    key: number;
    minutes: number;
    sticker?: { title: string; hint: string; icon: string; color: string };
  } | null>(null);
  const party = scene?.key ?? 0;
  const [brkStep, setBrkStep] = useState(0);
  const startScene = (open: Card["open"]) =>
    open?.scene && setScene({ kind: open.scene, key: Date.now(), minutes: open.minutes ?? 0, sticker: open.sticker });
  useEffect(() => {
    if (!scene) return;
    setBrkStep(0);
    const long = scene.kind === "break" ? BREAK_MOVES * MOVE_MS + 4000 : scene.kind === "sticker" ? 7500 : 10_500;
    const t = window.setTimeout(() => setScene(null), long);
    const steps =
      scene.kind === "break" ? window.setInterval(() => setBrkStep((n) => Math.min(n + 1, BREAK_MOVES - 1)), MOVE_MS) : 0;
    return () => {
      clearTimeout(t);
      clearInterval(steps);
    };
  }, [scene]);

  const timerRef = useRef<ReturnType<typeof useTimer>>(null!);
  // ---- pomodoro: 25 minutes of work, 5 of rest (15 after every fourth) ----
  const [pomo, setPomoState] = useState<Pomo | null>(() => {
    try {
      return JSON.parse(localStorage.getItem("island.pomo") ?? "null");
    } catch {
      return null;
    }
  });
  const pomoRef = useRef(pomo);
  const setPomo = useCallback((p: Pomo | null) => {
    pomoRef.current = p;
    setPomoState(p);
    buddy.setFocus(p?.phase ?? null);
    try {
      localStorage.setItem("island.pomo", JSON.stringify(p));
    } catch {
      /* no storage */
    }
  }, []);
  const timer = useTimer((total) => {
    chime();
    const p = pomoRef.current;
    if (p) {
      if (p.phase === "work") {
        buddy.count("pomodoro");
        const rest = p.round % 4 === 0 ? 15 : 5;
        setPomo({ phase: "rest", round: p.round });
        timerRef.current.start(rest * 60_000);
        buddy.act("coffee", 4000);
        showCard({ kind: "info", title: t("Помидор {0} готов", p.round), sub: t("Перерыв {0} минут — встань, потянись", rest), ms: 6000 });
      } else {
        setPomo({ phase: "work", round: p.round + 1 });
        timerRef.current.start(25 * 60_000);
        buddy.act("laptop", 4400);
        showCard({ kind: "info", title: t("За работу"), sub: t("Помидор {0}: 25 минут", p.round + 1), ms: 5000 });
      }
      return;
    }
    buddy.react("excited", 3000);
    showCard({ kind: "timer", title: t("Таймер"), sub: t("{0} — готово", fmtClock(total)), sticky: true, act: "alarm" });
    window.setTimeout(chime, 2500);
  });
  useEffect(() => buddy.setFocus(pomoRef.current?.phase ?? null), []);
  // A reset or a fresh timer by hand ends the pomodoro.
  useEffect(() => {
    if (!timer.active && pomoRef.current) setPomo(null);
  }, [timer.active, setPomo]);
  const pomodoro = useCallback(
    (on: boolean) => {
      if (on) {
        setPomo({ phase: "work", round: 1 });
        timerRef.current.start(25 * 60_000);
        buddy.act("laptop", 4400);
        showCard({ kind: "info", title: t("Помодоро"), sub: t("25 минут работы, потом перерыв"), ms: 3500 });
      } else {
        setPomo(null);
        timerRef.current.reset();
      }
    },
    [setPomo, showCard],
  );

  timerRef.current = timer;
  const expanded = (hoverOpen && !suppressed) || pinned;
  const agentBusy = Object.keys(working).length > 0;
  const tucked =
    !commandOpen &&
    (settings.autoHide || (foreground !== "" && (settings.hideForApps as string[]).some((a) => a.toLowerCase().replace(/\.exe$/, "") === foreground)));
  // Where cards may appear. Important ones (downloads, agents, AI answers,
  // reminders, timers, notifications) follow the setting: over everything,
  // over ordinary apps (not over games) or only when nothing covers the top
  // of the screen. Small ones (Caps Lock, layout…) never show over a game.
  const important = !!card && ["agent", "capture", "notify", "reminder", "timer", "tour"].includes(card.kind);
  const level = (settings.cardsOver as string) ?? "all";
  const cardAllowed =
    !!card &&
    (card.peek ||
    (important
      ? level === "all" || (level === "apps" && presence !== "hidden") || (level === "desktop" && presence === "normal")
      : presence !== "hidden"));
  const mode: Mode = commandOpen
    ? "command"
    : party
      ? "party"
      : expanded
      ? "expanded"
      : ask
        ? "ask"
        : card && cardAllowed
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
                  : obs
                  ? "obs"
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
        music: (musicPill === "lyrics" || musicPill === "line") && !lyrics?.length ? "wide" : musicPill,
        temp: !!weather && settings.weatherOnPill,
        launcher: launcherOn,
        fit: FIT.includes(tab) ? fits[tab] : undefined,
        pomo: !!pomo,
      }),
    [mode, media, battery, tab, commandRows, card, musicPill, lyrics, weather, settings.weatherOnPill, launcherOn, fits, pomo],
  );

  // ---- data from the system --------------------------------------------
  const cursorRef = useRef<Cursor | null>(null);
  const lastVisit = useRef(Date.now());
  const kickRef = useRef<() => void>(() => {});
  const hudTimer = useRef<number>(0);
  const knownVolume = useRef<Volume | null>(null);
  const bandsRef = useRef<number[]>([0, 0, 0, 0, 0, 0]);
  const lastBands = useRef("");
  const sameBands = useRef(0);
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
        b.on("presence", (p) => {
          // Into a game: he waves good luck before the island goes away —
          // once per gaming stretch, not on every Alt+Tab back into it.
          if (p === "hidden" && presenceRef.current !== "hidden") {
            const now = Date.now();
            if (now - gameWish.current > 15 * 60_000 && !actionable(cardRef.current)) {
              buddy.act("wave", 1500);
              buddy.count("game");
              showCard({ kind: "info", title: t("Удачи в игре!"), sub: buddy.look.name + t(" подождёт тут"), ms: 1400, peek: true });
            }
            gameWish.current = now;
          }
          // Out of the game (Alt+Tab): a wish not yet shown is no longer wanted.
          if (p !== "hidden") {
            waiting.current = waiting.current.filter((c) => !c.peek);
            setCard((c) => (c?.peek ? null : c));
            // Back after a real stretch of play: he waves hello.
            if (presenceRef.current === "hidden" && Date.now() - gameWish.current > 5 * 60_000)
              showCard({ kind: "info", title: t("С возвращением!"), sub: t("{0} скучал", buddy.look.name), ms: 2600, act: "wave" });
          }
          presenceRef.current = p;
          setPresence(p);
        }),
        b.on("away", setAway),
        b.on("clips", (c) => {
          setClips(c);
          buddy.act("paper", 4200); // he files the new copy away
        }),
        b.on("volume", (v) => {
          const before = knownVolume.current;
          knownVolume.current = v;
          setVolume(v);
          // Turned all the way up: he covers his ears.
          if (before && v && v.level >= 0.99 && before.level < 0.99 && !v.muted) buddy.react("ears", 1600);
          if (before && v && (before.level !== v.level || before.muted !== v.muted)) {
            setHud(true);
            clearTimeout(hudTimer.current);
            hudTimer.current = window.setTimeout(() => setHud(false), HUD_MS);
          }
        }),
        b.on("audio", (bands) => {
          // The very same levels again and again are not live sound (a stuck
          // stream): after a second of that the bars go back to their own loop.
          const key = bands.map((v) => v.toFixed(4)).join();
          sameBands.current = key === lastBands.current ? sameBands.current + 1 : 0;
          lastBands.current = key;
          if (sameBands.current > 30) {
            bandsRef.current = bands.map(() => 0);
            return;
          }
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
          if (c.near || c.inside) lastVisit.current = Date.now();
          setHovered(c.inside);
          kickRef.current();
        }),
        b.on("keys", (k) => {
          if (expandedRef.current) return;
          if (k.what === "caps") showCard({ kind: "caps", title: "Caps Lock", sub: k.caps ? t("включён") : t("выключен"), anim: k.caps ? "caps-on" : "caps-off" });
          else if (k.layout) showCard({ kind: "layout", title: t("Раскладка"), sub: k.layout, anim: "layout" });
        }),
        b.on("agent", (e) => onAgentRef.current(e)),
        b.on("weather", setWeather),
        b.on("dictation", (d) => {
          if (d.state === "rec" || d.state === "busy") setDictation({ state: d.state, level: d.level ?? 0 });
          else {
            setDictation(null);
            if (d.state === "done") {
              // Into the chat box, or it was pasted where the cursor was.
              if (d.target === "chat") window.dispatchEvent(new CustomEvent("chat-dictation", { detail: d.text ?? "" }));
              else showCard({ kind: "capture", title: t("Текст вставлен"), sub: d.text, ms: 3500 });
            } else if (d.privacy) {
              showCard({ kind: "capture", title: t("Диктовка Windows выключена"), sub: t("Открыть параметры конфиденциальности речи"), open: { settings: "speech" }, ms: 8000 });
            } else {
              buddy.react("angry", 1800);
              showCard({ kind: "info", title: t("Диктовка"), sub: d.text ?? t("ошибка"), ms: 3500 });
            }
          }
        }),
        b.on("recording", (r) => {
          if (r.on) setRecording(Date.now());
          else {
            setRecording(null);
            if (r.path) showCard({ kind: "capture", title: t("Запись сохранена"), sub: r.path.split(/[\\/]/).pop(), open: { reveal: r.path }, ms: 5000, act: "clapper" });
            else if (r.error) showCard({ kind: "info", title: t("Запись экрана"), sub: r.error, ms: 4000 });
          }
        }),
        b.on("privacy", (p) => {
          // A card when a program starts using the microphone or the camera.
          const before = privacyRef.current;
          const pretty = (a: string) => (/dark-island/i.test(a) ? t("сам остров") : a.replace(/\.exe$/i, ""));
          const fresh = [
            ...p.cam.filter((a) => !before.cam.includes(a)).map((a) => [t("Камеру включил"), pretty(a)]),
            ...p.mic.filter((a) => !before.mic.includes(a)).map((a) => [t("Микрофон слушает"), pretty(a)]),
          ];
          if (fresh.length) showCard({ kind: "info", title: fresh[0][0], sub: fresh[0][1], ms: 3500 });
          privacyRef.current = p;
          setPrivacy(p);
        }),
        b.on("foreground", setForeground),
        b.on("downloads", (list) => {
          // A download begins: he catches the file.
          if (list.length && !downloadsRef.current) buddy.act("catch", 1600);
          downloadsRef.current = list.length;
          setDownloads(list);
        }),
        b.on("tour", () => window.dispatchEvent(new Event("island-tour"))),
        b.on("obs", (o) => {
          const live = o.recording || o.streaming;
          if (live !== obsLive.current) buddy.react(live ? "surprised" : "happy", 1100);
          obsLive.current = live;
          setObs((prev) =>
            live ? { recording: o.recording, streaming: o.streaming, paused: o.paused, since: prev?.since ?? Date.now() } : null,
          );
        }),
        b.on("download_done", (d) =>
          showCard({ kind: "capture", title: t("Загружено"), sub: d.name, open: { reveal: d.path }, ms: 5000, act: "box" }),
        ),
        b.on("mic_muted", (m) => {
          setPrivacy((p) => ({ ...p, micMuted: m }));
          showCard({ kind: "info", title: t("Микрофон"), sub: m ? t("выключен") : t("включён"), act: m ? "hush" : undefined, ms: m ? 2200 : undefined });
        }),
        b.on("vpn", (v) =>
          showCard({
            kind: "info",
            title: v.on ? t("VPN включён") : t("VPN выключен"),
            sub: v.on ? [v.country, v.ip].filter(Boolean).join(" · ") || v.name || "" : "",
            ms: v.on ? 3200 : 2500,
            act: v.on && !v.country ? "shades" : undefined,
          }),
        ),
        b.on("notification", (n) =>
          (buddy.react("surprised", 1200), showCard)({
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
          if (r.kind === "text" || r.kind === "qr") buddy.act("magnify", 4600);
          const first = r.text.split("\n")[0];
          if (r.kind === "shot")
            showCard({ kind: "capture", title: t("Снимок готов"), sub: r.text, thumb: r.thumb, open: r.path ? { path: r.path } : undefined, ms: 4000, act: "camera", flash: true });
          else if (r.kind === "text")
            showCard({ kind: "capture", title: t("Текст скопирован"), sub: first, open: { translate: r.text }, ms: 6000 });
          else if (r.kind === "qr")
            showCard({
              kind: "capture",
              title: t("QR-код скопирован"),
              sub: first,
              open: /^https?:\/\//.test(r.text) ? { url: r.text } : undefined,
              ms: 5000,
            });
          else if (r.kind === "link")
            showCard({ kind: "capture", title: t("Ссылка скопирована"), sub: r.text, open: { url: r.text }, ms: 5000 });
          else if (r.kind === "color") {
            document.documentElement.style.setProperty("--bd-paint", r.text);
            showCard({ kind: "capture", title: t("Цвет скопирован"), sub: r.text, swatch: r.text, ms: 3000, act: "paint" });
          }
          else {
            buddy.react("angry", 1800);
            showCard({ kind: "info", title: t("Снимок"), sub: r.text });
          }
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
      presenceRef.current = s.presence;
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
    showCard({ kind: "info", title: t("Сквозной режим"), sub: on ? t("включён") : t("выключен") });
  };

  // Song lyrics, only for the song that plays and only when turned on.
  const songKey = media && (settings.lyrics || musicPill === "lyrics" || musicPill === "line") ? `${media.artist}\u0001${media.title}` : "";
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
      buddy.react("excited", 3000);
      showCard({ kind: "reminder", title: t("Напоминание"), sub: due.text, sticky: true, reminder: due, act: "bell" });
    };
    check();
    const id = window.setInterval(check, 15_000);
    return () => clearInterval(id);
  }, [setSetting, showCard]);
  // ---- the first-run tour: a few cards, Клодик explains ----
  const tourStep = useCallback(
    (next: number | null) => {
      if (next === null || next >= TOUR.length) {
        touring.current = false;
        setCard(null);
        // What came in during the tour follows, one by one (see the queue).
        try {
          localStorage.setItem("island.tour", "done");
        } catch {
          /* no storage */
        }
        if (next !== null) buddy.react("happy", 1500);
        return;
      }
      touring.current = true;
      buddy.act(next === 0 ? "wave" : next === 3 ? "juggle" : "think", 2600);
      showCard({ kind: "tour", title: "", step: next, sticky: true });
    },
    [showCard],
  );
  useEffect(() => {
    const start = () => tourStep(0);
    window.addEventListener("island-tour", start);
    let done = false;
    try {
      done = localStorage.getItem("island.tour") === "done";
    } catch {
      /* no storage */
    }
    const t = done ? 0 : window.setTimeout(start, 1200);
    return () => {
      clearTimeout(t);
      window.removeEventListener("island-tour", start);
    };
  }, [tourStep]);

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
        showCard({ kind: "info", title: r.snow ? t("Скоро снег") : t("Скоро дождь"), sub: t("через {0} мин", r.minutes), ms: 4000, act: r.snow ? "snow" : "umbrella" });
      }
    };
    check();
    const id = window.setInterval(check, 10 * 60_000);
    return () => clearInterval(id);
  }, [weather, settings.rainWarning, showCard]);

  // Клодик dresses for the weather outside: umbrella, scarf or sunglasses.
  useEffect(() => {
    const now = Date.now();
    const cur = weather?.points.length
      ? weather.points.reduce((b, p) => (Math.abs(p.t - now) < Math.abs(b.t - now) ? p : b))
      : null;
    const sym = cur?.symbol ?? "";
    const wx = !cur ? "" : /snow|sleet/.test(sym) ? "snow" : /rain|drizzle|thunder/.test(sym) ? "rain" : cur.temp >= 27 ? "hot" : cur.temp <= -5 ? "snow" : "";
    buddy.configure({ weather: wx });
  }, [weather]);
  // Music on: no sleeping through it — a dozing Клодик wakes up, groggy.
  useEffect(() => {
    buddy.configure({ playing: !!media?.playing });
    if (media?.playing) buddy.wake();
  }, [media?.playing]);
  const wasSleeping = useRef(sleeping);
  useEffect(() => {
    if (wasSleeping.current && !sleeping) buddy.react("groggy", 2000);
    wasSleeping.current = sleeping;
  }, [sleeping]);
  // Loud music: headphones on.
  useEffect(() => {
    buddy.configure({ music: !!media?.playing && !!volume && !volume.muted && volume.level >= 0.5 });
  }, [media?.playing, volume]);
  // An AI answer that came while you were elsewhere.
  useEffect(() => {
    const on = (e: Event) => {
      const text = (e as CustomEvent<string>).detail.replace(/\s+/g, " ").trim();
      buddy.react("happy", 1500);
      showCard({ kind: "capture", title: t("ИИ ответил"), sub: text.slice(0, 120), open: { tab: "ai" }, ms: 7000 });
    };
    window.addEventListener("ai-answered", on);
    return () => window.removeEventListener("ai-answered", on);
  }, [showCard]);
  // A new sticker for the album.
  useEffect(() => {
    const on = (e: Event) => {
      const st = (e as CustomEvent<{ title: string; hint: string; icon: string; color: string }>).detail;
      showCard({
        kind: "info",
        title: t("Новая наклейка: {0}", st.title),
        sub: t("{0} — наведи", st.hint),
        ms: 6000,
        open: { scene: "sticker", sticker: { title: st.title, hint: st.hint, icon: st.icon, color: st.color } },
      });
    };
    window.addEventListener("buddy-sticker", on);
    return () => window.removeEventListener("buddy-sticker", on);
  }, [showCard]);
  // Birthdays: yours (from the settings) and his (a year and more after you met).
  useEffect(() => {
    const check = () => {
      const who = birthdayToday();
      if (!who) return;
      const key = new Date().toDateString();
      try {
        if (localStorage.getItem("island.bday") === key) return;
        localStorage.setItem("island.bday", key);
      } catch {
        /* no storage: celebrate anyway */
      }
      buddy.act("cake", 4200);
      buddy.count("bday");
      chime();
      showCard({
        kind: "info",
        title: who === "user" ? t("С днём рождения!") : t("У {0} день рождения!", buddy.look.name),
        sub: who === "user" ? t("{0} испёк торт — наведи", buddy.look.name) : t("Ему {0} — наведи", buddyAge()),
        open: { scene: "party" },
        ms: 15000,
      });
    };
    const first = window.setTimeout(check, 4000);
    const id = window.setInterval(check, 30 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [settings.userBirthday, showCard]);
  // Morning and late night: the first visit of the day gets a sunrise, a
  // visit deep in the night a yawn (once each).
  useEffect(() => {
    if (away) return;
    const day = (d: Date) => d.toDateString();
    const once = (key: string, value: string) => {
      try {
        if (localStorage.getItem(key) === value) return false;
        localStorage.setItem(key, value);
      } catch {
        /* no storage: still once per run */
      }
      return true;
    };
    const check = () => {
      const now = new Date();
      const h = now.getHours() + now.getMinutes() / 60;
      if (h >= 5 && h < 12 && once("island.morning", day(now))) {
        const cur = weather?.points.length
          ? weather.points.reduce((b, p) => (Math.abs(p.t - now.getTime()) < Math.abs(b.t - now.getTime()) ? p : b))
          : null;
        const wx = cur ? `${fmtTemp(cur.temp)}, ${describe(cur.symbol).text}` : "";
        showCard({ kind: "info", title: t("Доброе утро!"), sub: wx ? t("Сейчас {0}", wx) : t("Хорошего дня"), ms: 3600, act: "sunrise" });
      } else if (h >= 0.5 && h < 4.5 && once("island.night", day(now))) {
        const hm = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
        showCard({ kind: "info", title: t("Уже {0}", hm), sub: t("{0} зевает — может, пора спать?", buddy.look.name), ms: 4000, act: "yawn" });
      }
    };
    const first = window.setTimeout(check, 6000);
    const id = window.setInterval(check, 10 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [away, showCard]);
  // Low battery: he drags the plug to the socket (once per discharge).
  const lowWarned = useRef(false);
  useEffect(() => {
    if (!battery) return;
    if (battery.charging || battery.percent > 20) {
      lowWarned.current = false;
      return;
    }
    if (battery.percent <= 15 && !lowWarned.current) {
      lowWarned.current = true;
      showCard({ kind: "info", title: t("Батарея {0}%", battery.percent), sub: t("Пора на зарядку"), ms: 4000, act: "plug" });
    }
  }, [battery, showCard]);
  // A break now and then: after a long stretch at the computer he asks you to rest.
  const activeSince = useRef(Date.now());
  const nudgedAt = useRef(0);
  useEffect(() => {
    if (away) {
      // Rested after he asked: that counts.
      if (nudgedAt.current && Date.now() - nudgedAt.current < 15 * 60_000) {
        buddy.count("rest");
        nudgedAt.current = 0;
      }
      return;
    }
    activeSince.current = Date.now();
  }, [away]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const every = ((settings.breakMinutes as number) ?? 50) * 60_000;
      if (!settings.breakReminder || away || pomoRef.current) return;
      const since = Math.max(activeSince.current, nudgedAt.current);
      if (Date.now() - since < every) return;
      nudgedAt.current = Date.now();
      buddy.act("stretch", 1400);
      window.setTimeout(() => buddy.act("coffee", 4000), 1500);
      const m = Math.round((Date.now() - activeSince.current) / 60_000);
      showCard({
        kind: "info",
        title: t("{0}: может, перерыв?", buddy.look.name),
        sub: t("Уже {0} мин за компьютером — наведи", m),
        open: { scene: "break", minutes: m },
        ms: 12000,
      });
    }, 60_000);
    return () => clearInterval(id);
  }, [settings.breakReminder, settings.breakMinutes, away, showCard]);

  // The Windows side (tray menu, messages) speaks the same language.
  useEffect(() => {
    api?.call("ui_lang", { lang });
  }, [api]);
  // The interface language changed in the settings: this window follows.
  useEffect(() => {
    const v = settings.uiLang as string | undefined;
    if ((v === "auto" || v === "ru" || v === "en") && setLang(v)) location.reload();
  }, [settings.uiLang]);
  // For screenshots and tests: window.dispatchEvent(new Event("debug-break")).
  useEffect(() => {
    const on = () =>
      showCard({ kind: "info", title: t("{0}: может, перерыв?", buddy.look.name), sub: t("Уже 50 мин за компьютером — наведи"), open: { scene: "break", minutes: 50 }, ms: 12000 });
    // Any card: window.dispatchEvent(new CustomEvent("debug-card", { detail: {...} })).
    const any = (e: Event) => showCard((e as CustomEvent<Omit<Card, "key">>).detail);
    window.addEventListener("debug-break", on);
    window.addEventListener("debug-card", any);
    return () => {
      window.removeEventListener("debug-break", on);
      window.removeEventListener("debug-card", any);
    };
  }, [showCard]);

  // The charger went in: a jolt of energy.
  const wasCharging = useRef<boolean | null>(null);
  useEffect(() => {
    if (!battery) return;
    if (wasCharging.current === false && battery.charging) buddy.react("charged", 2000);
    wasCharging.current = battery.charging;
  }, [battery]);

  // Клодик's lasting states: tired on a low battery, bored when nobody has
  // come by for a while and nothing is going on.
  useEffect(() => {
    const check = () => {
      const tired = !!battery && !battery.charging && battery.percent <= 15;
      const bored = Date.now() - lastVisit.current > 150_000 && !media?.playing && !agentBusy && !away;
      buddy.setState(tired ? "tired" : bored ? "bored" : null);
    };
    check();
    const id = window.setInterval(check, 10_000);
    return () => clearInterval(id);
  }, [battery, media?.playing, agentBusy, away]);

  // ---- agents ----------------------------------------------------------------
  const onAgentRef = useRef<(e: AgentEvent) => void>(() => {});
  const pendingDone = useRef<Record<string, { t: number }>>({});
  onAgentRef.current = (e: AgentEvent) => {
    if (e.session === "test") {
      // "Проверить" in the settings: shown at once.
      showCard({ kind: "agent", title: t("{0}: связь есть", AGENT_NAMES[e.agent] ?? e.agent), sub: e.detail, mood: "done", ms: 4000 });
      return;
    }
    const name = AGENT_NAMES[e.agent ?? "claude"] ?? "Claude";
    const where = e.project ? ` · ${e.project}` : "";
    const stopWorking = () =>
      setWorking((w) => {
        const { [e.session]: _, ...rest } = w;
        return rest;
      });
    const clearAsk = () => setAsk((a) => (a && a.session === e.session ? null : a));
    // Only what needs you: a permission request and the final answer.
    // Agents report every step (Codex: every intermediate reply), so "done"
    // waits for the agent to go quiet; anything newer from the session
    // replaces it.
    const pend = pendingDone.current;
    const cancel = () => {
      clearTimeout(pend[e.session]?.t);
      delete pend[e.session];
    };
    switch (e.state) {
      case "working":
        cancel();
        if (settings.agentsWorking) setWorking((w) => ({ ...w, [e.session]: { ...e, at: Date.now() } }));
        clearAsk();
        break;
      case "ask":
        cancel();
        setAsk(e);
        buddy.react("surprised", 1200);
        chime();
        break;
      case "waiting":
        cancel();
        clearAsk();
        stopWorking();
        showCard({ kind: "agent", title: t("{0} ждёт{1}", name, where), sub: e.detail, mood: "ask", ms: 4000 });
        break;
      case "done": {
        cancel();
        const quiet = e.agent === "codex" ? 15_000 : e.agent === "opencode" ? 2500 : 800;
        const detail = e.detail;
        pend[e.session] = {
          t: window.setTimeout(() => {
            delete pend[e.session];
            clearAsk();
            stopWorking();
            buddy.react("excited", 2200);
            showCard({ kind: "agent", title: t("{0} ответил{1}", name, where), sub: detail || t("Готово"), mood: "done", ms: 6000 });
          }, quiet),
        };
        break;
      }
      case "info":
        // Progress notes: not worth a card.
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
  // Petting Клодик on the pill shouldn't open the island under him.
  const [overBuddy, setOverBuddy] = useState(false);
  useEffect(() => {
    const on = (e: Event) => setOverBuddy((e as CustomEvent<boolean>).detail);
    window.addEventListener("buddy-hover", on);
    return () => window.removeEventListener("buddy-hover", on);
  }, []);
  // A card you can act on (show the file, answer an agent, a reminder) stays a
  // card under the cursor: it doesn't turn into the open island and doesn't
  // vanish while you aim at it.
  cardRef.current = card;
  // When a card goes, the next waiting one comes.
  useEffect(() => {
    if (card || touring.current || !waiting.current.length) return;
    const t = window.setTimeout(() => {
      const c = waiting.current.shift();
      if (c) showCard(c);
    }, 350);
    return () => clearTimeout(t);
  }, [card, showCard]);
  const cardHold = !!card && (!!card.open || card.kind === "agent" || card.kind === "reminder" || card.kind === "tour");
  const held = useRef(false);
  // A card's time runs while it is visible.
  const cardVisible = mode === "card";
  // Over a game the window is hidden: an allowed card shows it for a while.
  const peeking = useRef(false);
  useEffect(() => {
    const want = (cardVisible || (mode === "ask" && level !== "desktop" && level !== "apps")) && presence === "hidden";
    if (want) {
      peeking.current = true;
      api?.call("island_peek", { on: true });
      // The game may have just hidden the island a moment later: once more.
      const t = window.setTimeout(() => api?.call("island_peek", { on: true }), 1700);
      return () => clearTimeout(t);
    }
    if (peeking.current) {
      peeking.current = false;
      api?.call("island_peek", { on: false });
    }
  }, [cardVisible, presence, api, mode, level]);
  useEffect(() => {
    if (!card || !cardVisible || card.sticky || held.current) return;
    clearTimeout(cardTimer.current);
    cardTimer.current = window.setTimeout(() => setCard(null), (card.ms ?? CARD_MS) * cardScaleRef.current);
    return () => clearTimeout(cardTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.key, cardVisible]);
  // A card to act on that arrives just as you reach for the island: the
  // island folds into the card, so the first click is on it.
  const hoverSince = useRef(0);
  useEffect(() => {
    if (hovered) hoverSince.current = Date.now();
  }, [hovered]);
  useEffect(() => {
    if (cardHold && hovered && !pinned && Date.now() - hoverSince.current < 2000) setHoverOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card?.key]);
  useEffect(() => {
    if (hovered && card?.open?.scene) {
      startScene(card.open);
      setCard(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, card?.key]);
  useEffect(() => {
    if (hovered && cardHold) {
      held.current = true;
      clearTimeout(cardTimer.current);
    } else if (held.current) {
      held.current = false;
      if (cardHold && card && !card.sticky) cardTimer.current = window.setTimeout(() => setCard(null), 2500);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, cardHold]);
  useEffect(() => {
    if (!hovered) setSuppressed(false);
    // A question from an agent (with its buttons) is not covered by the open island either.
    const want = hovered && !cardHold && !ask && !party && !(overBuddy && !hoverOpenRef.current);
    const delay = !want ? COLLAPSE_DELAY : presence === "strip" ? EXPAND_DELAY_STRIP : overBuddy ? 600 : EXPAND_DELAY;
    const t = window.setTimeout(() => setHoverOpen(want), delay);
    return () => clearTimeout(t);
  }, [hovered, presence, overBuddy, cardHold, ask, party]);
  // A question arrives while the island is open under the cursor: it folds
  // into the question so the buttons are right there.
  useEffect(() => {
    if (ask && !pinned) setHoverOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask?.askId]);
  useEffect(() => {
    if (expanded) setHud(false);
  }, [expanded]);
  // Folding: Клодик climbs up and out over the top edge of the screen.
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (wasExpanded.current && !expanded && buddy.look.life) {
      climbOut(document.querySelector(".tab-buddy .buddy"));
      // The pill's Клодик is the same one: gone while he climbs, then he falls back onto his place.
      buddy.react("away", 1000);
      window.setTimeout(() => buddy.react("plop", 800), 1000);
    }
    wasExpanded.current = expanded;
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
        if (id === "settings") {
          api?.call("settings_open");
          return;
        }
        if (id === "clipboard") {
          setTab("clip");
          setPinned(true);
          return;
        }
        if (id === "lock" || id === "sleep") {
          api?.call("power", { action: id });
          return;
        }
        if (id === "pomodoro") {
          pomodoro(!pomoRef.current);
          return;
        }

        api?.call<{ wifi: boolean; bluetooth: boolean; dark: boolean }>("controls_get").then((c) => {
          const on = !c[id as "wifi" | "bluetooth" | "dark"];
          api?.call("controls_set", { what: id, on });
          showCard({ anim: id === "dark" ? (on ? "theme-dark" : "theme-light") : `${id}-${on ? "on" : "off"}`, kind: "info", title: id === "dark" ? t("Тема") : id === "wifi" ? "Wi-Fi" : "Bluetooth", sub: on ? (id === "dark" ? t("тёмная") : t("включён")) : id === "dark" ? t("светлая") : t("выключен") });
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
        showCard({ kind: "info", title: t("Напомню"), sub: r.text, ms: 2000 });
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
        // Whole pixels: a fractional width centred by half would put all the
        // text between pixels, and it would look soft.
        const bw = Math.round(L.w);
        box.style.width = `${bw}px`;
        box.style.marginLeft = `${-Math.round(bw / 2)}px`;
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
        <Header battery={battery} tab={tab} setTab={(t) => (t === "settings" ? api?.call("settings_open") : setTab(t))} />
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
        title={[...privacy.cam.map((a) => t("Камера: {0}", a)), ...privacy.mic.map((a) => t("Микрофон: {0}", a))].join("\n")}
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
          if (mode === "party") return;
          if (mode === "card" && card?.open?.scene) {
            startScene(card.open);
            setCard(null);
            return;
          }
          if (mode === "card" && (card?.kind === "reminder" || card?.kind === "tour")) return;
          if (mode === "card" && card?.open) {
            if (card.open.path) api?.call("open_path", { path: card.open.path });
            if (card.open.url) api?.call("open_url", { url: card.open.url });
            if (card.open.app) api?.call("app_launch", { id: card.open.app });
            if (card.open.reveal) api?.call("reveal_path", { path: card.open.reveal });
            if (card.open.settings) api?.call("open_windows_settings", { page: card.open.settings });
            if (card.open.tab) {
              setTab(card.open.tab);
              setSuppressed(false);
              setPinned(true);
            }
            if (card.open.translate) {
              setAiTool({ text: card.open.translate, action: "translate" });
              setTab("ai");
              setSuppressed(false);
              setPinned(true);
            } else {
              // Done with the card: the island stays small until the cursor leaves.
              setSuppressed(true);
            }
            setCard(null);
          } else if (card?.sticky) setCard(null);
          else if (!expanded) {
            setSuppressed(false);
            setPinned(true);
          }
        }}
      >
        <View on={mode === "idle"} shape={sizeOf("idle", { battery: !!battery, temp: !!weather && settings.weatherOnPill })}>
          <Idle battery={battery} sleeping={sleeping} weather={settings.weatherOnPill ? weather : null} scale={buddyScale} />
        </View>
        {(["compact", "wide", "player", "lyrics", "line"] as MusicPill[]).map((style) => (
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
        <View on={mode === "obs"} shape={sizeOf("obs")}>
          {obs && <ObsPill obs={obs} />}
        </View>
        <View on={mode === "download"} shape={sizeOf("download")}>
          <DownloadPill list={downloads} />
        </View>
        <View on={mode === "hud"} shape={sizeOf("hud")}>
          {volume && <VolumeHud volume={volume} />}
        </View>
        <View on={mode === "timer"} shape={sizeOf("timer", { pomo: !!pomo })}>
          <TimerPill timer={timer} pomo={pomo} />
        </View>
        <View on={mode === "card"} shape={sizeOf("card", { card })}>
          {card && <CardView card={card} onDone={() => setCard(null)} onSnooze={snooze} onTour={tourStep} />}
        </View>
        <TabBuddy tab={tab} shown={mode === "expanded"} sleeping={sleeping} scale={buddyScale} life={settings.buddyLife} />
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
            launcherFailed={launcherFailed}
            onTypeStart={takeFocus}
          />,
        )}
        {frame("clip", <ClipboardTab api={api} clips={clips} onUsed={dismiss} onTypeStart={takeFocus} />)}
        {frame("shelf", <ShelfTab api={api} items={shelf} setItems={setShelf} dragOver={dragOver} />)}
        {frame(
          "note",
          <NoteTab api={api} timer={timer} onTypeStart={takeFocus} reminders={reminders} setReminders={setReminders} pomo={pomo} onPomodoro={pomodoro} />,
        )}
        {frame(
          "ai",
          <AiTab
            api={api}
            settings={settings}
            visible={mode === "expanded" && tab === "ai"}
            onTypeStart={takeFocus}
            ask={aiAsk}
            onAsked={() => setAiAsk(null)}
            tool={aiTool}
            onTool={() => setAiTool(null)}
            openSettings={() => api?.call("settings_open", { section: t("ИИ") })}
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
              if (m === "pomodoro") return pomodoro(!pomoRef.current);
              dismiss();
              // The island folds first, so the text goes to the window you were in.
              if (m === "voice") return void window.setTimeout(() => api?.call("dictate_toggle"), 250);
              if (m === "record") api?.call("record_toggle_cmd");
              else api?.call("capture_start", { mode: m });
            }}
            micMuted={privacy.micMuted}
            micUsers={privacy.mic}
            through={!!settings.through}
            onThrough={(v) => setSetting({ through: v })}
            onMic={() =>
              api?.call<boolean | null>("mic_toggle").then((m) => {
                if (m === null || m === undefined) return;
                setPrivacy((p) => ({ ...p, micMuted: m }));
              })
            }
            onCopyColor={(c) => {
              navigator.clipboard?.writeText(c).catch(() => {});
              document.documentElement.style.setProperty("--bd-paint", c);
              showCard({ kind: "capture", title: t("Цвет скопирован"), sub: c, swatch: c, ms: 2500, act: "paint" });
            }}
          />,
        )}
        <View on={mode === "agent"} shape={sizeOf("agent")}>
          <AgentPill working={working} />
        </View>
        <View on={mode === "party"} shape={sizeOf("party")}>
          {scene?.kind === "break" && (
            <BreakScene
              key={scene.key}
              minutes={scene.minutes}
              step={brkStep}
              onRest={() => {
                setScene(null);
                timerRef.current.start(5 * 60_000);
              }}
              onLater={() => {
                setScene(null);
                // Ask again in 15 minutes.
                nudgedAt.current = Date.now() - ((settings.breakMinutes as number) ?? 50) * 60_000 + 15 * 60_000;
              }}
            />
          )}
          {scene?.kind === "sticker" && scene.sticker && (
            <StickerScene key={scene.key} {...scene.sticker} onClose={() => setScene(null)} />
          )}
          {scene?.kind === "party" && (
            <PartyScene
              key={party}
              title={birthdayToday() === "buddy" ? t("{0}у {1}!", buddy.look.name, buddyAge()) : t("С днём рождения!")}
              sub={birthdayToday() === "buddy" ? t("Спасибо, что ты со мной") : t("{0} испёк тебе торт", buddy.look.name)}
              onClose={() => setScene(null)}
            />
          )}
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
  { id: "home", label: t("Главная"), icon: <TabHome /> },
  { id: "clip", label: t("Буфер"), icon: <TabClip /> },
  { id: "shelf", label: t("Полка"), icon: <TabShelf /> },
  { id: "note", label: t("Заметка и таймер"), icon: <TabNote /> },
  { id: "weather", label: t("Погода"), icon: <TabWeather /> },
  { id: "ai", label: t("ИИ: чат и текст"), icon: <TabAi /> },
  { id: "controls", label: t("Управление"), icon: <TabControls /> },
  { id: "settings", label: t("Настройки"), icon: <TabSettings /> },
];

function Header({ battery, tab, setTab }: { battery: Battery | null; tab: Tab; setTab: (t: Tab) => void }) {
  const now = useClock();
  return (
    <header>
      {/* Клодик's own place: he sits here on Home and hops to the other tabs. */}
      <span className="buddy-home" aria-hidden style={{ width: `calc(var(--bd-size, 20px) + 4px)` }} />
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

function TimerPill({ timer, pomo }: { timer: ReturnType<typeof useTimer>; pomo: Pomo | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!timer.running) return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [timer.running]);
  const left = remaining(timer.state);
  return (
    <div className="compact timer-pill">
      <Ring size={18} progress={timer.state.total ? left / timer.state.total : 0} color={pomo?.phase === "rest" ? "#7cbf5a" : pomo ? "#e0445e" : "#ff9f43"} />
      <Buddy size={22} mood={pomo?.phase === "work" ? "work" : null} />
      {pomo && <span className="pomo-label">{pomo.phase === "work" ? t("работа {0}", pomo.round) : t("отдых")}</span>}
      <span className={`time ${timer.running ? "" : "paused"}`}>{fmtClock(left)}</span>
    </div>
  );
}

const TOUR: [string, string][] = [
  [t("Привет! Я {name}"), t("Живу в этом острове. Наведи на него курсор — он раскроется, уведи — свернётся.")],
  [t("Вкладки"), t("Сверху: главная, буфер, полка, заметки, погода, ИИ, управление и настройки. Я буду прыгать за тобой.")],
  [t("Горячие клавиши"), t("Ctrl+Alt+I — открыть остров, Alt+Space — командная строка, Ctrl+Alt+S — скриншот, Ctrl+Alt+V — буфер.")],
  [t("Я питомец"), t("Гладь меня курсором, правый клик — покормить и поиграть. Наряды и альбом наклеек — в настройках.")],
];

function CardView({
  card,
  onDone,
  onSnooze,
  onTour,
}: {
  card: Card;
  onDone: () => void;
  onSnooze: (r: Reminder) => void;
  onTour: (next: number | null) => void;
}) {
  if (card.kind === "tour") {
    const i = card.step ?? 0;
    const [title, text] = TOUR[i];
    const last = i === TOUR.length - 1;
    return (
      <div className="compact card tour-card" key={card.key}>
        <Buddy size={40} />
        <div className="tour-text">
          <div className="card-title">{title.replace("{name}", buddy.look.name)}</div>
          <div className="tour-sub">{text}</div>
          <div className="tour-foot">
            <span className="tour-dots">
              {TOUR.map((_, k) => (
                <i key={k} className={k === i ? "on" : ""} />
              ))}
            </span>
            {!last && (
              <button className="text-btn" onClick={(e) => (e.stopPropagation(), onTour(null))}>
                {t("Пропустить")}</button>
            )}
            <button className="text-btn solid accent" onClick={(e) => (e.stopPropagation(), onTour(i + 1))}>
              {last ? t("Понятно") : t("Дальше")}
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (card.kind === "reminder" && card.reminder) {
    const r = card.reminder;
    return (
      <div className="reminder-card" key={card.key}>
        <div className="rc-head">
          <Buddy size={28} mood={card.act ? null : "ask"} />
          <div className="agent-text">
            <div className="card-title">{t("Напоминание")}</div>
            <div className="rc-text">{r.text}</div>
          </div>
        </div>
        <div className="ask-buttons">
          <button className="text-btn" onClick={(e) => (e.stopPropagation(), onSnooze(r))}>
            {t("Через 10 минут")}</button>
          <button className="text-btn solid accent" onClick={(e) => (e.stopPropagation(), onDone())}>
            {t("Готово")}</button>
        </div>
      </div>
    );
  }
  if (card.kind === "capture" || card.kind === "notify") {
    return (
      <div className={`compact card card-agent ${card.open ? "clickable" : ""} ${card.flash ? "card-flash" : ""}`} key={card.key}>
        {card.act && (
          <span className="card-buddy">
            <Buddy size={26} />
          </span>
        )}
        {card.thumb ? (
          <img className="card-thumb" src={card.thumb} alt="" />
        ) : card.swatch ? (
          <span className="card-swatch" style={{ background: card.swatch }} />
        ) : card.act ? null : (
          <span className="card-icon">{card.kind === "notify" ? <BellIcon /> : <TabClip size={20} />}</span>
        )}
        <div className="agent-text">
          <div className="card-title">{card.title}</div>
          {card.sub && <div className="agent-sub">{card.sub}</div>}
        </div>
        {card.open && (
          <span className="card-open">{card.open.translate ? t("Перевести") : card.open.reveal ? t("Показать") : card.open.tab ? t("Прочитать") : t("Открыть")}</span>
        )}
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
  const icon = card.act ? (
    <Buddy size={26} />
  ) : card.anim ? (
    <AnimIcon kind={card.anim} sub={card.sub ?? ""} />
  ) : card.kind === "caps" ? (
    <CapsIcon />
  ) : card.kind === "layout" ? (
    <GlobeIcon />
  ) : card.kind === "timer" ? (
    <TimerIcon />
  ) : null;
  return (
    <div className={`compact card card-${card.kind}`} key={card.key}>
      <span className={`card-icon ${card.act ? "card-buddy" : ""}`}>{icon}</span>
      <span className="card-title">{card.title}</span>
      <span className="card-sub">{card.sub}</span>
    </div>
  );
}

/**
 * Little moving pictures for switch cards: the sun and the moon trade
 * places, Wi-Fi waves rise or fade, the Bluetooth rune pings, a letter
 * flips case, the layout code turns over.
 */
function AnimIcon({ kind, sub }: { kind: string; sub: string }) {
  if (kind === "theme-dark" || kind === "theme-light")
    return (
      <span className={`ai-theme ${kind}`} aria-hidden>
        <svg width="20" height="20" viewBox="0 0 24 24">
          <g className="ai-sun">
            <circle cx="12" cy="12" r="4.5" fill="#ffd84a" />
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
              <rect key={a} x="11.2" y="2" width="1.6" height="3" rx="0.8" fill="#ffd84a" transform={`rotate(${a} 12 12)`} />
            ))}
          </g>
          <g className="ai-moon">
            <path d="M15.5 4.5a8 8 0 1 0 4 12.5 6.5 6.5 0 0 1-4-12.5z" fill="#cfd6ff" />
          </g>
        </svg>
      </span>
    );
  if (kind.startsWith("wifi"))
    return (
      <span className={`ai-wifi ${kind}`} aria-hidden>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
          <path className="w3" d="M2.5 9a14 14 0 0 1 19 0" />
          <path className="w2" d="M5.5 12.5a9.5 9.5 0 0 1 13 0" />
          <path className="w1" d="M8.6 16a5 5 0 0 1 6.8 0" />
          <circle className="w0" cx="12" cy="19.2" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      </span>
    );
  if (kind.startsWith("bluetooth"))
    return (
      <span className={`ai-bt ${kind}`} aria-hidden>
        <i className="ping" />
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m7 7 10 10-5 4V3l5 4L7 17" />
        </svg>
      </span>
    );
  if (kind.startsWith("caps"))
    return (
      <span className={`ai-flip ${kind}`} aria-hidden>
        <b className="front">{kind === "caps-on" ? "a" : "A"}</b>
        <b className="back">{kind === "caps-on" ? "A" : "a"}</b>
      </span>
    );
  if (kind === "layout")
    return (
      <span className="ai-flip layout" aria-hidden>
        <b className="front">⌨</b>
        <b className="back">{sub.slice(0, 2).toUpperCase()}</b>
      </span>
    );
  return null;
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
    // The halo hangs below the island; the window ends not far below an open
    // panel, so it shrinks to the room there is instead of being cut off.
    const room = window.innerHeight - L.h;
    const height = Math.max(0, Math.min(60, room + 4));
    const fit = Math.min(1, height / 36);
    glow.style.width = `${L.w * 0.86}px`;
    glow.style.height = `${height}px`;
    glow.style.top = `${L.h - 26}px`;
    glow.style.left = `${cx}px`;
    glow.style.opacity = Math.min(1, fit * m * (0.18 + 0.6 * e + 0.35 * L.beat)).toFixed(3);
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
      style={{ width: shape.w, marginLeft: -Math.round(shape.w / 2), height: top || onMeasure ? undefined : shape.h }}
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

const timeFmt = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short" });

function Idle({ battery, sleeping, weather, scale }: { battery: Battery | null; sleeping: boolean; weather: Weather | null; scale: number }) {
  const now = useClock();
  const cur = weather?.points.length
    ? weather.points.reduce((b, p) => (Math.abs(p.t - now.getTime()) < Math.abs(b.t - now.getTime()) ? p : b))
    : null;
  return (
    <div className={`idle ${battery ? "with-battery" : ""}`}>
      <PillBuddy sleeping={sleeping} size={Math.round(26 * Math.min(1.15, scale))} />
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

/**
 * Клодик on the collapsed pill. Now and then, on his own, he runs to the far
 * end and back, ducks under the edge and peeks out, or dives over the top
 * and drops back in.
 */
function PillBuddy({ sleeping, size }: { sleeping: boolean; size: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [trick, setTrick] = useState("");
  useEffect(() => {
    if (sleeping) return;
    let t = 0;
    const next = () => {
      t = window.setTimeout(() => {
        const el = ref.current;
        const pill = el?.closest<HTMLElement>(".compact, .idle");
        if (el && pill && buddy.look.life && !document.hidden) {
          const run = pill.offsetWidth - el.offsetWidth - 2 * el.offsetLeft;
          el.style.setProperty("--run", `${Math.max(20, run)}px`);
          const pick = ["run", "run", "peek", "dive"][Math.floor(Math.random() * 4)];
          setTrick(pick);
          if (pick === "run") sfx("hop");
          window.setTimeout(() => setTrick(""), pick === "run" ? 3200 : 2600);
        }
        next();
      }, 25_000 + Math.random() * 35_000);
    };
    next();
    return () => clearTimeout(t);
  }, [sleeping]);
  return (
    <span ref={ref} className={`pill-buddy ${trick}`}>
      <Buddy sleeping={sleeping} size={size} />
    </span>
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
  const pos = usePosition(media, style === "lyrics" || style === "line" ? 200 : 1000);
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
        <button aria-label={t("Предыдущий")} onClick={(e) => (e.stopPropagation(), api?.media("prev"))}>
          <Prev size={16} />
        </button>
        <button aria-label={t("Пауза")} onClick={(e) => (e.stopPropagation(), api?.media("toggle"))}>
          {media.playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button aria-label={t("Следующий")} onClick={(e) => (e.stopPropagation(), api?.media("next"))}>
          <Next size={16} />
        </button>
      </div>
    );
  }
  const i = (style === "lyrics" || style === "line") && lyrics?.length ? lineAt(lyrics, pos) : -1;
  const line = i >= 0 ? lyrics![i].text || "♪" : null;
  if (style === "line" && line !== null) {
    // Only the words: the line that sounds now, in the cover's colour.
    return (
      <div className="compact line-media" style={{ "--accent": accent } as React.CSSProperties}>
        <div className="line-lyric" key={i}>
          {line}
        </div>
      </div>
    );
  }
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

function ObsPill({ obs }: { obs: { recording: boolean; streaming: boolean; paused: boolean; since: number } }) {
  const now = useClock(500);
  const s = Math.max(0, Math.floor((now.getTime() - obs.since) / 1000));
  const h = Math.floor(s / 3600);
  const clock = `${h ? `${h}:` : ""}${String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
  return (
    <div className={`compact obs-pill ${obs.paused ? "paused" : ""}`} title="OBS Studio">
      <span className="obs-logo">OBS</span>
      {obs.streaming && <span className="obs-badge live">LIVE</span>}
      {obs.recording && <span className={`obs-badge rec ${obs.paused ? "paused" : ""}`}>{obs.paused ? t("ПАУЗА") : "REC"}</span>}
      <span className="time">{clock}</span>
    </div>
  );
}

function DownloadPill({ list }: { list: { name: string; size: number; speed: number; total: number }[] }) {
  const first = list[0];
  if (!first) return null;
  const mb = (b: number) => (b >= 1 << 30 ? t("{0} ГБ", (b / (1 << 30)).toFixed(1)) : t("{0} МБ", (b / (1 << 20)).toFixed(1)));
  const pct = first.total > 0 ? Math.min(100, Math.floor((first.size / first.total) * 100)) : null;
  return (
    <div className="compact download-pill" style={pct !== null ? ({ "--dl": `${pct}%` } as React.CSSProperties) : undefined}>
      {pct !== null && <i className="dl-progress" />}
      <span className="dl-buddy">
        <Buddy size={22} />
      </span>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7fd0ff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 4v11M7 10.5 12 15.5l5-5M5 20h14" />
      </svg>
      <span className="dl-name">{list.length > 1 ? t("Загрузок: {0}", list.length) : first.name}</span>
      <span className="dl-size">
        {pct !== null ? `${pct}%` : mb(first.size)}
        {first.speed > 0 ? t(" · {0}/с", mb(first.speed)) : ""}
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
  lyrics,
  launcher,
  setLauncher,
  launcherFailed,
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
  launcherFailed: string[];
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
            <button aria-label={t("Предыдущий")} onClick={() => api?.media("prev")}>
              <Prev size={26} />
            </button>
            <button className="main" aria-label={media.playing ? t("Пауза") : t("Играть")} onClick={() => api?.media("toggle")}>
              {media.playing ? <Pause size={32} /> : <Play size={32} />}
            </button>
            <button aria-label={t("Следующий")} onClick={() => api?.media("next")}>
              <Next size={26} />
            </button>
          </div>
        </>
      ) : (
        <div className="empty">
          <Note size={22} />
          <span>{t("Ничего не играет")}</span>
        </div>
      )}

      {volume && (
        <VolumeRow api={api} volume={volume} setVolume={setVolume} media={media} />
      )}
      <Launcher api={api} items={launcher} setItems={setLauncher} failed={launcherFailed} onTypeStart={onTypeStart} />
    </>
  );
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "opencode" };

function appName(id: string) {
  const s = id.toLowerCase();
  const known: [string, string][] = [
    ["spotify", "Spotify"],
    ["yandex", t("Яндекс Музыка")],
    ["chrome", "Chrome"],
    ["msedge", "Edge"],
    ["firefox", "Firefox"],
    ["opera", "Opera"],
    ["zunemusic", t("Медиаплеер")],
    ["vlc", "VLC"],
    ["telegram", "Telegram"],
  ];
  for (const [k, v] of known) if (s.includes(k)) return v;
  return (id.split(/[\\/!]/).pop() ?? id).replace(/\.exe$/i, "");
}

function AgentPill({ working }: { working: Record<string, AgentEvent & { at: number }> }) {
  const list = Object.values(working);
  const first = list[0];
  const name = AGENT_NAMES[first?.agent ?? "claude"] ?? "Claude";
  return (
    <div className="compact agent-pill">
      <Buddy size={24} mood="work" />
      <span className="agent-label">
        {list.length > 1 ? t("Агентов работает: {0}", list.length) : t("{0} работает", name)}
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
  const name = AGENT_NAMES[ask.agent ?? "claude"] ?? "Claude";
  return (
    <div className="ask">
      <div className="ask-head">
        <Buddy size={28} mood="ask" />
        <div className="ask-title">
          {name} {" "}{t("просит разрешение")}{ask.project ? <span className="agent-project"> · {ask.project}</span> : null}
        </div>
        <Ring size={20} progress={ask.seconds ? left / ask.seconds : 0} color="#d97757" />
      </div>
      <div className="ask-detail">{ask.detail}</div>
      <div className="ask-buttons">
        <button className="text-btn" onClick={(e) => (e.stopPropagation(), onAnswer(false))}>
          {t("Запретить")}</button>
        <button className="text-btn solid accent" onClick={(e) => (e.stopPropagation(), onAnswer(true))}>
          {t("Разрешить")}</button>
      </div>
    </div>
  );
}

function DictationPill({ state, level }: { state: string; level: number }) {
  return (
    <div className="compact dictation-pill" title={t("Клик или Ctrl+Alt+D — закончить")}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff6b5e" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <rect x="9" y="3" width="6" height="11" rx="3" fill="#ff6b5e" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      </svg>
      <span className="dl-name">{state === "busy" ? t("Распознаю…") : t("Говори…")}</span>
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
    <div className="compact recording-pill" title={t("Клик — остановить (Ctrl+Alt+R)")}>
      <span className="rec-dot" />
      <span className="time">
        {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      </span>
      <span className="muted">{t("стоп")}</span>
    </div>
  );
}

/** Offset of an element inside one of its ancestors, ignoring transforms. */
function offsetWithin(el: HTMLElement, ancestor: HTMLElement) {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur && cur !== ancestor) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent as HTMLElement | null;
  }
  return { x, y };
}

/**
 * How he flies on a hop between tabs: a different trick each time. The
 * frames squash him on take-off and landing; in between, the trick.
 */
function hopStyle(dir: number): Keyframe[] {
  const styles: Keyframe[][] = [
    // a somersault
    [
      { transform: "scale(1.2, 0.75)", offset: 0 },
      { transform: "scale(0.9, 1.1) rotate(0deg)", offset: 0.15 },
      { transform: `rotate(${dir * 360}deg)`, offset: 0.82 },
      { transform: `scale(1.25, 0.72) rotate(${dir * 360}deg)`, offset: 0.92 },
      { transform: `scale(1, 1) rotate(${dir * 360}deg)`, offset: 1 },
    ],
    // turns round in the air
    [
      { transform: "scale(1.2, 0.75)", offset: 0 },
      { transform: "scale(0.9, 1.1)", offset: 0.15 },
      { transform: "scale(-1, 1)", offset: 0.5 },
      { transform: "scale(1, 1.05)", offset: 0.82 },
      { transform: "scale(1.25, 0.72)", offset: 0.92 },
      { transform: "scale(1, 1)", offset: 1 },
    ],
    // tucks into a ball and rolls through the air
    [
      { transform: "scale(1.2, 0.75)", offset: 0 },
      { transform: "scale(0.7) rotate(0deg)", offset: 0.2 },
      { transform: `scale(0.7) rotate(${dir * 720}deg)`, offset: 0.78 },
      { transform: `scale(1.3, 0.7) rotate(${dir * 720}deg)`, offset: 0.9 },
      { transform: `scale(1) rotate(${dir * 720}deg)`, offset: 1 },
    ],
    // stretches out like a superhero
    [
      { transform: "scale(1.25, 0.7)", offset: 0 },
      { transform: `scale(0.75, 1.35) rotate(${dir * 12}deg)`, offset: 0.25 },
      { transform: `scale(1.3, 0.8) rotate(${dir * 25}deg)`, offset: 0.55 },
      { transform: "scale(1.35, 0.65) rotate(0deg)", offset: 0.9 },
      { transform: "scale(1)", offset: 1 },
    ],
    // flaps like a bird
    [
      { transform: "scale(1.2, 0.75)", offset: 0 },
      { transform: "rotate(-14deg)", offset: 0.25 },
      { transform: "rotate(14deg)", offset: 0.45 },
      { transform: "rotate(-14deg)", offset: 0.65 },
      { transform: "rotate(0deg) scale(1.25, 0.72)", offset: 0.9 },
      { transform: "scale(1)", offset: 1 },
    ],
    // lands and bounces once more
    [
      { transform: "scale(1.2, 0.75)", offset: 0 },
      { transform: "scale(0.9, 1.12)", offset: 0.2 },
      { transform: "scale(1.3, 0.7)", offset: 0.7 },
      { transform: "translateY(-6px) scale(0.92, 1.1)", offset: 0.82 },
      { transform: "translateY(0) scale(1.15, 0.85)", offset: 0.93 },
      { transform: "scale(1)", offset: 1 },
    ],
  ];
  return styles[Math.floor(Math.random() * styles.length)];
}

/**
 * Клодик in the open island: on Home he sits on his own place by the clock,
 * on other tabs he stands under the open tab, and he hops between them. Now
 * and then he goes for a walk to another tab and comes back.
 */
function TabBuddy({ tab, shown, sleeping, scale, life }: { tab: Tab; shown: boolean; sleeping: boolean; scale: number; life: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [visit, setVisit] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  /** Where he was on screen when the next hop was asked for (mid-air included). */
  const from = useRef<DOMRect | null>(null);
  useEffect(() => {
    if (!shown) setMenu(false);
  }, [shown]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);
  const placed = useRef(false);
  const SIZE = Math.round(20 * scale);

  /** Where he stands: "home" (by the clock) or a tab id. */
  const measure = useCallback((spot: string) => {
    const view = document.querySelector<HTMLElement>(".view.on .expanded")?.parentElement;
    if (!view) return null;
    const half = view.offsetWidth / 2;
    if (spot === "home") {
      const slot = view.querySelector<HTMLElement>(".buddy-home");
      if (slot) {
        const o = offsetWithin(slot, view);
        return { x: o.x - half, y: o.y + slot.offsetHeight / 2 - (SIZE * 11) / 15 / 2 };
      }
      // Another tab is open (his clock spot is on Home only): he sits on the Home tab button.
    }
    const i = Math.max(0, TABS.findIndex((t) => t.id === spot));
    const btn = view.querySelectorAll<HTMLElement>("nav.tabs button")[i];
    if (!btn) return null;
    const o = offsetWithin(btn, view);
    return { x: o.x + btn.offsetWidth / 2 - SIZE / 2 - half, y: o.y + btn.offsetHeight - 2 };
  }, [SIZE]);

  // Without his own life he keeps to his place and only watches the cursor.
  // Asleep (away, or put to bed) he stays where he dozed off: no walks, no hops.
  const pet = usePet();
  const dozing = sleeping || pet.asleep;
  const lastSpot = useRef("home");
  const wanted = !life ? "home" : (visit ?? (tab === "home" ? "home" : tab));
  const spot = dozing ? lastSpot.current : wanted;
  lastSpot.current = spot;
  // On the tab bar he is smaller: the tabs are his playground, the clock is his home.
  const k = spot === "home" ? 1 : 0.66;
  useLayoutEffect(() => {
    if (!shown) {
      placed.current = false;
      setVisit(null);
      return;
    }
    // The open island may not be laid out yet (it is still growing, or
    // another view is fading out): try again on the next frames instead of
    // giving up — giving up left him unplaced, i.e. invisible, until the
    // island was closed and opened again.
    let raf = 0;
    let tries = 0;
    const place = () => {
      const p = measure(spot);
      if (!p) {
        if (tries++ < 60) raf = requestAnimationFrame(place);
        return;
      }
      from.current = placed.current && ref.current ? ref.current.getBoundingClientRect() : null;
      setPos(p);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [spot, shown, measure, SIZE]);
  // A safety net: every couple of seconds he checks he is where he should
  // be (a window resize, a zoom change or a tab that changed its height).
  useEffect(() => {
    if (!shown) return;
    const id = window.setInterval(() => {
      // Hidden by a hop that never finished: show him again.
      const svg = ref.current?.querySelector<HTMLElement>(".buddy");
      if (svg?.style.visibility === "hidden" && !document.querySelector(".buddy-ghost")) svg.style.visibility = "";
      const p = measure(lastSpot.current);
      if (!p) return;
      setPos((old) => (old && Math.abs(old.x - p.x) < 1 && Math.abs(old.y - p.y) < 1 ? old : p));
    }, 2000);
    return () => clearInterval(id);
  }, [shown, measure]);

  // Each hop is its own flight along an arc, started from wherever he is now,
  // so quick clicks make him jump again in mid-air instead of sliding.
  useLayoutEffect(() => {
    const el = ref.current;
    const body = inner.current;
    if (!el || !body || !pos || !shown) return;
    const old = from.current;
    from.current = null;
    el.getAnimations().forEach((a) => a.cancel());
    body.getAnimations().forEach((a) => a.cancel());
    el.style.transform = `scale(${k})`;
    if (!placed.current) {
      placed.current = true;
      el.animate(
        [
          { transform: `translateY(-40px) scale(${k})` },
          { transform: `translateY(0) scale(${k * 1.15}, ${k * 0.78})`, offset: 0.55 },
          { transform: `translateY(-3px) scale(${k * 0.95}, ${k * 1.06})`, offset: 0.75 },
          { transform: `translateY(0) scale(${k})` },
        ],
        { duration: 700, easing: "cubic-bezier(.3,.7,.4,1)" },
      );
      return;
    }
    if (!old) return;
    const now = el.getBoundingClientRect();
    const k0 = old.width / Math.max(1, now.width / k);
    const dx = old.left + old.width / 2 - (now.left + now.width / 2);
    const dy = old.top - now.top;
    const dist = Math.hypot(dx, dy);
    if (dist < 1 && Math.abs(k0 - k) < 0.01) return;
    // A low arc: high ones would fly off the top of the screen.
    const peak = Math.min(18, 8 + dist * 0.08);
    const duration = Math.min(680, 360 + dist * 1.3);
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const x = dx * (1 - t);
      const y = dy * (1 - t) - 4 * peak * t * (1 - t);
      const sc = k0 + (k - k0) * t;
      frames.push({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${sc.toFixed(3)})` });
    }
    el.animate(frames, { duration, easing: "linear" });
    sfx("hop");
    body.animate(hopStyle(Math.sign(dx) || 1), { duration, easing: "ease-in-out" });
    // k changes a render before pos does: the flight waits for the new place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, shown]);

  // Walks now and then, along different routes; at each stop he busies
  // himself with something: puzzles over it, studies it with a magnifier,
  // knocks, polishes the icon, sniffs, salutes…
  useEffect(() => {
    if (!shown || dozing || !life) return;
    let t = 0;
    let alive = true;
    const later = (ms: number, f: () => void) => {
      t = window.setTimeout(() => alive && f(), ms);
    };
    const ids = TABS.map((x) => x.id as string);
    const here = tab === "home" ? "home" : tab;
    const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
    const away = ids.filter((x) => x !== here && x !== "home");
    const STOP_ACTS: [string, number][] = [
      ["puzzle", 2200],
      ["magnify", 3200],
      ["knock", 1600],
      ["polish", 2200],
      ["sniff", 2000],
      ["salute", 1400],
      ["look", 1800],
      ["think", 2600],
    ];
    const route = (): string[] => {
      const kind = pick(["visit", "visit", "tour", "patrol", "far"]);
      if (kind === "tour") {
        const a = [...away].sort(() => Math.random() - 0.5);
        return a.slice(0, 2 + Math.floor(Math.random() * 2));
      }
      if (kind === "patrol") {
        // Along the tab bar, one way or the other.
        const line = ids.filter((x) => x !== "home");
        return (Math.random() < 0.5 ? line : [...line].reverse()).filter((x) => x !== here);
      }
      if (kind === "far") {
        const i = ids.indexOf(here === "home" ? ids[0] : here);
        const far = ids[i < ids.length / 2 ? ids.length - 1 : 1];
        return [far === here ? pick(away) : far];
      }
      return [pick(away)];
    };
    const walk = (stops: string[], i: number) => {
      if (i >= stops.length) {
        setVisit(null);
        return later(800, plan);
      }
      setVisit(stops[i]);
      // On a patrol he only stops now and then; elsewhere at every stop.
      const busy = stops.length < 4 || Math.random() < 0.35;
      if (!busy) return later(650, () => walk(stops, i + 1));
      const [act, ms] = pick(STOP_ACTS);
      later(700, () => {
        buddy.act(act, ms);
        later(ms + 250, () => walk(stops, i + 1));
      });
    };
    const plan = () => later(9000 + Math.random() * 14000, () => walk(route(), 0));
    plan();
    return () => {
      alive = false;
      clearTimeout(t);
      setVisit(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, dozing, tab, life]);

  if (!pos) return null;
  return (
    <>
      <div
        ref={ref}
        className={`tab-buddy ${shown ? "" : "gone"} ${spot === "home" ? "mirror" : ""}`}
        style={{ left: `calc(50% + ${pos.x}px)`, top: pos.y }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu((m) => !m);
        }}
      >
        <div ref={inner} className="tb-inner">
          <Buddy size={SIZE} sleeping={sleeping} />
        </div>
      </div>
      {menu && shown && (
        <div className="buddy-menu" style={{ left: `calc(50% + ${Math.min(Math.max(pos.x - 160, -220), -110)}px)`, top: pos.y + (SIZE * 11) / 15 + 6 }} onClick={(e) => e.stopPropagation()}>
          {(
            [
              [t("Покормить"), () => buddy.feed()],
              [t("Поиграть"), () => buddy.play()],
              [buddy.pet.asleep ? t("Разбудить") : t("Уложить спать"), () => buddy.toggleSleep()],
              [t("Трюк"), () => buddy.act(["flip", "spin", "dance", "juggle", "kite"][Math.floor(Math.random() * 5)], 2600)],
            ] as [string, () => void][]
          ).map(([label, f]) => (
            <button
              key={label}
              onClick={() => {
                f();
                setMenu(false);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The volume slider of Home. With music playing it can switch between the
 * computer's volume and the player's own (its audio session in Windows).
 */
function VolumeRow({
  api,
  volume,
  setVolume,
  media,
}: {
  api: Bridge | null;
  volume: Volume;
  setVolume: (v: Volume) => void;
  media: Media | null;
}) {
  const [target, setTarget] = useState<"pc" | "player">("pc");
  const [player, setPlayer] = useState<number | null>(null);
  const appId = media?.app ?? "";
  useEffect(() => {
    setPlayer(null);
    if (target !== "player" || !appId) return;
    api?.call<number | null>("player_volume_get", { appId }).then((v) => setPlayer(v ?? null));
  }, [target, appId, api]);
  const usePlayer = target === "player" && media;
  const level = usePlayer ? (player ?? 0) : volume.muted ? 0 : volume.level;
  return (
    <div className="volume">
      <button aria-label={t("Без звука")} onClick={() => api?.muteToggle()}>
        <Speaker level={volume.level} muted={volume.muted} />
      </button>
      {media && (
        <div className="segmented tiny">
          <button className={target === "pc" ? "on" : ""} onClick={() => setTarget("pc")}>
            {t("Компьютер")}</button>
          <button className={target === "player" ? "on" : ""} onClick={() => setTarget("player")}>
            {t("Плеер")}</button>
        </div>
      )}
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        disabled={!!usePlayer && player === null}
        value={level}
        style={{ "--v": `${level * 100}%` } as React.CSSProperties}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (usePlayer) {
            setPlayer(v);
            api?.call("player_volume_set", { appId, level: v });
          } else {
            setVolume({ level: v, muted: false });
            api?.volumeSet(v);
          }
        }}
      />
      <span className="num" title={usePlayer && player === null ? t("Плеер не найден среди звуков Windows") : undefined}>
        {usePlayer && player === null ? "—" : Math.round(level * 100)}
      </span>
    </div>
  );
}
