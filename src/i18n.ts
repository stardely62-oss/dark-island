import { EN } from "./i18n.en";

/**
 * The interface language. Texts are written in Russian in the code and
 * looked up in a dictionary for English. Chosen in the settings ("Язык
 * интерфейса"); by default it follows Windows. All windows read it at
 * start from local storage, so a change reloads them.
 */
export type Lang = "ru" | "en";
const KEY = "island.lang";

export function langSetting(): "auto" | Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "ru" || v === "en") return v;
  } catch {
    /* no storage */
  }
  return "auto";
}
function detect(): Lang {
  const v = langSetting();
  if (v !== "auto") return v;
  // Russian when Windows has Russian (or a neighbouring language) anywhere
  // among the user's languages: an English Windows with a Russian keyboard
  // is usually a Russian speaker.
  const all = [...(navigator.languages ?? []), navigator.language ?? ""].map((l) => l.toLowerCase());
  return all.some((l) => /^(ru|uk|be|kk|ky|uz|tg|hy|az|ka)\b/.test(l)) ? "ru" : "en";
}
export const lang: Lang = detect();
/** For dates and numbers. */
export const locale = lang === "en" ? "en-GB" : "ru-RU";

/** Stores the choice; the caller reloads. Returns whether the language actually changes. */
export function setLang(v: "auto" | Lang): boolean {
  try {
    if (v === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    /* no storage */
  }
  return detect() !== lang;
}

/** The text in the interface language; {0}, {1}… are filled with `args`. */
export function t(ru: string, ...args: unknown[]): string {
  let s = lang === "en" ? EN[ru] ?? ru : ru;
  for (let i = 0; i < args.length; i++) s = s.split(`{${i}}`).join(String(args[i]));
  return s;
}
