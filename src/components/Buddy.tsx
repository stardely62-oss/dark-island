// Клодик: a tiny pixel-art companion in the spirit of Claude Code's mascot:
// a terracotta block with two tall eyes, little arms and four legs.
//
// He has a life of his own: breathes and blinks, and every so often does
// something on a whim (looks around, hops, waves, stretches, yawns, turns
// round, shuffles). He shows emotions when things happen (surprise at a
// notification, joy when an agent is done, anger at an error, fury when
// poked too much, love when petted, boredom when nobody comes by, tiredness
// on a low battery), dances to the beat, types for an agent, sleeps while
// you are away. All of it is CSS on the classes set here.

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Liquid } from "../liquid";
import { setSounds, sfx } from "./buddySounds";
export { sfx };

const C = "#d97757";
const INK = "#1a1a1a";
const PINK = "#ff6f9c";

/** One pixel. */
const P = ({ x, y, w = 1, h = 1, fill = C }: { x: number; y: number; w?: number; h?: number; fill?: string }) => (
  <rect x={x} y={y} width={w} height={h} fill={fill} />
);

/** work: typing for an agent; ask: waiting for your answer; done: pleased. */
export type Mood = "work" | "ask" | "done" | null;

/** Short emotions that something caused. */
export type Reaction =
  | "happy"
  | "excited"
  | "surprised"
  | "angry"
  | "furious"
  | "love"
  | "ears"
  | "hop"
  /** Out of the pill while he climbs over the screen edge… */
  | "away"
  /** …and back: he falls onto his place from above. */
  | "plop"
  /** Scrolled over: his head spins. */
  | "dizzy"
  /** The charger went in: he gets a jolt of energy. */
  | "charged";

// ---------------------------------------------------------------- the life ----

type Timed = { name: string; until: number } | null;
let reaction: Timed = null;
let action: Timed = null;
/** A lasting state: bored, tired. */
let state: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Whims, with how long they last (ms) and how often they come up. */
const WHIMS: [string, number, number][] = [
  ["look", 2200, 5],
  ["hop", 700, 3],
  ["wave", 1600, 2],
  ["stretch", 1400, 2],
  ["yawn", 1800, 2],
  ["turn", 1800, 2],
  ["shuffle", 2000, 3],
  ["sit", 2400, 2],
  ["scratch", 1400, 2],
  ["dance", 2400, 2],
  ["spin", 1100, 2],
  ["flip", 1000, 1],
  ["peek", 2200, 2],
  ["sneeze", 1300, 1],
  ["march", 2600, 2],
  ["work", 2600, 2],
  ["nod", 2400, 1],
  ["wiggle", 1500, 2],
  ["eat", 3200, 1],
  ["crave", 3200, 0],
  // Things he does with things: a little resident of the computer.
  ["paper", 4200, 4],
  ["magnify", 4600, 4],
  ["coffee", 4000, 3],
  ["read", 5200, 3],
  ["laptop", 4400, 3],
  ["sweep", 4000, 3],
  ["juggle", 3600, 3],
  ["water", 4600, 3],
  ["think", 3600, 3],
  ["ball", 3600, 2],
  ["kite", 3000, 1],
];

/** How he looks and whether he lives on his own; set from the settings. */
export type BuddyLook = {
  life: boolean;
  color: string;
  hat: string;
  name: string;
  /** What the weather outside asks for: rain → umbrella, snow → scarf, hot → sunglasses. */
  weather: "" | "rain" | "snow" | "hot";
  /** Your birthday as "MM-DD", or "". */
  birthday: string;
  /** Loud music is on: he puts headphones on (unless he wears something). */
  music: boolean;
};
let look: BuddyLook = { life: true, color: C, hat: "none", name: "Клодик", weather: "", birthday: "", music: false };

// ------------------------------------------------------------------ the pet ----

function fresh(): Pet {
  return { fed: Date.now(), love: 0, asleep: false, born: Date.now(), counts: {}, hats: [], stickers: {} };
}

/** A pet's needs, kept on this computer: when he last ate, how close you are, whether he sleeps. */
type Pet = {
  fed: number;
  love: number;
  asleep: boolean;
  /** When you met (his birthday). */
  born: number;
  /** How many times things happened, for the stickers. */
  counts: Record<string, number>;
  /** Outfits he has tried on. */
  hats: string[];
  /** Stickers you have, with when they were got. */
  stickers: Record<string, number>;
};
const PET_KEY = "island.pet";
const HUNGRY_AFTER = 4 * 3600_000;
let pet: Pet = (() => {
  try {
    return { ...fresh(), ...JSON.parse(localStorage.getItem(PET_KEY) ?? "{}") };
  } catch {
    return fresh();
  }
})();
function savePet() {
  try {
    localStorage.setItem(PET_KEY, JSON.stringify(pet));
  } catch {
    /* no storage: he simply forgets */
  }
}
const isHungry = () => look.life && Date.now() - pet.fed > HUNGRY_AFTER;
/** Friendship from 0 to 10 hearts. */
export const hearts = () => Math.min(10, Math.floor(Math.sqrt(pet.love)));

/** Seasons dress him up when he wears nothing of his own. */
/** Whose birthday it is today, if anyone's: yours, or his (a year and more after you met). */
export function birthdayToday(now = new Date()): "user" | "buddy" | null {
  const md = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (look.birthday && look.birthday === md) return "user";
  const b = new Date(pet.born);
  if (now.getFullYear() > b.getFullYear() && b.getMonth() === now.getMonth() && b.getDate() === now.getDate()) return "buddy";
  return null;
}
export const buddyAge = () => new Date().getFullYear() - new Date(pet.born).getFullYear();

// ---- stickers ----

