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
