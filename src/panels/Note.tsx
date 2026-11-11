import { useEffect, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { Pause, Play, ResetIcon, Ring } from "../components/Icons";
import { fmtClock, remaining, type useTimer } from "../timer";

const PRESETS = [1, 3, 5, 10, 15, 25];

/** A note that saves itself, and a timer beside it. */
export function NoteTab({
  api,
  timer,
  onTypeStart,
}: {
  api: Bridge | null;
  timer: ReturnType<typeof useTimer>;
  onTypeStart: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const saveTimer = useRef(0);
  const [pick, setPick] = useState(5); // minutes for the next start
  const [, tick] = useState(0);

  useEffect(() => {
    api?.call<string>("note_get").then((t) => setText(t ?? ""));
  }, [api]);
  useEffect(() => {
    if (!timer.running) return;
    const id = window.setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [timer.running]);

  const left = timer.active ? remaining(timer.state) : pick * 60_000;
  const progress = timer.active && timer.state.total ? left / timer.state.total : 1;

  return (
    <div className="tab-note">
      <textarea
        className="note"
        placeholder="Заметка: всё, что напишешь, сохранится само"
        value={text ?? ""}
        disabled={text === null}
        spellCheck={false}
        onFocus={onTypeStart}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          clearTimeout(saveTimer.current);
          saveTimer.current = window.setTimeout(() => api?.call("note_set", { text: t }), 400);
        }}
      />
      <div className="timer">
        <div
          className="timer-face"
          title={timer.active ? "" : "Колесо мыши — минуты"}
          onWheel={(e) => {
            if (timer.active) return;
            e.stopPropagation();
            setPick((m) => Math.max(1, Math.min(180, m + (e.deltaY > 0 ? -1 : 1))));
          }}
        >
          <Ring size={74} progress={progress} color="#ff9f43" />
          <span className="timer-time">{fmtClock(left)}</span>
        </div>
        <div className="presets">
          {PRESETS.map((m) => (
            <button
              key={m}
              className={!timer.active && pick === m ? "on" : ""}
              onClick={() => (timer.active ? timer.start(m * 60_000) : setPick(m))}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="timer-ctl">
          <button
            className="main"
            aria-label={timer.running ? "Пауза" : "Старт"}
            onClick={() => (timer.running ? timer.pause() : timer.active ? timer.resume() : timer.start(pick * 60_000))}
          >
            {timer.running ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button aria-label="Сбросить" disabled={!timer.active} onClick={timer.reset}>
            <ResetIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