export type Sticker = { id: string; title: string; hint: string; icon: string; color: string };
export const STICKERS: Sticker[] = [
  { id: "first", title: "Знакомство", hint: "Познакомиться", icon: "★", color: "#ffd84a" },
  { id: "feed10", title: "Сытый", hint: "Покормить 10 раз", icon: "●", color: "#c98a4b" },
  { id: "pet25", title: "Любимчик", hint: "Погладить 25 раз", icon: "♥", color: "#ff6f9c" },
  { id: "play10", title: "Игрок", hint: "Поиграть 10 раз", icon: "◓", color: "#ff8fb4" },
  { id: "furious", title: "Не тронь!", hint: "Довести его до бешенства", icon: "!", color: "#ff4d3d" },
  { id: "dizzy5", title: "Карусель", hint: "Закружить ему голову 5 раз", icon: "@", color: "#c27ce0" },
  { id: "fashion", title: "Модник", hint: "Примерить 5 нарядов", icon: "♛", color: "#f5c451" },
  { id: "owl", title: "Ночная сова", hint: "Заглянуть к нему с 2 до 4 ночи", icon: "☾", color: "#6f8dff" },
  { id: "lark", title: "Жаворонок", hint: "Заглянуть к нему с 5 до 7 утра", icon: "☼", color: "#ffb347" },
  { id: "week", title: "Неделя вместе", hint: "7 дней вместе", icon: "7", color: "#7cbf5a" },
  { id: "month", title: "Месяц вместе", hint: "30 дней вместе", icon: "30", color: "#4fb3c8" },
  { id: "friends", title: "Лучшие друзья", hint: "Набрать 10 сердечек", icon: "♥♥", color: "#ff5f93" },
  { id: "focus4", title: "Фокус", hint: "Пройти 4 помидора подряд", icon: "◷", color: "#e0445e" },
  { id: "rest", title: "Перерыв", hint: "Отдохнуть, когда он попросит", icon: "≈", color: "#9fd8ff" },
  { id: "gamer", title: "Удачи!", hint: "Он проводил тебя в игру", icon: "►", color: "#59a85c" },
  { id: "bday", title: "Праздник", hint: "Отметить день рождения", icon: "✦", color: "#ff9f43" },
];

const DAY = 86_400_000;
function earned(id: string): boolean {
  const c = (k: string) => pet.counts[k] ?? 0;
  const days = (Date.now() - pet.born) / DAY;
  switch (id) {
    case "first": return true;
    case "feed10": return c("feed") >= 10;
    case "pet25": return c("pet") >= 25;
    case "play10": return c("play") >= 10;
    case "furious": return c("furious") >= 1;
    case "dizzy5": return c("dizzy") >= 5;
    case "fashion": return pet.hats.length >= 5;
    case "owl": return c("owl") >= 1;
    case "lark": return c("lark") >= 1;
    case "week": return days >= 7;
    case "month": return days >= 30;
    case "friends": return hearts() >= 10;
    case "focus4": return c("pomodoro") >= 4;
    case "rest": return c("rest") >= 1;
    case "gamer": return c("game") >= 1;
    case "bday": return c("bday") >= 1;
  }
  return false;
}
/** Gives the stickers just earned; each new one is announced. */
function checkStickers() {
  let fresh = false;
  for (const st of STICKERS) {
    if (pet.stickers[st.id] || !earned(st.id)) continue;
    pet.stickers[st.id] = Date.now();
    fresh = true;
    window.dispatchEvent(new CustomEvent("buddy-sticker", { detail: st }));
  }
  if (fresh) {
    savePet();
    buddy.react("excited", 1800);
  }
}

function seasonalHat() {
  if (birthdayToday()) return "party";
  if (look.music) return "headphones";
  const d = new Date();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if ((m === 12 && day >= 20) || (m === 1 && day <= 10)) return "santa";
  if (m === 10 && day >= 24) return "witch";
  return "none";
}
export const HATS: [string, string][] = [
  ["none", "Без"],
  ["cap", "Кепка"],
  ["beanie", "Шапка"],
  ["bow", "Бантик"],
  ["crown", "Корона"],
  ["tophat", "Цилиндр"],
  ["party", "Колпак"],
  ["headphones", "Наушники"],
  ["glasses", "Очки"],
  ["flower", "Цветок"],
  ["santa", "Дед Мороз"],
  ["witch", "Ведьма"],
];
export const COLORS: [string, string][] = [
  ["#d97757", "Терракота"],
  ["#e8a13a", "Мёд"],
  ["#7cbf5a", "Мох"],
  ["#4fb3c8", "Море"],
  ["#6f8dff", "Сирень"],
  ["#c27ce0", "Слива"],
  ["#ff7fa8", "Зефир"],
  ["#9aa0a6", "Графит"],
];

/** "work" or "rest" while a pomodoro runs: he works with you, then rests. */
let focus: "work" | "rest" | null = null;
const WORK = ["laptop", "paper", "read", "think", "magnify"];
const REST = ["coffee", "juggle", "ball", "kite", "dance", "water"];

/** Whims weigh differently by the hour: coffee in the morning, nodding off at night. */
function weight(name: string, w: number) {
  if (focus === "work") return WORK.includes(name) ? w * 6 : w * 0.2;
  if (focus === "rest") return REST.includes(name) ? w * 5 : w * 0.3;
  const h = new Date().getHours();
  if (h >= 6 && h < 11 && name === "coffee") return w * 3;
  if ((h >= 23 || h < 5) && (name === "nod" || name === "yawn")) return w * 3;
  if (h >= 9 && h < 19 && (name === "laptop" || name === "paper")) return w * 1.5;
  if (h >= 12 && h < 14 && name === "eat") return w * 4;
  if (isHungry() && name === "crave") return 30;
  return w;
}

