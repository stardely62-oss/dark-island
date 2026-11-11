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
};

export interface Bridge {
  getState(): Promise<Snapshot>;
  setHitRect(rect: Rect): void;
  media(action: MediaAction): void;
  volumeSet(level: number): void;
  volumeStep(delta: number): void;
  muteToggle(): void;
  on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): () => void;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriBridge(): Promise<Bridge> {
  const { invoke } = await import("@tauri-apps/api/core");
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

  return {
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
