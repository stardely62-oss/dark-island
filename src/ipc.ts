// Bridge to the Rust side. Outside Tauri (plain `npm run dev` in a browser)
// a small mock stands in, so the UI can be designed without Windows.

export type Media = {
  title: string;
  artist: string;
  app: string;
  playing: boolean;
  cover: string | null;
  positionMs: number;
  durationMs: number;
  updatedAtMs: number;
};
export type Volume = { level: number; muted: boolean };
export type Battery = { percent: number; charging: boolean };
/** normal: desktop / ordinary windows; strip: another app is full-screen; hidden: a game is. */
export type Presence = "normal" | "strip" | "hidden";
export type Snapshot = { media: Media | null; volume: Volume | null; battery: Battery | null; presence: Presence };
export type Cursor = { x: number; y: number; near: boolean; inside: boolean };
export type Rect = { x: number; y: number; w: number; h: number };
export type MediaAction = "toggle" | "next" | "prev";

type Events = {
  media: Media | null;
  volume: Volume | null;
  battery: Battery | null;
  cursor: Cursor;
  presence: Presence;
  /** No keyboard or mouse for a couple of minutes. */
  away: boolean;
  /** Loudness of 6 frequency bands (low → high), 0..1, ~30 times a second. */
  audio: number[];
  clips: Clip[];
  keys: { caps: boolean; layout: string; what: "caps" | "layout" };
  hotkey: "toggle" | "clipboard" | "command" | "through" | "chat";
  agent: AgentEvent;
  settings: Record<string, unknown>;
  weather: import("./weather").Weather | null;
  privacy: { mic: string[]; cam: string[]; micMuted: boolean };
  mic_muted: boolean;
  vpn: { on: boolean; name: string | null; country?: string; ip?: string };
  downloads: { name: string; size: number; speed: number; total: number }[];
  vpn_error: string;
  settings_section: string;
  tour: null;
  obs: { connected: boolean; recording: boolean; streaming: boolean; paused: boolean };
  download_done: { name: string; path: string; size: number };
  notification: { app: string; aumid: string; title: string; body: string };
  foreground: string;
  ai_delta: { id: string; text: string };
  ai_done: { id: string; error: string | null };
  dictation: { state: "rec" | "busy" | "done" | "error"; level?: number; text?: string; target?: string; privacy?: boolean };
  recording: { on: boolean; path?: string; error?: string };
  capture: { kind: "shot" | "text" | "qr" | "link" | "color" | "error"; text: string; thumb: string | null; path: string | null };
  outside_click: null;
  /** Files dragged over the island from another window (dropped ones are already on the shelf). */
  drag: { type: "enter" | "leave" | "drop"; paths: string[] };
  shelf: ShelfItem[];
};

export type Clip = {
  id: number;
  kind: "text" | "image";
  preview: string;
  chars: number;
  thumb: string | null;
  w: number;
  h: number;
  pinned: boolean;
  at: number;
};
export type AgentEvent = {
  agent: "claude" | "codex" | "opencode";
  session: string;
  state: "working" | "ask" | "waiting" | "done" | "end" | "info";
  project: string;
  detail: string;
  askId: number;
  seconds: number;
};
export type ShelfItem = { path: string; name: string; dir: boolean; size: number };

export interface Bridge {
  getState(): Promise<Snapshot>;
  setHitRect(rect: Rect): void;
  media(action: MediaAction): void;
  volumeSet(level: number): void;
  volumeStep(delta: number): void;
  muteToggle(): void;
  /** Any other backend command. */
  call<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  /** Drags files out of the island into another window. */
  dragOut(paths: string[], icon: string): void;
  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBridge(): Promise<Bridge> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const fire = (cmd: string, args?: Record<string, unknown>) => {
    invoke(cmd, args).catch(() => {});
  };
  return {
    getState: () => invoke<Snapshot>("get_state"),
    setHitRect: (rect) => fire("set_hit_rect", { rect }),
    media: (action) => fire("media_cmd", { action }),
    volumeSet: (level) => fire("volume_set", { level }),
    volumeStep: (delta) => fire("volume_step", { delta }),
    muteToggle: () => fire("volume_mute_toggle"),
    call: (cmd, args) => invoke(cmd, args),
    dragOut(paths, icon) {
      const onEvent = new Channel<unknown>();
      invoke("plugin:drag|start_drag", { item: paths, image: icon, options: { mode: "copy" }, onEvent }).catch(() => {});
    },
    on(event, cb) {
      const p = listen(event, (e) => cb(e.payload as never));
      return () => {
        p.then((un) => un());
      };
    },
  };
}

