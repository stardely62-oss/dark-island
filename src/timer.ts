import { useCallback, useEffect, useRef, useState } from "react";

/** A countdown that survives reloads of the page. */
export type TimerState = {
  /** Length that was set, ms. */
  total: number;
  /** When it ends (running), or null when paused/idle. */
  endsAt: number | null;
  /** Remaining ms while paused. */
  left: number;
};

const KEY = "island.timer";
const IDLE: TimerState = { total: 0, endsAt: null, left: 0 };

function load(): TimerState {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) ?? "") as TimerState;
    if (typeof t.total === "number") return t;
  } catch {
    /* nothing saved */
  }
  return IDLE;
}

export function remaining(t: TimerState, now = Date.now()) {
  return t.endsAt ? Math.max(0, t.endsAt - now) : t.left;
}

export function useTimer(onDone: (total: number) => void) {
  const [state, setState] = useState<TimerState>(load);
  const done = useRef(onDone);
  done.current = onDone;

  const save = useCallback((t: TimerState) => {
    setState(t);
    try {
      localStorage.setItem(KEY, JSON.stringify(t));
    } catch {
      /* storage may be unavailable */
    }
  }, []);

  useEffect(() => {
    if (!state.endsAt) return;
    const ms = state.endsAt - Date.now();
    const id = window.setTimeout(() => {
      done.current(state.total);
      save(IDLE);
    }, Math.max(0, ms));
    return () => clearTimeout(id);
  }, [state.endsAt, state.total, save]);

  return {
    state,
    running: state.endsAt !== null,
    active: state.endsAt !== null || state.left > 0,
    start: (ms: number) => save({ total: ms, endsAt: Date.now() + ms, left: 0 }),
    pause: () => save({ ...state, endsAt: null, left: remaining(state) }),
    resume: () => save({ ...state, endsAt: Date.now() + state.left, left: 0 }),
    reset: () => save(IDLE),
  };
}

export function fmtClock(ms: number) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}