let lifeStarted = false;
function startLife() {
  if (lifeStarted) return;
  lifeStarted = true;
  // Hunger comes with time: look again every minute.
  window.setInterval(() => {
    checkStickers();
    notify();
  }, 60_000);
  window.setTimeout(checkStickers, 2500);
  const next = () => {
    const wait = 4000 + Math.random() * 9000;
    window.setTimeout(() => {
      const now = Date.now();
      if (look.life && !pet.asleep && !(reaction && reaction.until > now) && !(action && action.until > now)) {
        const pool = (state === "bored" ? [["sigh", 2600, 1] as [string, number, number], ...WHIMS.filter(([n]) => n === "look" || n === "sit" || n === "yawn")] : WHIMS).map(
          ([n, ms, w]) => [n, ms, weight(n, w)] as [string, number, number],
        );
        const total = pool.reduce((s, w) => s + w[2], 0);
        let r = Math.random() * total;
        const pick = pool.find((w) => (r -= w[2]) < 0) ?? pool[0];
        action = { name: pick[0], until: now + pick[1] };
        notify();
        window.setTimeout(notify, pick[1] + 30);
      }
      next();
    }, wait);
  };
  next();
}

export const buddy = {
  /** A short emotion everyone sees. */
  react(name: Reaction, ms = 1600) {
    if (name !== "away") sfx(name === "hop" ? "hop2" : name);
    reaction = { name, until: Date.now() + ms };
    action = null;
    notify();
    window.setTimeout(notify, ms + 30);
  },
  /** Something to do because something happened (a copy → he files the paper). */
  act(name: string, ms = 4000) {
    if (!look.life) return;
    sfx(name);
    action = { name, until: Date.now() + ms };
    notify();
    window.setTimeout(notify, ms + 30);
  },
  configure(l: Partial<BuddyLook> & { sounds?: boolean }) {
    if (l.sounds !== undefined) setSounds(l.sounds);
    if (l.hat && l.hat !== "none" && l.hat !== look.hat && !pet.hats.includes(l.hat)) {
      pet.hats.push(l.hat);
      savePet();
      checkStickers();
    }
    look = { ...look, ...l };
    document.documentElement.style.setProperty("--bd-color", look.color);
    if (!look.life) action = null;
    notify();
  },
  get look() {
    return look;
  },
  /** Something happened that counts for stickers (also: who visits him at night or at dawn). */
  count(name: string, n = 1) {
    pet.counts[name] = (pet.counts[name] ?? 0) + n;
    if (["feed", "pet", "play", "dizzy", "poke"].includes(name)) {
      const h = new Date().getHours();
      if (h >= 2 && h < 4) pet.counts.owl = (pet.counts.owl ?? 0) + 1;
      if (h >= 5 && h < 7) pet.counts.lark = (pet.counts.lark ?? 0) + 1;
    }
    savePet();
    checkStickers();
  },
  /** A pomodoro phase: what he busies himself with follows yours. */
  setFocus(f: "work" | "rest" | null) {
    focus = f;
  },
  get stickers() {
    return { ...pet.stickers };
  },
  /** A cookie: he chomps it and likes you more. */
  feed() {
    buddy.count("feed");
    pet.fed = Date.now();
    pet.love += 3;
    pet.asleep = false;
    savePet();
    reaction = null;
    action = { name: "eat", until: Date.now() + 3200 };
    sfx("eat");
    notify();
    window.setTimeout(() => buddy.react("love", 1800), 3200);
  },
  /** A ball to kick around. */
  play() {
    buddy.count("play");
    pet.love += 2;
    pet.asleep = false;
    savePet();
    reaction = null;
    action = { name: "ball", until: Date.now() + 3600 };
    sfx("ball");
    notify();
    window.setTimeout(() => buddy.react("excited", 1400), 3600);
  },
  /** Puts him to bed (nightcap and all) or wakes him up. */
  toggleSleep() {
    pet.asleep = !pet.asleep;
    savePet();
    action = null;
    if (!pet.asleep) buddy.react("surprised", 900);
    else {
      sfx("sleep");
      notify();
    }
  },
  /** Petting and the like count towards friendship. */
  befriend(n = 1) {
    pet.love += n;
    savePet();
    notify();
  },
  get pet() {
    return { ...pet, hungry: isHungry(), hearts: hearts() };
  },
  /** bored, tired or nothing. */
  setState(s: string | null) {
    if (s === state) return;
    state = s;
    notify();
  },
};

function snapshot() {
  const now = Date.now();
  const re = reaction && reaction.until > now ? reaction.name : "";
  const act = action && action.until > now ? action.name : "";
  const hat = look.hat === "none" ? seasonalHat() : look.hat;
  const st = pet.asleep ? "" : isHungry() ? "hungry" : look.life ? (state ?? "") : "";
  return `${re}|${look.life && !pet.asleep ? act : ""}|${st}|${pet.asleep ? "nightcap" : hat}|${look.name}|${look.weather}|${pet.asleep ? 1 : 0}|${hearts()}|${Object.keys(pet.stickers).length}`;
}

