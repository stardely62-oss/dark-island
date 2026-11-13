import { lang, locale, t } from "./i18n";
// Reminders typed as one phrase: "позвонить маме завтра в 9",
// "таблетки каждый день в 23:00", "через 20 минут выключить плиту".

export type Reminder = {
  id: string;
  text: string;
  /** Next time it fires (ms). */
  at: number;
  /** Repeats on these weekdays (0 = Sunday) at `time`. */
  repeat?: { days: number[]; time: string };
};

const WEEKDAYS: [RegExp, number][] = [
  [/понедельник[а-яё]*/, 1],
  [/вторник[а-яё]*/, 2],
  [/сред[уаы][а-яё]*/, 3],
  [/четверг[а-яё]*/, 4],
  [/пятниц[а-яё]*/, 5],
  [/суббот[а-яё]*/, 6],
  [/воскресень[а-яё]*/, 0],
  [/monday/, 1],
  [/tuesday/, 2],
  [/wednesday/, 3],
  [/thursday/, 4],
  [/friday/, 5],
  [/saturday/, 6],
  [/sunday/, 0],
];

export function parseReminder(src: string, now = new Date()): Reminder | null {
  let s = ` ${src.trim()} `.replace(/\s+/g, " ");
  const low = () => s.toLowerCase();
  const cut = (re: RegExp) => {
    const m = re.exec(low());
    if (!m) return null;
    s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return m;
  };
  cut(/^ напомни(ть)?( мне)?,? /) ?? cut(/^ remind( me)?( to)?,? /);

  let repeat: Reminder["repeat"];
  let days: number[] | null = null;
  if (cut(/ (каждый день|ежедневно|everyday|every day|daily) /)) days = [0, 1, 2, 3, 4, 5, 6];
  else if (cut(/ (по будням|on weekdays|weekdays|every weekday) /)) days = [1, 2, 3, 4, 5];
  else if (cut(/ (по выходным|on weekends|weekends|every weekend) /)) days = [0, 6];
  else {
    for (const [re, d] of WEEKDAYS) {
      if (cut(new RegExp(` (каждый|каждую|каждое|по|every) ${re.source}s? `))) {
        days = [d];
        break;
      }
    }
  }

  // "через 20 минут", "через полчаса", "через 2 часа"
  const rel = cut(/ через (\d+(?:[.,]\d+)?|полчаса|час|минуту)\s*(минут[а-яё]*|мин|час[а-яё]*|ч|секунд[а-яё]*|сек)? /);
  // "in 20 minutes", "in half an hour", "in 2 hours"
  const relEn = rel ? null : cut(/ in (\d+(?:[.,]\d+)?|half an hour|an hour|a minute)\s*(minutes?|mins?|hours?|hrs?|h|seconds?|secs?)? /);
  if (relEn && !days) {
    const w = relEn[1];
    let n = w === "half an hour" ? 30 : w === "an hour" ? 60 : w === "a minute" ? 1 : Number(w.replace(",", "."));
    const unit = relEn[2] ?? "min";
    if (/^h/.test(unit)) n *= 60;
    if (/^sec/.test(unit)) n /= 60;
    const text = s.trim();
    return text ? { id: id(), text, at: now.getTime() + n * 60_000 } : null;
  }
  if (rel && !days) {
    let n = rel[1] === "полчаса" ? 30 : rel[1] === "час" ? 60 : rel[1] === "минуту" ? 1 : Number(rel[1].replace(",", "."));
    const unit = rel[2] ?? (rel[1] === "полчаса" || rel[1] === "час" || rel[1] === "минуту" ? "мин" : "мин");
    if (/^ч|^час/.test(unit)) n *= 60;
    if (/^сек/.test(unit)) n /= 60;
    const text = s.trim();
    return text ? { id: id(), text, at: now.getTime() + n * 60_000 } : null;
  }

  let dayOffset: number | null = null;
  if (cut(/ (послезавтра|the day after tomorrow) /)) dayOffset = 2;
  else if (cut(/ (завтра|tomorrow) /)) dayOffset = 1;
  else if (cut(/ (сегодня|today|tonight) /)) dayOffset = 0;
  let weekday: number | null = null;
  if (dayOffset === null && !days) {
    for (const [re, d] of WEEKDAYS) {
      if (cut(new RegExp(` (?:во?|on|next) ${re.source} `))) {
        weekday = d;
        break;
      }
    }
  }

  // "в 9", "в 9:30", "в 21.15", "в 7 вечера", "к 18:00"
  const t = cut(/ (?:в|к|at|by) (\d{1,2})(?:[:.](\d{2}))?\s*(утра|дня|вечера|ночи|am|pm|a\.m\.|p\.m\.)? /) ?? cut(/ (\d{1,2}):(\d{2})\s*(am|pm)? /);
  let hh = 9;
  let mm = 0;
  const hasTime = !!t;
  if (t) {
    hh = Number(t[1]);
    mm = Number(t[2] ?? 0);
    const part = t[3];
    if ((part === "вечера" || part === "дня" || part?.startsWith("p")) && hh < 12) hh += 12;
    if ((part === "ночи" || part?.startsWith("a")) && hh === 12) hh = 0;
  }
  if (hh > 23 || mm > 59) return null;
  const text = s.trim().replace(/^[,.\s-]+|[,.\s-]+$/g, "");
  if (!text || (!hasTime && dayOffset === null && weekday === null && !days)) return null;

  const at = new Date(now);
  at.setSeconds(0, 0);
  at.setHours(hh, mm);
  if (days) {
    repeat = { days, time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}` };
    return { id: id(), text, at: nextRepeat(repeat, now), repeat };
  }
  if (dayOffset !== null) at.setDate(at.getDate() + dayOffset);
  else if (weekday !== null) {
    let add = (weekday - at.getDay() + 7) % 7;
    if (add === 0 && at.getTime() <= now.getTime()) add = 7;
    at.setDate(at.getDate() + add);
  } else if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return { id: id(), text, at: at.getTime() };
}

export function nextRepeat(r: NonNullable<Reminder["repeat"]>, after = new Date()): number {
  const [hh, mm] = r.time.split(":").map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(after);
    d.setDate(d.getDate() + i);
    d.setHours(hh, mm, 0, 0);
    if (r.days.includes(d.getDay()) && d.getTime() > after.getTime()) return d.getTime();
  }
  return after.getTime() + 86_400_000;
}

const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const DAY = () => (lang === "en" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] : ["вс", "пн", "вт", "ср", "чт", "пт", "сб"]);
export function describeWhen(r: Reminder, now = new Date()) {
  const d = new Date(r.at);
  const time = d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (r.repeat) {
    const days = r.repeat.days.length === 7 ? t("каждый день") : r.repeat.days.join() === "1,2,3,4,5" ? t("по будням") : r.repeat.days.map((x) => DAY()[x]).join(", ");
    return t("{0} в {1}", days, r.repeat.time);
  }
  const t0 = new Date(now);
  t0.setHours(0, 0, 0, 0);
  const diff = Math.floor((d.getTime() - t0.getTime()) / 86_400_000);
  const day = diff === 0 ? t("сегодня") : diff === 1 ? t("завтра") : d.toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" });
  return t("{0} в {1}", day, time);
}
