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
  | "plop";

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
];

let lifeStarted = false;
function startLife() {
  if (lifeStarted) return;
  lifeStarted = true;
  const next = () => {
    const wait = 4000 + Math.random() * 9000;
    window.setTimeout(() => {
      const now = Date.now();
      if (!(reaction && reaction.until > now)) {
        const pool = state === "bored" ? [["sigh", 2600, 1] as [string, number, number], ...WHIMS.filter(([n]) => n === "look" || n === "sit" || n === "yawn")] : WHIMS;
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
    reaction = { name, until: Date.now() + ms };
    action = null;
    notify();
    window.setTimeout(notify, ms + 30);
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
  return `${re}|${act}|${state ?? ""}`;
}

function useLife() {
  const subscribe = useCallback((cb: () => void) => {
    startLife();
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, []);
  return useSyncExternalStore(subscribe, snapshot).split("|");
}

// ------------------------------------------------------------- the sprite ----

export function Buddy({
  size = 26,
  sleeping = false,
  mood = null,
  className = "",
  still = false,
}: {
  size?: number;
  sleeping?: boolean;
  mood?: Mood;
  className?: string;
  /** No whims or reactions (e.g. a copy in flight). */
  still?: boolean;
}) {
  const [re, act, st] = useLife();
  const pet = useRef({ lastX: 0, dir: 0, flips: 0, since: 0 });
  const poke = useRef({ n: 0, since: 0 });

  // Petting: stroke him back and forth.
  const onMove = (e: React.PointerEvent) => {
    const p = pet.current;
    const now = Date.now();
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
      }
    }
  };
  // Poking: once is a surprise, a few times annoys him, many times makes him furious.
  const onClick = (e: React.MouseEvent) => {
    // On the collapsed pill a click still opens the island; he just notices it.
    if (!(e.currentTarget as Element).closest(".compact")) e.stopPropagation();
    const k = poke.current;
    const now = Date.now();
    k.n = now - k.since < 1500 ? k.n + 1 : 1;
    k.since = now;
    if (k.n >= 7) buddy.react("furious", 2600);
    else if (k.n >= 4) buddy.react("angry", 1800);
    else buddy.react(k.n === 1 ? "surprised" : "hop", 900);
  };

  const classes = [
    "buddy",
    className,
    sleeping && !mood && !re ? "sleep" : "",
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
      width={size}
      height={(size * 11) / 15}
      viewBox="0 0 15 11"
      shapeRendering="crispEdges"
      aria-hidden
      onPointerMove={still ? undefined : onMove}
      onPointerEnter={still ? undefined : () => window.dispatchEvent(new CustomEvent("buddy-hover", { detail: true }))}
      onPointerLeave={still ? undefined : () => window.dispatchEvent(new CustomEvent("buddy-hover", { detail: false }))}
      onClick={still ? undefined : onClick}
    >
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
    </svg>
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
    el.style.setProperty("--gx", gx.toFixed(2));
    el.style.setProperty("--gy", gy.toFixed(2));
    el.style.setProperty("--hop", hop.toFixed(2));
    el.style.setProperty("--sx", shuffle.toFixed(2));
    el.style.setProperty("--squash", (1 + 0.07 * beat * m).toFixed(3));
    el.classList.toggle("happy", happy === 1);
    el.classList.toggle("dance", m > 0.5);
  });
}
