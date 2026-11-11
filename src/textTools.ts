// Local text tools: no network.

const EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,./~QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>?@#$^&";
const RU = "ёйцукенгшщзхъфывапролджэячсмитьбю.ЁЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ,\"№;:?";

/** Text typed in the wrong layout ("ghbdtn" ↔ "привет"); direction is guessed. */
export function fixLayout(s: string) {
  const latin = (s.match(/[a-z]/gi) ?? []).length;
  const cyr = (s.match(/[а-яё]/gi) ?? []).length;
  const [from, to] = latin >= cyr ? [EN, RU] : [RU, EN];
  return [...s].map((c) => {
    const i = from.indexOf(c);
    return i >= 0 ? to[i] : c;
  }).join("");
}

const TR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};
export function translit(s: string) {
  return [...s]
    .map((c) => {
      const low = c.toLowerCase();
      const t = TR[low];
      if (t === undefined) return c;
      return c === low ? t : t.charAt(0).toUpperCase() + t.slice(1);
    })
    .join("");
}

export const sentence = (s: string) => s.toLowerCase().replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
export const title = (s: string) => s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, a, b) => a + b.toUpperCase());

export function prettyJson(s: string) {
  return JSON.stringify(JSON.parse(s), null, 2);
}
export function minJson(s: string) {
  return JSON.stringify(JSON.parse(s));
}
export function b64enc(s: string) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
export function b64dec(s: string) {
  return new TextDecoder().decode(Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0)));
}
