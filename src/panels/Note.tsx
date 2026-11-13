import { useEffect, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { CloseIcon, Pause, Play, ResetIcon, Ring } from "../components/Icons";
import { fmtClock, remaining, type useTimer } from "../timer";
import { describeWhen, parseReminder, type Reminder } from "../reminders";

import { t } from "../i18n";
const PRESETS = [1, 3, 5, 10, 15, 25];

/** A note that saves itself, and a timer beside it. */
export function NoteTab({
  api,
  timer,
  onTypeStart,
  reminders,
  setReminders,
  pomo,
  onPomodoro,
}: {
  api: Bridge | null;
  timer: ReturnType<typeof useTimer>;
  pomo: { phase: "work" | "rest"; round: number } | null;
  onPomodoro: (on: boolean) => void;
  onTypeStart: () => void;
  reminders: Reminder[];
  setReminders: (r: Reminder[]) => void;
}) {
  const [view, setView] = useState<"note" | "remind">("note");
  const [phrase, setPhrase] = useState("");
  const parsed = phrase.trim() ? parseReminder(phrase) : null;
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
      <div className="note-col">
        <div className="segmented">
          <button className={view === "note" ? "on" : ""} onClick={() => setView("note")}>
            {t("Заметка")}</button>
          <button className={view === "remind" ? "on" : ""} onClick={() => setView("remind")}>
            {t("Напоминания")}{reminders.length ? ` · ${reminders.length}` : ""}
          </button>
        </div>
        {view === "remind" ? (
          <div className="reminders">
            <input
              className="search"
              placeholder={t("позвонить маме завтра в 9")}
              value={phrase}
              onFocus={onTypeStart}
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && parsed) {
                  setReminders([...reminders, parsed].sort((a, b) => a.at - b.at));
                  setPhrase("");
                }
              }}
            />
            <div className="hint-line">
              {phrase.trim()
                ? parsed
                  ? `${parsed.text} — ${describeWhen(parsed)} · Enter`
                  : t("Не понял, когда: «завтра в 9», «через 20 минут», «каждый день в 23:00»")
                : t("Одной фразой: что и когда")}
            </div>
            <div className="list">
              {reminders.map((r) => (
                <div key={r.id} className="clip">
                  <div className="clip-text">{r.text}</div>
                  <span className="meta">{describeWhen(r)}</span>
                  <span className="actions">
                    <button aria-label={t("Удалить")} onClick={() => setReminders(reminders.filter((x) => x.id !== r.id))}>
                      <CloseIcon size={11} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
      <textarea
        className="note"
        placeholder={t("Заметка: всё, что напишешь, сохранится само")}
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
        )}
      </div>
      <div className="timer">
        <div
          className="timer-face"
          title={timer.active ? "" : t("Колесо мыши — минуты")}
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
            aria-label={timer.running ? t("Пауза") : t("Старт")}
            onClick={() => (timer.running ? timer.pause() : timer.active ? timer.resume() : timer.start(pick * 60_000))}
          >
            {timer.running ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button aria-label={t("Сбросить")} disabled={!timer.active} onClick={timer.reset}>
            <ResetIcon />
          </button>
        </div>
        <button
          className={`chip pomo-btn ${pomo ? "on" : ""}`}
          title={t("25 минут работы, 5 минут отдыха; каждый четвёртый перерыв — 15. Клодик работает и отдыхает вместе с тобой")}
          onClick={() => onPomodoro(!pomo)}
        >
          {pomo ? (pomo.phase === "work" ? t("Помидор {0} · стоп", pomo.round) : t("Отдых · стоп")) : t("Помодоро")}
        </button>
      </div>
    </div>
  );
}