function useLife() {
  const subscribe = useCallback((cb: () => void) => {
    startLife();
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, []);
  return useSyncExternalStore(subscribe, snapshot).split("|");
}

/** The pet's needs for the settings page, kept fresh. */
export function usePet() {
  useLife();
  return buddy.pet;
}

// ------------------------------------------------------------- the sprite ----

export function Buddy({
  size = 26,
  sleeping = false,
  mood = null,
  className = "",
  still = false,
  wear,
  tint,
}: {
  size?: number;
  sleeping?: boolean;
  mood?: Mood;
  className?: string;
  /** No whims or reactions (e.g. a copy in flight). */
  still?: boolean;
  /** Shows him in this hat instead of his own (settings previews). */
  wear?: string;
  /** Shows him in this colour instead of his own (settings previews). */
  tint?: string;
}) {
  const [re, act, st, hat, name, wx, asleepS] = useLife();
  const asleep = asleepS === "1" && !still;
  const hover = useRef(0);
  const pet = useRef({ lastX: 0, dir: 0, flips: 0, since: 0 });
  const poke = useRef({ n: 0, since: 0 });

  // Petting: stroke him back and forth.
  const onMove = (e: React.PointerEvent) => {
    const p = pet.current;
    const now = Date.now();
    // A cursor that rests on him gets a wave.
    clearTimeout(hover.current);
    hover.current = window.setTimeout(() => look.life && buddy.act("wave", 1600), 1300);
    const dx = e.clientX - p.lastX;
    p.lastX = e.clientX;
    if (Math.abs(dx) < 1.5) return;
    const dir = Math.sign(dx);
    if (now - p.since > 900) {
      p.flips = 0;
      p.since = now;
    }
    if (dir !== p.dir) {
      p.dir = dir;
      p.flips++;
      p.since = now;
      if (p.flips >= 4) {
        p.flips = 0;
        buddy.react("love", 2600);
        buddy.befriend(1);
        buddy.count("pet");
      }
    }
  };
  // Scrolling over him makes his head spin; a double click is a trick.
  const onWheel = () => {
    if (!(reaction && reaction.name === "dizzy" && reaction.until > Date.now())) buddy.count("dizzy");
    buddy.react("dizzy", 1600);
  };
  const onDouble = (e: React.MouseEvent) => {
    e.stopPropagation();
    const tricks = ["flip", "spin", "dance", "juggle"];
    action = { name: tricks[Math.floor(Math.random() * tricks.length)], until: Date.now() + 2400 };
    reaction = null;
    notify();
    window.setTimeout(notify, 2430);
  };
  // Poking: once is a surprise, a few times annoys him, many times makes him furious.
  const onClick = (e: React.MouseEvent) => {
    // On the collapsed pill a click still opens the island; he just notices it.
    if (!(e.currentTarget as Element).closest(".compact")) e.stopPropagation();
    const k = poke.current;
    const now = Date.now();
    k.n = now - k.since < 1500 ? k.n + 1 : 1;
    k.since = now;
    if (k.n === 7) buddy.count("furious");
    if (k.n >= 7) buddy.react("furious", 2600);
    else if (k.n >= 4) buddy.react("angry", 1800);
    else buddy.react(k.n === 1 ? "surprised" : "hop", 900);
  };

  const classes = [
    "buddy",
    className,
    (sleeping || asleep) && !mood && !re ? "sleep" : "",
    wx && !still ? `wx-${wx}` : "",
    mood ? `mood-${mood}` : "",
    !still && re ? `re-${re}` : "",
    !still && !re && act && !mood && !sleeping ? `act-${act}` : "",
    !still && st && !re && !mood && !sleeping ? `st-${st}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      className={classes}
      style={tint ? ({ "--bd-color": tint } as React.CSSProperties) : undefined}
      width={size}
      height={(size * 11) / 15}
      viewBox="0 0 15 11"
      shapeRendering="crispEdges"
      aria-hidden
      onPointerMove={still ? undefined : onMove}
      onPointerEnter={still ? undefined : () => window.dispatchEvent(new CustomEvent("buddy-hover", { detail: true }))}
      onPointerLeave={
        still
          ? undefined
          : () => {
              clearTimeout(hover.current);
              window.dispatchEvent(new CustomEvent("buddy-hover", { detail: false }));
            }
      }
      onClick={still ? undefined : onClick}
      onDoubleClick={still ? undefined : onDouble}
      onWheel={still ? undefined : onWheel}
    >
      {!still && <title>{name}</title>}
      <g className="bd-sway">
        <g className="bd-jump">
          <g className="bd-legs">
            <g className="bd-leg-a">
              <P x={3} y={8} h={2} />
              <P x={9} y={8} h={2} />
            </g>
            <g className="bd-leg-b">
              <P x={5} y={8} h={2} />
              <P x={11} y={8} h={2} />
            </g>
          </g>
          <g className="bd-body">
            <P x={2} y={1} w={11} h={7} />
            <g className="bd-arm-l">
              <P x={0} y={4} w={2} h={2} />
            </g>
            <g className="bd-arm-r">
              <P x={13} y={4} w={2} h={2} />
            </g>
            <g className="bd-gaze">
              <g className="bd-look">
                <g className="bd-eyes">
                  <P x={5} y={3} h={2} fill={INK} />
                  <P x={9} y={3} h={2} fill={INK} />
                </g>
                <g className="bd-big">
                  <P x={4} y={2} w={2} h={3} fill={INK} />
                  <P x={9} y={2} w={2} h={3} fill={INK} />
                  <P x={5} y={2} fill="#fff" />
                  <P x={10} y={2} fill="#fff" />
                </g>
                <g className="bd-half">
                  <P x={4} y={4} w={2} fill={INK} />
                  <P x={9} y={4} w={2} fill={INK} />
                </g>
                <g className="bd-mad">
                  <P x={4} y={2} fill={INK} />
                  <P x={5} y={3} h={2} fill={INK} />
                  <P x={10} y={2} fill={INK} />
                  <P x={9} y={3} h={2} fill={INK} />
                </g>
                <g className="bd-hearts-eyes" fill={PINK}>
                  <P x={4} y={3} fill={PINK} />
                  <P x={6} y={3} fill={PINK} />
                  <P x={4} y={4} w={3} fill={PINK} />
                  <P x={5} y={5} fill={PINK} />
                  <P x={8} y={3} fill={PINK} />
                  <P x={10} y={3} fill={PINK} />
                  <P x={8} y={4} w={3} fill={PINK} />
                  <P x={9} y={5} fill={PINK} />
                </g>
                <g className="bd-happy">
                  <P x={4} y={4} fill={INK} />
                  <P x={5} y={3} fill={INK} />
                  <P x={6} y={4} fill={INK} />
                  <P x={8} y={4} fill={INK} />
                  <P x={9} y={3} fill={INK} />
                  <P x={10} y={4} fill={INK} />
                </g>
                <g className="bd-closed">
                  <P x={4} y={4} w={3} fill={INK} />
                  <P x={8} y={4} w={3} fill={INK} />
                </g>
              </g>
            </g>
            <g className="bd-mouth">
              <P x={7} y={6} fill={INK} />
            </g>
            <g className="bd-x">
              <P x={4} y={3} fill={INK} />
              <P x={6} y={3} fill={INK} />
              <P x={5} y={4} fill={INK} />
              <P x={4} y={5} fill={INK} />
              <P x={6} y={5} fill={INK} />
              <P x={8} y={3} fill={INK} />
              <P x={10} y={3} fill={INK} />
              <P x={9} y={4} fill={INK} />
              <P x={8} y={5} fill={INK} />
              <P x={10} y={5} fill={INK} />
            </g>
            {wx === "snow" && !still && (
              <g className="bd-scarf">
                <P x={2} y={6} w={11} fill="#d6403a" />
                <P x={10} y={7} w={2} h={2} fill="#d6403a" />
                <P x={4} y={6} fill="#f2f2f2" />
                <P x={8} y={6} fill="#f2f2f2" />
              </g>
            )}
            {wx === "hot" && !still && hat !== "glasses" && (
              <g className="bd-shades">
                <P x={4} y={3} w={3} h={2} fill="#111" />
                <P x={8} y={3} w={3} h={2} fill="#111" />
                <P x={7} y={3} fill="#111" />
                <P x={5} y={3} fill="#5a6b80" />
                <P x={9} y={3} fill="#5a6b80" />
              </g>
            )}
            {(wear ?? hat) !== "none" && <Hat hat={wear ?? hat} />}
          </g>
        </g>
      </g>
      {/* Things around him. */}
      <g className="bd-mark" fill="#ffc58f" fontSize="5" fontWeight="800" fontFamily="Segoe UI, sans-serif">
        <text x="13" y="1.6">?</text>
      </g>
      <g className="bd-bang" fill="#ffd84a" fontSize="5" fontWeight="900" fontFamily="Segoe UI, sans-serif">
        <text x="13.2" y="1.4">!</text>
      </g>
      <g className="bd-zz" fill="#cfd3ff" fontSize="4" fontWeight="700" fontFamily="Segoe UI, sans-serif">
        <text x="12.5" y="1.5">z</text>
        <text x="14.3" y="-1" fontSize="3">z</text>
      </g>
      <g className="bd-love">
        <path d="M2 -1h1v1h1v-1h1v2h-1v1h-1v-1h-1Z" fill={PINK} />
        <path d="M11 -3h1v1h1v-1h1v2h-1v1h-1v-1h-1Z" fill={PINK} />
      </g>
      <g className="bd-steam" fill="#cfcfcf">
        <rect x="1" y="-1" width="2" height="1" />
        <rect x="12" y="-1" width="2" height="1" />
        <rect x="0" y="-3" width="2" height="1" />
        <rect x="13" y="-3" width="2" height="1" />
      </g>
      <g className="bd-vein" fill="#ff4d3d">
        <rect x="11" y="0" width="1" height="1" />
        <rect x="12" y="-1" width="1" height="1" />
        <rect x="13" y="0" width="1" height="1" />
        <rect x="12" y="1" width="1" height="1" />
      </g>
      <g className="bd-sweat" fill="#7fd0ff">
        <rect x="13" y="1" width="1" height="2" />
      </g>
      <g className="bd-sigh" fill="#d6d9e0">
        <rect x="14" y="4" width="2" height="1" />
        <rect x="16" y="3" width="1" height="1" />
      </g>
      {!still && <Props />}
    </svg>
  );
}

// ------------------------------------------------------------------ hats ----

function Hat({ hat }: { hat: string }) {
  const r = (x: number, y: number, w: number, h: number, f: string) => <rect x={x} y={y} width={w} height={h} fill={f} />;
  switch (hat) {
    case "cap":
      return <g className="bd-hat">{r(3, -1, 9, 2, "#3b6fd9")}{r(10, 0, 5, 1, "#2c56b0")}{r(7, -1, 1, 1, "#fff")}</g>;
    case "beanie":
      return <g className="bd-hat">{r(3, -1, 9, 2, "#59a85c")}{r(2, 0, 11, 1, "#3f8a44")}{r(7, -2, 1, 1, "#e8f1e8")}</g>;
    case "bow":
      return <g className="bd-hat">{r(8, -1, 2, 2, "#ff5f93")}{r(11, -1, 2, 2, "#ff5f93")}{r(10, 0, 1, 1, "#d43f74")}</g>;
    case "crown":
      return (
        <g className="bd-hat">
          {r(4, -1, 7, 2, "#f5c451")}{r(4, -3, 1, 2, "#f5c451")}{r(7, -3, 1, 2, "#f5c451")}{r(10, -3, 1, 2, "#f5c451")}{r(7, 0, 1, 1, "#e0445e")}
        </g>
      );
    case "tophat":
      return <g className="bd-hat">{r(4, -4, 7, 4, "#222")}{r(4, -1, 7, 1, "#c4314b")}{r(2, 0, 11, 1, "#222")}</g>;
    case "party":
      return (
        <g className="bd-hat">
          {r(7, -4, 1, 1, "#ffd84a")}{r(6, -3, 3, 1, "#6f8dff")}{r(5, -2, 5, 1, "#ff6f9c")}{r(4, -1, 7, 1, "#6f8dff")}{r(5, 0, 5, 1, "#ffd84a")}
        </g>
      );
    case "headphones":
      return <g className="bd-hat">{r(3, -1, 9, 1, "#333")}{r(2, 0, 1, 2, "#333")}{r(12, 0, 1, 2, "#333")}{r(1, 2, 2, 3, "#555")}{r(12, 2, 2, 3, "#555")}</g>;
    case "glasses":
      return (
        <g className="bd-hat">
          {r(4, 2, 3, 1, INK)}{r(8, 2, 3, 1, INK)}{r(4, 5, 3, 1, INK)}{r(8, 5, 3, 1, INK)}
          {r(3, 3, 1, 2, INK)}{r(7, 3, 1, 1, INK)}{r(11, 3, 1, 2, INK)}
        </g>
      );
    case "santa":
      return (
        <g className="bd-hat">
          {r(4, -2, 6, 2, "#d6403a")}{r(9, -3, 3, 1, "#d6403a")}{r(12, -3, 1, 1, "#fff")}{r(3, 0, 9, 1, "#fff")}
        </g>
      );
    case "witch":
      return (
        <g className="bd-hat">
          {r(7, -4, 2, 1, "#4b2a6b")}{r(6, -3, 3, 1, "#4b2a6b")}{r(5, -2, 5, 1, "#4b2a6b")}{r(5, -1, 5, 1, "#f5a03a")}{r(2, 0, 11, 1, "#4b2a6b")}
        </g>
      );
    case "nightcap":
      return (
        <g className="bd-hat">
          {r(4, -1, 8, 2, "#6f8dff")}{r(10, -2, 3, 1, "#6f8dff")}{r(13, -1, 1, 2, "#6f8dff")}{r(13, 1, 1, 1, "#fff")}{r(5, 0, 1, 1, "#ffd84a")}{r(9, -1, 1, 1, "#ffd84a")}
        </g>
      );
    case "flower":
      return <g className="bd-hat">{r(11, -2, 1, 1, "#ff8fb4")}{r(10, -1, 1, 1, "#ff8fb4")}{r(12, -1, 1, 1, "#ff8fb4")}{r(11, 0, 1, 1, "#ff8fb4")}{r(11, -1, 1, 1, "#ffd84a")}</g>;
  }
  return null;
}

// ----------------------------------------------------------------- props ----

/** The things he busies himself with; each shows only during its whim. */
function Props() {
  const r = (x: number, y: number, w: number, h: number, f: string, k?: string) => <rect key={k} x={x} y={y} width={w} height={h} fill={f} />;
  return (
    <g className="bd-props">
      <g className="bd-p bd-p-paper">
        {r(15, 7, 6, 3, "#efeae0")}{r(16, 6, 5, 1, "#e2dccf")}{r(16, 8, 4, 1, "#b9b2a4")}{r(15, 10, 6, 1, "#d8d1c2")}
        <g className="bd-scraps">
          {r(16, 5, 1, 1, "#fff", "a")}{r(18, 4, 1, 1, "#efeae0", "b")}{r(20, 5, 1, 1, "#fff", "c")}
        </g>
        <g className="bd-ball">{r(17, 3, 2, 2, "#e2dccf")}</g>
      </g>
      <g className="bd-p bd-p-magnify">
        <g className="bd-lens">
          {r(15, 0, 3, 1, "#cfd6e0")}{r(14, 1, 1, 3, "#cfd6e0")}{r(18, 1, 1, 3, "#cfd6e0")}{r(15, 4, 3, 1, "#cfd6e0")}
          <rect x={15} y={1} width={3} height={3} fill="#9fd8ff" opacity={0.5} />
          {r(14, 4, 1, 1, "#8a5a3c")}{r(13, 5, 1, 1, "#8a5a3c")}
        </g>
      </g>
      <g className="bd-p bd-p-coffee">
        <g className="bd-mug">{r(14, 3, 4, 4, "#f4f4f4")}{r(18, 4, 1, 2, "#f4f4f4")}{r(14, 3, 4, 1, "#6b3f2a")}</g>
        <g className="bd-steam2">{r(15, 1, 1, 1, "#e6e6e6")}{r(16, 0, 1, 1, "#e6e6e6")}</g>
      </g>
      <g className="bd-p bd-p-read">
        {r(2, 6, 11, 4, "#8a5a3c")}{r(3, 6, 4, 3, "#fbf7ee")}{r(8, 6, 4, 3, "#fbf7ee")}{r(7, 6, 1, 3, "#d8cfbd")}
        {r(4, 7, 2, 1, "#c9c0ad")}{r(9, 7, 2, 1, "#c9c0ad")}
        <g className="bd-page">{r(8, 6, 4, 3, "#fffdf6")}</g>
      </g>
      <g className="bd-p bd-p-laptop">
        {r(16, 3, 7, 6, "#3a3d44")}{r(17, 4, 5, 4, "#1c2433")}<g className="bd-code">{r(17, 5, 3, 1, "#7fd0ff")}{r(17, 7, 4, 1, "#9ff0a0")}</g>{r(14, 9, 9, 1, "#5a5e66")}
      </g>
      <g className="bd-p bd-p-sweep">
        <g className="bd-broom">{r(14, 1, 1, 1, "#8a5a3c")}{r(15, 2, 1, 2, "#8a5a3c")}{r(16, 4, 1, 3, "#8a5a3c")}{r(15, 7, 3, 3, "#e3b85a")}</g>
        <g className="bd-dust">{r(18, 9, 1, 1, "#b8b0a0")}{r(19, 8, 1, 1, "#cfc8b8")}</g>
      </g>
      <g className="bd-p bd-p-juggle">
        <g className="bd-j1">{r(6, -2, 2, 2, "#ff6f9c")}</g>
        <g className="bd-j2">{r(6, -2, 2, 2, "#ffd84a")}</g>
        <g className="bd-j3">{r(6, -2, 2, 2, "#7fd0ff")}</g>
      </g>
      <g className="bd-p bd-p-water">
        <g className="bd-can">{r(14, 3, 3, 3, "#6f8dff")}{r(17, 3, 1, 1, "#6f8dff")}{r(18, 2, 1, 1, "#6f8dff")}</g>
        <g className="bd-drops">{r(19, 4, 1, 1, "#9fd8ff")}{r(19, 6, 1, 1, "#9fd8ff")}</g>
        {r(18, 9, 3, 2, "#a0522d")}
        <g className="bd-sprout">{r(19, 7, 1, 2, "#59a85c")}{r(18, 7, 1, 1, "#7cbf5a")}{r(20, 6, 1, 1, "#7cbf5a")}</g>
      </g>
      <g className="bd-p bd-p-eat">
        <g className="bd-cookie">{r(13, 3, 3, 3, "#c98a4b")}{r(14, 3, 1, 1, "#5a3420")}{r(13, 5, 1, 1, "#5a3420")}</g>
        <g className="bd-crumbs">{r(12, 8, 1, 1, "#c98a4b", "a")}{r(15, 9, 1, 1, "#c98a4b", "b")}{r(10, 9, 1, 1, "#c98a4b", "c")}</g>
      </g>
      <g className="bd-p bd-p-crave">
        {r(14, 1, 1, 1, "#e6e6e6")}{r(15, 0, 1, 1, "#e6e6e6")}
        {r(16, -3, 7, 3, "#f2f2f2")}{r(17, -4, 5, 1, "#f2f2f2")}{r(17, 0, 5, 1, "#f2f2f2")}
        {r(18, -3, 3, 3, "#c98a4b")}{r(19, -3, 1, 1, "#5a3420")}{r(18, -1, 1, 1, "#5a3420")}
      </g>
      <g className="bd-p bd-p-ball">
        <g className="bd-kickball">{r(15, 8, 2, 2, "#ff6f9c")}{r(15, 8, 1, 1, "#ffd0e0")}</g>
      </g>
      <g className="bd-p bd-p-kite">
        <g className="bd-kite">{r(19, -4, 2, 1, "#ffd84a")}{r(18, -3, 4, 1, "#ff6f9c")}{r(19, -2, 2, 1, "#6f8dff")}{r(19, -1, 1, 1, "#6f8dff")}</g>
        {r(15, 3, 1, 1, "#ddd")}{r(16, 2, 1, 1, "#ddd")}{r(17, 1, 1, 1, "#ddd")}{r(18, 0, 1, 1, "#ddd")}
      </g>
      <g className="bd-umbrella">
        {r(3, -2, 15, 1, "#6f8dff")}{r(5, -3, 11, 1, "#6f8dff")}{r(8, -4, 5, 1, "#8fa6ff")}{r(14, -1, 1, 6, "#bbb")}{r(13, 4, 1, 1, "#bbb")}
        <g className="bd-rain">{r(-1, 0, 1, 1, "#9fd8ff", "a")}{r(15, -1, 1, 1, "#9fd8ff", "b")}{r(17, 2, 1, 1, "#9fd8ff", "c")}</g>
      </g>
      <g className="bd-bolt">{r(13, -3, 2, 1, "#ffd84a")}{r(12, -2, 2, 1, "#ffd84a")}{r(13, -1, 2, 1, "#ffd84a")}{r(12, 0, 2, 1, "#ffd84a")}</g>
      <g className="bd-p bd-p-cake">
        {r(14, 6, 7, 4, "#f7d9e3")}{r(14, 6, 7, 1, "#ff6f9c")}{r(14, 8, 7, 1, "#c98a4b")}{r(17, 4, 1, 2, "#6f8dff")}
        <g className="bd-flame">{r(17, 3, 1, 1, "#ffd84a")}</g>
        <g className="bd-confetti">
          {r(2, -3, 1, 1, "#ff6f9c", "1")}{r(7, -5, 1, 1, "#ffd84a", "2")}{r(12, -3, 1, 1, "#7fd0ff", "3")}{r(18, -4, 1, 1, "#7cbf5a", "4")}{r(-1, -2, 1, 1, "#c27ce0", "5")}
        </g>
      </g>
      <g className="bd-p bd-p-think">
        {r(14, 1, 1, 1, "#e6e6e6")}{r(15, 0, 1, 1, "#e6e6e6")}
        <g className="bd-cloud">{r(16, -3, 7, 3, "#f2f2f2")}{r(17, -4, 5, 1, "#f2f2f2")}{r(17, 0, 5, 1, "#f2f2f2")}
          <g className="bd-dots">{r(17, -2, 1, 1, "#888", "1")}{r(19, -2, 1, 1, "#888", "2")}{r(21, -2, 1, 1, "#888", "3")}</g>
        </g>
      </g>
    </g>
  );
}

// ---------------------------------------------------------- flying copies ----

/** A copy of Клодик for animations outside the island's clipped box. */
function ghost(from: DOMRect) {
  const el = document.createElement("div");
  el.className = "buddy-ghost";
  el.innerHTML = `<svg class="buddy dance" viewBox="0 0 15 11" shape-rendering="crispEdges" width="${from.width}" height="${from.height}">
    <g class="bd-sway"><g class="bd-jump"><g class="bd-legs"><g class="bd-leg-a"><rect x="3" y="8" width="1" height="2" fill="${C}"/><rect x="9" y="8" width="1" height="2" fill="${C}"/></g><g class="bd-leg-b"><rect x="5" y="8" width="1" height="2" fill="${C}"/><rect x="11" y="8" width="1" height="2" fill="${C}"/></g></g>
    <g class="bd-body"><rect x="2" y="1" width="11" height="7" fill="${C}"/><g class="bd-arm-l"><rect x="0" y="4" width="2" height="2" fill="${C}"/></g><g class="bd-arm-r"><rect x="13" y="4" width="2" height="2" fill="${C}"/></g>
    <rect x="5" y="3" width="1" height="2" fill="${INK}"/><rect x="9" y="3" width="1" height="2" fill="${INK}"/></g></g></g></svg>`;
  Object.assign(el.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  document.body.appendChild(el);
  return el;
}

/** He jumps from one element to another in an arc, landing with a squash. */
export function hopTo(fromEl: Element | null, toEl: Element | null): Promise<void> {
  if (!fromEl || !toEl) return Promise.resolve();
  const a = fromEl.getBoundingClientRect();
  const b = toEl.getBoundingClientRect();
  const g = ghost(a);
  (fromEl as HTMLElement).style.visibility = "hidden";
  const dx = b.left + b.width / 2 - (a.left + a.width / 2);
  const dy = b.top - a.height * 0.6 - a.top;
  const peak = Math.min(a.top, a.top + dy) - a.top - 26;
  const anim = g.animate(
    [
      { transform: "translate(0,0) scale(1,1)", offset: 0 },
      { transform: "translate(0,2px) scale(1.15,0.8)", offset: 0.12 },
      { transform: `translate(${dx * 0.5}px,${peak}px) scale(0.9,1.12)`, offset: 0.5 },
      { transform: `translate(${dx}px,${dy}px) scale(1.2,0.75)`, offset: 0.86 },
      { transform: `translate(${dx}px,${dy}px) scale(1,1)`, offset: 1 },
    ],
    { duration: 620, easing: "cubic-bezier(.3,.7,.4,1)" },
  );
  return anim.finished
    .catch(() => undefined)
    .then(() => {
      window.setTimeout(() => {
        g.remove();
        (fromEl as HTMLElement).style.visibility = "";
      }, 260);
    });
}

/** He climbs up and out over the top edge of the screen, wiggling his bottom. */
export function climbOut(fromEl: Element | null) {
  if (!fromEl) return;
  const a = fromEl.getBoundingClientRect();
  if (!a.width) return;
  const g = ghost(a);
  g.classList.add("climbing");
  const up = -(a.top + a.height + 12);
  g.animate(
    [
      { transform: "translateY(0) rotate(0deg)" },
      { transform: `translateY(${up * 0.18}px) rotate(-9deg)`, offset: 0.15 },
      { transform: `translateY(${up * 0.36}px) rotate(9deg)`, offset: 0.32 },
      { transform: `translateY(${up * 0.56}px) rotate(-9deg)`, offset: 0.5 },
      { transform: `translateY(${up * 0.76}px) rotate(8deg)`, offset: 0.68 },
      { transform: `translateY(${up * 0.92}px) rotate(-6deg)`, offset: 0.84 },
      { transform: `translateY(${up}px) rotate(0deg)` },
    ],
    { duration: 900, easing: "ease-in" },
  ).finished.then(
    () => g.remove(),
    () => g.remove(),
  );
}

// ---------------------------------------------------------------- per frame ----

/**
 * Per-frame part of the companion: gaze, dancing and happy eyes. `cursor` is
 * in window coordinates, or null when it is far away.
 */
export function animateBuddies(L: Liquid, cursor: { x: number; y: number } | null) {
  const buddies = document.querySelectorAll<SVGSVGElement>(".view.on .buddy:not(.sleep)");
  const m = L.music;
  const beat = L.beat;
  const mid = 0.5 * (L.levels[2] + L.levels[3]);
  buddies.forEach((el) => {
    let gx = 0;
    let gy = 0;
    if (cursor) {
      const r = el.getBoundingClientRect();
      const dx = cursor.x - (r.left + r.width / 2);
      const dy = cursor.y - (r.top + r.height * 0.55);
      const len = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, len / 40);
      gx = (dx / len) * 0.9 * k;
      gy = (dy / len) * 0.6 * k;
    } else if (m > 0.01) {
      gx = Math.sin(L.t * 0.9) * 0.6 * m; // looks around, enjoying the music
    }
    const hop = -1.4 * beat * m;
    // Pixel art does not rotate well: it shuffles side to side instead.
    const shuffle = Math.sin(L.t * 2 * Math.PI * 0.55) * (0.5 + 0.6 * mid) * m;
    // Either open or squinting, never a mix: CSS fades between the two.
    const happy = beat * m > 0.55 ? 1 : 0;
    // At his place by the clock he faces the other way (his things go left).
    if (el.closest(".mirror")) gx = -gx;
    el.style.setProperty("--gx", gx.toFixed(2));
    el.style.setProperty("--gy", gy.toFixed(2));
    el.style.setProperty("--hop", hop.toFixed(2));
    el.style.setProperty("--sx", shuffle.toFixed(2));
    el.style.setProperty("--squash", (1 + 0.07 * beat * m).toFixed(3));
    el.classList.toggle("happy", happy === 1);
    el.classList.toggle("dance", m > 0.5);
  });
}
