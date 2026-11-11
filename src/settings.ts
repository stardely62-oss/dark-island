import { useCallback, useEffect, useState } from "react";
import type { Bridge } from "./ipc";

/** Defaults live here; Rust only stores what the user changed. */
export const DEFAULTS = {
  stripOverWindows: true,
  hideInGames: true,
  agents: true,
  agentsAnswer: true,
  clipboardHistory: true,
  clipSkipApps: [] as string[],
  searchEngine: "google",
  cardLength: "normal" as "short" | "normal" | "long",
  weatherOnPill: true,
  rainWarning: true,
  lyrics: false,
  musicPill: "compact" as "compact" | "wide" | "player" | "lyrics" | "line",
  showNotifications: false,
  notifyMuted: [] as string[],
  vpnCountry: true,
  autoHide: false,
  hideForApps: [] as string[],
  through: false,
  launcher: [] as Shortcut[],
  vpnClient: "app" as "app" | "windows" | "warp" | "custom",
  vpnApp: "",
  vpnAppName: "",
  vpnName: "",
  vpnOn: "",
  vpnOff: "",
  vpnAdmin: false,
  recordFormat: "mp4" as "mp4" | "gif",
  recordSound: "none" as "none" | "system" | "mic",
  buddyLife: true,
  buddySounds: false,
  buddyScale: 1.6,
  buddyColor: "#d97757",
  buddyHat: "none",
  buddyName: "Клодик",
  obsEnabled: false,
  obsPort: "4455",
};
export type Shortcut = {
  name: string;
  kind: "app" | "url" | "path" | "group";
  target: string;
  /** Global hotkey that opens it, e.g. "Ctrl+Alt+Digit1". */
  hotkey?: string;
  /** A group's shortcuts. */
  items?: Shortcut[];
};
export type Settings = typeof DEFAULTS & Record<string, unknown>;

export const ENGINES: Record<string, { name: string; url: string }> = {
  google: { name: "Google", url: "https://www.google.com/search?q=%s" },
  yandex: { name: "Яндекс", url: "https://yandex.ru/search/?text=%s" },
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=%s" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=%s" },
};

export function useSettings(api: Bridge | null) {
  const [values, setValues] = useState<Settings>(DEFAULTS as Settings);
  useEffect(() => {
    if (!api) return;
    api.call<Record<string, unknown>>("settings_get").then((v) => setValues({ ...DEFAULTS, ...(v ?? {}) } as Settings));
    return api.on("settings", (v) => setValues({ ...DEFAULTS, ...v } as Settings));
  }, [api]);
  const set = useCallback(
    (patch: Partial<Settings>) => {
      setValues((v) => ({ ...v, ...patch }));
      api?.call("settings_set", { patch });
    },
    [api],
  );
  return [values, set] as const;
}

/** The island's own theme: dark, light, or as Windows has it. */
export function applyTheme(theme: string) {
  const light = theme === "light" || (theme === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  document.documentElement.classList.toggle("theme-light", light);
}