function mockCover(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff5f8f"/><stop offset="1" stop-color="#7a3cff"/></linearGradient></defs>
    <rect width="120" height="120" fill="url(#g)"/>
    <circle cx="60" cy="60" r="30" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="6"/>
    <circle cx="60" cy="60" r="6" fill="#fff" fill-opacity=".8"/></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function mockWeather() {
  const now = Date.now();
  const h0 = Math.floor(now / 3_600_000) * 3_600_000;
  const syms = ["partlycloudy_day", "cloudy", "lightrain", "rain", "cloudy", "fair_day", "clearsky_night"];
  const points = Array.from({ length: 24 * 8 }, (_, i) => {
    const t = h0 + i * 3_600_000;
    const hour = new Date(t).getHours();
    return {
      t,
      temp: 4 + 5 * Math.sin(((hour - 9) / 24) * 2 * Math.PI) - i * 0.03,
      wind: 3 + (i % 5),
      humidity: 70 + (i % 20),
      pressure: 1012,
      symbol: hour < 7 || hour > 19 ? "clearsky_night" : syms[Math.floor(i / 5) % syms.length],
      precip: i >= 1 && i <= 2 ? 0.6 : 0,
      symbol6: syms[Math.floor(i / 24) % syms.length],
    };
  });
  return { city: "Казань", points, at: now };
}

function mockBridge(): Bridge {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = (e: string, p: unknown) => listeners.get(e)?.forEach((cb) => cb(p));
  const state: Snapshot = {
    media: {
      title: "Midnight Drive",
      artist: "Neon Coast",
      app: "Spotify.exe",
      playing: true,
      cover: mockCover(),
      positionMs: 64_000,
      durationMs: 213_000,
      updatedAtMs: Date.now(),
    },
    volume: { level: 0.42, muted: false },
    battery: { percent: 76, charging: false },
    presence: "normal",
  };
  let rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  const params = new URLSearchParams(location.search);
  if (params.has("nomedia")) state.media = null;
  if (params.has("nobattery")) state.battery = null;
  if (params.has("strip")) state.presence = "strip";
  if (params.has("away")) setTimeout(() => emit("away", true), 300);

  window.addEventListener("pointermove", (e) => {
    const inside = e.clientX >= rect.x && e.clientX <= rect.x + rect.w && e.clientY <= rect.y + rect.h;
    const near =
      e.clientX > rect.x - 140 && e.clientX < rect.x + rect.w + 140 && e.clientY < rect.y + rect.h + 140;
    emit("cursor", { x: e.clientX, y: e.clientY, near, inside });
  });
  window.addEventListener("pointerleave", () => emit("cursor", { x: -999, y: -999, near: false, inside: false }));

  const setVolume = (level: number, muted = state.volume!.muted) => {
    state.volume = { level: Math.min(1, Math.max(0, level)), muted };
    emit("volume", state.volume);
  };
  const media = (action: MediaAction) => {
    const m = state.media;
    if (!m) return;
    const now = Date.now();
    const pos = m.playing ? m.positionMs + now - m.updatedAtMs : m.positionMs;
    state.media =
      action === "toggle"
        ? { ...m, playing: !m.playing, positionMs: pos, updatedAtMs: now }
        : { ...m, title: action === "next" ? "Glass Harbour" : "Midnight Drive", positionMs: 0, updatedAtMs: now };
    setTimeout(() => emit("media", state.media), 60);
  };
  // Fake music analysis: a kick drum at 118 bpm plus deliberately noisy
  // bands, to show that the island smooths jitter out.
  const t0 = performance.now();
  window.setInterval(() => {
    if (!state.media?.playing) return;
    const t = (performance.now() - t0) / 1000;
    const kick = Math.exp(-((t * 118) / 60 % 1) * 7);
    const n = () => (Math.random() - 0.5) * 0.25;
    const c = (v: number) => Math.min(1, Math.max(0, v));
    emit("audio", [
      c(0.3 + 0.65 * kick + n()),
      c(0.25 + 0.5 * kick + n()),
      c(0.45 + 0.2 * Math.sin(t * 1.3) + n()),
      c(0.5 + 0.25 * Math.sin(t * 2.1 + 1) + n()),
      c(0.35 + 0.3 * Math.max(0, Math.sin(t * 4.7)) + n()),
      c(0.25 + 0.2 * Math.sin(t * 3.3) + n()),
    ]);
  }, 33);

  // Lets screenshots and tests drive the mock: window.__island.emit("volume", ...)
  (window as unknown as { __island: unknown }).__island = { emit, state };

  const now = Date.now();
  let clips: Clip[] = [
    { id: 5, kind: "text", preview: "https://github.com/stardely62-oss/dark-island", chars: 45, thumb: null, w: 0, h: 0, pinned: true, at: now - 3_600_000 },
    { id: 4, kind: "text", preview: "Купить молоко, хлеб и батарейки для мышки", chars: 41, thumb: null, w: 0, h: 0, pinned: false, at: now - 40_000 },
    { id: 3, kind: "image", preview: "", chars: 0, thumb: mockCover(), w: 1280, h: 720, pinned: false, at: now - 300_000 },
    { id: 2, kind: "text", preview: "const island = new Liquid({ w: 236, h: 34 });\nisland.step(1 / 60, drive);", chars: 70, thumb: null, w: 0, h: 0, pinned: false, at: now - 900_000 },
    { id: 1, kind: "text", preview: "Встреча в четверг в 15:00, ссылка в календаре", chars: 44, thumb: null, w: 0, h: 0, pinned: false, at: now - 7_200_000 },
  ];
  let shelf: ShelfItem[] = [
    { path: "C:\\Users\\me\\Desktop\\отчёт.pdf", name: "отчёт.pdf", dir: false, size: 1_284_000 },
    { path: "C:\\Users\\me\\Pictures\\wallpaper.png", name: "wallpaper.png", dir: false, size: 3_400_000 },
    { path: "C:\\Users\\me\\Projects", name: "Projects", dir: true, size: 0 },
  ];
  if (params.has("empty")) {
    clips = [];
    shelf = [];
  }
  const mockSettings: Record<string, unknown> = {};
  if (params.has("launcher"))
    mockSettings.launcher = [
      { name: "Telegram", kind: "app", target: "tg", hotkey: "Ctrl+Alt+Digit1" },
      {
        name: "Работа",
        kind: "group",
        target: "group:1",
        items: [
          { name: "VS Code", kind: "app", target: "code" },
          { name: "github.com", kind: "url", target: "github.com" },
          { name: "Проекты", kind: "path", target: "C:\\Projects" },
        ],
      },
      { name: "Steam", kind: "app", target: "steam" },
    ];
  if (params.get("pill")) Object.assign(mockSettings, { musicPill: params.get("pill"), lyrics: true });
  const mockControls = { wifi: true, ssid: "Home-5G", bluetooth: true, dark: true };
  let note = "Идеи:\n— остров под музыку ✓\n— Клодик ✓\n— буфер обмена";
  let mockVpn: string | null = null;
  const calls: Record<string, (a: Record<string, unknown>) => unknown> = {
    clip_list: () => clips,
    clip_use: () => true,
    clip_delete: (a) => {
      clips = clips.filter((c) => c.id !== a.id);
      emit("clips", clips);
    },
    clip_pin: (a) => {
      clips = clips.map((c) => (c.id === a.id ? { ...c, pinned: !c.pinned } : c));
      emit("clips", clips);
    },
    clip_clear: () => {
      clips = clips.filter((c) => c.pinned);
      emit("clips", clips);
    },
    shelf_list: () => shelf,
    shelf_add: (a) => {
      for (const p of a.paths as string[]) shelf.push({ path: p, name: p.split(/[\\/]/).pop()!, dir: false, size: 1000 });
      return shelf;
    },
    shelf_remove: (a) => (shelf = shelf.filter((i) => i.path !== a.path)),
    shelf_clear: () => (shelf = []),
    settings_get: () => mockSettings,
    settings_set: (a) => {
      Object.assign(mockSettings, a.patch);
      return mockSettings;
    },
    agents_connections: () => ({ claude: false, codex: false, codex_busy: false, opencode: false }),
    agents_connect: (a) => ({ claude: a.which === "claude" && a.on, codex: a.which === "codex" && a.on, codex_busy: false, opencode: a.which === "opencode" && a.on }),
    agents_answer: (a) => {
      emit("agent", { agent: "claude", session: "s1", state: "working", project: "dark-island", detail: "", askId: 0, seconds: 0 });
      return a;
    },
    controls_get: () => mockControls,
    controls_set: (a) => {
      (mockControls as Record<string, unknown>)[a.what as string] = a.on;
      return mockControls;
    },
    apps_list: () => [
      { Name: "Telegram", AppID: "tg" },
      { Name: "Google Chrome", AppID: "chrome" },
      { Name: "Блокнот", AppID: "notepad" },
      { Name: "Калькулятор", AppID: "calc" },
      { Name: "Visual Studio Code", AppID: "code" },
      { Name: "Steam", AppID: "steam" },
    ],
    capture_start: (a) => {
      setTimeout(() => {
        const r =
          a.mode === "color"
            ? { kind: "color", text: "#D97757", thumb: null, path: null }
            : a.mode === "ocr"
              ? { kind: "text", text: "Выручка выросла на 12%\nОтчёт за ноябрь", thumb: null, path: null }
              : a.mode === "qr"
                ? { kind: "qr", text: "https://github.com/stardely62-oss/dark-island", thumb: null, path: null }
                : { kind: "shot", text: "В буфере и в папке", thumb: mockCover(), path: "C:\\Users\\me\\Pictures\\Снимок.png" };
        emit("capture", r);
      }, 400);
    },
    weather_get: () => (params.has("noweather") ? null : mockWeather()),
    city_search: () => [
      { name: "Казань", full: "Казань, Татарстан, Россия", lat: 55.79, lon: 49.12 },
      { name: "Казань", full: "Казань, Кировская область, Россия", lat: 58.1, lon: 49.6 },
    ],
    lyrics_get: () => "[00:00.00] Ночной проспект, огни вдали\n[01:00.00] Мы едем вдоль пустой реки\n[01:08.00] И город шепчет: не спеши\n[01:16.00] Пока играет midnight drive",
    mic_toggle: () => true,
    audio_devices: () => ({ outputs: [{ id: "o1", name: "Динамики (Realtek(R) High Definition Audio)", default: true }, { id: "o2", name: "Наушники AirPods", default: false }], inputs: [{ id: "i1", name: "Микрофонный массив (Intel® Smart Sound Technology)", default: true }] }),
    player_volume_get: () => 0.8,
    player_volume_set: () => true,
    bt_devices: () => [
      { id: "1", name: "AirPods Pro", connected: true, battery: 82, audio: true, container: "a" },
      { id: "2", name: "MX Master 3S", connected: true, battery: 45, audio: false, container: "b" },
      { id: "3", name: "JBL Flip 6", connected: false, battery: null, audio: true, container: "c" },
    ],
    bt_connect: () => null,
    vpn_status: () => mockVpn,
    vpn_names: () => ["Офис"],
    vpn_set: (a) => {
      mockVpn = a.on ? "Офис" : null;
    },
    launcher_hotkeys: () => [],
    hotkeys_list: () => [
      { action: "toggle", title: "Открыть или закрыть остров", default: "Ctrl+Alt+KeyI", combo: "Ctrl+Alt+KeyI", taken: false },
      { action: "mic", title: "Микрофон: выключить и включить", default: "Ctrl+Alt+KeyM", combo: "Ctrl+Alt+KeyM", taken: true },
      { action: "record", title: "Запись экрана", default: "Ctrl+Alt+KeyR", combo: "Ctrl+Alt+Shift+KeyR", taken: false },
    ],
    hotkey_set: () => null,
    hotkeys_pause: () => null,
    self_check: () => [
      { group: "Остров", title: "Горячие клавиши", status: "warn", detail: "заняты другой программой: Alt+Space" },
      { group: "Звук", title: "Микрофон сейчас", status: "warn", detail: "слушает: Discord.exe (это и есть оранжевая точка)" },
      { group: "Распознавание", title: "Речь в сети", status: "fail", detail: "выключено — диктовка Windows не запустится" },
      { group: "Сеть", title: "Погода", status: "ok", detail: "MET Norway отвечает" },
    ],
    doc_pick: () => [{ name: "Отчёт.pdf", text: "Выручка за ноябрь выросла на 12%…", error: null }],
    ai_key_status: (a) => Object.fromEntries((a.ids as string[]).map((i) => [i, i === "anthropic"])),
    ai_key_set: () => null,
    ai_chat: (a) => {
      const words = "Конечно! Вот коротко: остров показывает музыку, буфер обмена, погоду и статус агентов — и всё это без лишнего шума.".split(" ");
      words.forEach((w, i) => setTimeout(() => emit("ai_delta", { id: a.id, text: (i ? " " : "") + w }), 60 * i));
      setTimeout(() => emit("ai_done", { id: a.id, error: null }), 60 * words.length + 50);
    },
    ai_models: () => ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    clip_current_text: () => "ghbdtn? rfr ltkf&",
    paste_text: () => null,
    notifications_access: () => "allowed",
    note_get: () => note,
    note_set: (a) => {
      note = a.text as string;
    },
  };

  if (params.has("obs")) setTimeout(() => emit("obs", { connected: true, recording: true, streaming: false, paused: false }), 300);
  if (params.has("steam")) setTimeout(() => emit("downloads", [{ name: "Counter-Strike 2", size: 21e9, speed: 42e6, total: 34e9 }]), 300);

  return {
    call: async (cmd, args) => structuredClone(calls[cmd]?.(args ?? {})) as never,
    dragOut: () => {},
    getState: async () => structuredClone(state),
    setHitRect: (r) => {
      rect = r;
    },
    media,
    volumeSet: (l) => setVolume(l),
    volumeStep: (d) => setVolume(state.volume!.level + d),
    muteToggle: () => setVolume(state.volume!.level, !state.volume!.muted),
    on(event, cb) {
      const set = listeners.get(event) ?? new Set();
      set.add(cb as (p: unknown) => void);
      listeners.set(event, set);
      return () => set.delete(cb as (p: unknown) => void);
    },
  };
}

export const bridge: Promise<Bridge> = isTauri ? tauriBridge() : Promise.resolve(mockBridge());
