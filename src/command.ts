// Parsing for the command bar: calculator, unit conversion, timer phrases,
// system commands. Everything here is pure and runs in the browser.

/** A small, safe arithmetic evaluator: + - * / ^ % ( ) and a few functions. */
export function calc(src: string): number | null {
  const s = src.replace(/,/g, ".").replace(/×/g, "*").replace(/÷/g, "/").replace(/\s+/g, "").toLowerCase();
  if (!/[\d)]/.test(s) || !/[-+*/^%(]|sqrt|sin|cos|tan|log|ln|pi/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  const fns: Record<string, (x: number) => number> = {
    sqrt: Math.sqrt,
    sin: (x) => Math.sin((x * Math.PI) / 180),
    cos: (x) => Math.cos((x * Math.PI) / 180),
    tan: (x) => Math.tan((x * Math.PI) / 180),
    log: Math.log10,
    ln: Math.log,
    abs: Math.abs,
  };
  const num = (): number => {
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") throw new Error();
      i++;
      return v;
    }
    if (peek() === "-") {
      i++;
      return -factor();
    }
    if (s.startsWith("pi", i)) {
      i += 2;
      return Math.PI;
    }
    for (const name of Object.keys(fns)) {
      if (s.startsWith(name, i)) {
        i += name.length;
        return fns[name](num());
      }
    }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (!m) throw new Error();
    i += m[0].length;
    let v = Number(m[0]);
    if (peek() === "%") {
      i++;
      v /= 100;
    }
    return v;
  };
  const factor = (): number => {
    const base = num();
    if (peek() === "^") {
      i++;
      return Math.pow(base, factor());
    }
    return base;
  };
  const term = (): number => {
    let v = factor();
    while (peek() === "*" || peek() === "/") {
      const op = s[i++];
      v = op === "*" ? v * factor() : v / factor();
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      v = op === "+" ? v + term() : v - term();
    }
    return v;
  };
  try {
    const v = expr();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function fmtNumber(v: number) {
  const r = Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : String(+v.toPrecision(12));
  return r.replace(".", ",");
}

type Unit = { k: number; kind: string; o?: number };
const U: Record<string, Unit> = {};
const add = (kind: string, k: number, ...names: string[]) => names.forEach((n) => (U[n] = { k, kind }));
add("len", 0.001, "mm", "мм");
add("len", 0.01, "cm", "см");
add("len", 1, "m", "м", "метр", "метров", "метра");
add("len", 1000, "km", "км");
add("len", 0.0254, "in", "inch", "дюйм", "дюймов", "дюйма");
add("len", 0.3048, "ft", "фут", "футов", "фута");
add("len", 0.9144, "yd", "ярд", "ярдов");
add("len", 1609.344, "mi", "mile", "miles", "миля", "миль", "мили");
add("mass", 0.001, "g", "г", "гр");
add("mass", 1, "kg", "кг");
add("mass", 1000, "t", "т", "тонн", "тонна");
add("mass", 0.45359237, "lb", "lbs", "фунт", "фунтов", "фунта");
add("mass", 0.028349523, "oz", "унция", "унций", "унции");
add("data", 1, "b", "байт");
add("data", 1024, "kb", "кб");
add("data", 1024 ** 2, "mb", "мб");
add("data", 1024 ** 3, "gb", "гб");
add("data", 1024 ** 4, "tb", "тб");
add("time", 1, "s", "sec", "с", "сек", "секунд");
add("time", 60, "min", "мин", "минут", "минуты");
add("time", 3600, "h", "ч", "час", "часов", "часа");
add("time", 86400, "d", "дн", "день", "дней", "дня");
add("speed", 1 / 3.6, "kmh", "км/ч");
add("speed", 1, "m/s", "м/с");
add("speed", 0.44704, "mph");
add("vol", 0.001, "ml", "мл");
add("vol", 1, "l", "л", "литр", "литров", "литра");
add("vol", 3.785411784, "gal", "галлон", "галлонов");
// Russian word stems, so "в милях", "5 километров", "в фунтах" work too.
const STEMS: [string, string][] = [
  ["миллиметр", "mm"], ["сантиметр", "cm"], ["километр", "km"], ["метр", "m"], ["мил", "mi"], ["фут", "ft"],
  ["дюйм", "in"], ["ярд", "yd"], ["килограмм", "kg"], ["грамм", "g"], ["тонн", "t"], ["фунт", "lb"], ["унци", "oz"],
  ["миллилитр", "ml"], ["литр", "l"], ["галлон", "gal"], ["килобайт", "kb"], ["мегабайт", "mb"], ["гигабайт", "gb"],
  ["терабайт", "tb"], ["байт", "b"], ["секунд", "s"], ["минут", "min"], ["час", "h"], ["дн", "d"], ["день", "d"],
  ["цельси", "c"], ["фаренгейт", "f"], ["кельвин", "k"],
];
function unit(word: string): string {
  if (U[word] || TEMP[word]) return word;
  const hit = STEMS.filter(([stem]) => word.startsWith(stem)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? hit[1] : word;
}

const TEMP: Record<string, string> = { c: "c", "°c": "c", ц: "c", "°с": "c", f: "f", "°f": "f", k: "k", к: "k" };

export function convert(q: string): { text: string; value: string } | null {
  const m = /^(-?[\d.,]+)\s*([a-zа-яё°/]+)\s+(?:в|in|to|->)\s+([a-zа-яё°/]+)$/i.exec(q.trim().toLowerCase());
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  if (!Number.isFinite(v)) return null;
  const [from, to] = [unit(m[2]), unit(m[3])];
  if (TEMP[from] && TEMP[to]) {
    const c = TEMP[from] === "c" ? v : TEMP[from] === "f" ? ((v - 32) * 5) / 9 : v - 273.15;
    const r = TEMP[to] === "c" ? c : TEMP[to] === "f" ? (c * 9) / 5 + 32 : c + 273.15;
    return { text: `${fmtNumber(v)} ${from} = ${fmtNumber(+r.toFixed(2))} ${to}`, value: fmtNumber(+r.toFixed(2)) };
  }
  const a = U[from];
  const b = U[to];
  if (!a || !b || a.kind !== b.kind) return null;
  const r = (v * a.k) / b.k;
  return { text: `${fmtNumber(v)} ${from} = ${fmtNumber(r)} ${to}`, value: fmtNumber(r) };
}

/** "таймер 10 мин", "timer 90s", "таймер 1 ч" → ms */
export function timerPhrase(q: string): number | null {
  const m = /^(?:таймер|timer)\s+(\d+(?:[.,]\d+)?)\s*(с|сек|секунд|s|sec|м|мин|минут|m|min|ч|час|часа|часов|h)?$/i.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  const u = (m[2] ?? "мин").toLowerCase();
  const k = /^(с|сек|секунд|s|sec)$/.test(u) ? 1000 : /^(ч|час|часа|часов|h)$/.test(u) ? 3_600_000 : 60_000;
  return n > 0 ? n * k : null;
}

export type SystemCmd = { id: string; title: string; words: string[] };
export const SYSTEM: SystemCmd[] = [
  { id: "wifi", title: "Wi-Fi: включить или выключить", words: ["wifi", "wi-fi", "вайфай", "вай-фай"] },
  { id: "bluetooth", title: "Bluetooth: включить или выключить", words: ["bluetooth", "блютуз", "блютус"] },
  { id: "dark", title: "Тема Windows: тёмная или светлая", words: ["тема", "theme", "dark", "тёмная", "темная"] },
  { id: "lock", title: "Заблокировать компьютер", words: ["lock", "заблокировать", "блокировка"] },
  { id: "sleep", title: "Сон", words: ["sleep", "сон", "спать"] },
  { id: "settings", title: "Настройки острова", words: ["настройки", "settings"] },
  { id: "clipboard", title: "История буфера", words: ["буфер", "clipboard", "clip"] },
];
