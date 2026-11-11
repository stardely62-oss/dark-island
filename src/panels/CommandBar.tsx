import { useEffect, useMemo, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { calc, convert, fmtNumber, SYSTEM, timerPhrase } from "../command";
import { ENGINES } from "../settings";
import { AppIcon } from "../components/AppIcon";
import { describeWhen, parseReminder, type Reminder } from "../reminders";

export type AppEntry = { Name: string; AppID: string };

type Result = { key: string; icon: string; title: string; sub: string; run: () => void; app?: string };

const ICONS: Record<string, React.ReactNode> = {
  calc: <path d="M5 8h5M7.5 5.5v5M14 8h5M5 16.5l4-4M9 16.5l-4-4M14 15h5M14 18h5" />,
  conv: <path d="M5 8h13l-3-3M19 16H6l3 3" />,
  timer: <><circle cx="12" cy="13" r="7" /><path d="M12 9.5V13l2.3 1.6M9.5 3h5" /></>,
  sys: <><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" /></>,
  web: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
  ai: <path d="M12 3.5 13.8 9 19.5 10.8 13.8 12.6 12 18.2 10.2 12.6 4.5 10.8 10.2 9Z" />,
  remind: <><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15Z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></>,
  shell: <path d="m5 7 5 5-5 5M12 18h7" />,
};

export type CommandActions = {
  ask: (q: string) => void;
  remind: (r: Reminder) => void;
  startTimer: (ms: number) => void;
  system: (id: string) => void;
  close: () => void;
};

const fold = (s: string) => s.toLowerCase().replace(/ё/g, "е");

/**
 * Alt+Space: apps (Store ones too), a calculator, units, timer phrases,
 * system commands, web search; a line after ">" runs in cmd, after "ps>"
 * in PowerShell.
 */
export function CommandBar({
  api,
  open,
  engine,
  actions,
  onCount,
}: {
  api: Bridge | null;
  open: boolean;
  engine: string;
  actions: CommandActions;
  onCount: (n: number) => void;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    const t = window.setTimeout(() => input.current?.focus(), 60);
    api?.call<AppEntry[]>("apps_list").then((a) => setApps(a ?? []));
    return () => clearTimeout(t);
  }, [open, api]);

  const results = useMemo<Result[]>(() => {
    const text = q.trim();
    if (!text) return [];
    const out: Result[] = [];
    const copy = (v: string) => navigator.clipboard?.writeText(v).catch(() => {});

    if (text.startsWith(">") || /^ps>/i.test(text)) {
      const ps = /^ps>/i.test(text);
      const cmd = text.replace(/^(ps)?>/i, "").trim();
      if (cmd)
        out.push({
          key: "shell",
          icon: "shell",
          title: cmd,
          sub: ps ? "Выполнить в PowerShell" : "Выполнить в командной строке",
          run: () => api?.call("run_shell", { cmd, powershell: ps }),
        });
      return out;
    }

    const v = calc(text);
    if (v !== null) {
      const s = fmtNumber(v);
      out.push({ key: "calc", icon: "calc", title: s, sub: "Enter — скопировать результат", run: () => copy(s.replace(",", ".")) });
    }
    const conv = convert(text);
    if (conv) out.push({ key: "conv", icon: "conv", title: conv.text, sub: "Enter — скопировать", run: () => copy(conv.value) });
    const ms = timerPhrase(text);
    if (ms) {
      const min = ms / 60_000;
      out.push({
        key: "timer",
        icon: "timer",
        title: `Таймер на ${min >= 1 ? `${fmtNumber(+min.toFixed(2))} мин` : `${ms / 1000} с`}`,
        sub: "Запустить",
        run: () => actions.startTimer(ms),
      });
    }

    if (/^напомни/i.test(text)) {
      const r = parseReminder(text);
      if (r)
        out.push({ key: "remind", icon: "remind", title: `${r.text} — ${describeWhen(r)}`, sub: "Напомнить", run: () => actions.remind(r) });
    }

    const f = fold(text);
    for (const c of SYSTEM) {
      if (c.words.some((w) => w.startsWith(f) || f === w)) {
        out.push({ key: `sys-${c.id}`, icon: "sys", title: c.title, sub: "Команда", run: () => actions.system(c.id) });
      }
    }

    const scored = apps
      .map((a) => {
        const n = fold(a.Name);
        const words = n.split(/[\s\-_.]+/);
        const score = n.startsWith(f) ? 3 : words.some((w) => w.startsWith(f)) ? 2 : n.includes(f) ? 1 : 0;
        return { a, score };
      })
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score || x.a.Name.length - y.a.Name.length)
      .slice(0, 5);
    for (const { a } of scored) {
      out.push({
        key: `app-${a.AppID}`,
        icon: a.Name.slice(0, 1).toUpperCase(),
        app: a.AppID,
        title: a.Name,
        sub: "Программа",
        run: () => api?.call("app_launch", { id: a.AppID }),
      });
    }

    const e = ENGINES[engine] ?? ENGINES.google;
    out.push({
      key: "ai",
      icon: "ai",
      title: `Спросить ИИ: «${text}»`,
      sub: "Tab",
      run: () => actions.ask(text),
    });
    out.push({
      key: "web",
      icon: "web",
      title: `Найти «${text}»`,
      sub: e.name,
      run: () => api?.call("open_url", { url: e.url.replace("%s", encodeURIComponent(text)) }),
    });
    return out.slice(0, 7);
  }, [q, apps, api, engine, actions]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => onCount(results.length), [results.length, onCount]);

  const runAt = (i: number) => {
    const r = results[i];
    if (!r) return;
    r.run();
    actions.close();
  };

  return (
    <div className="command">
      <div className="cmd-input">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </svg>
        <input
          ref={input}
          value={q}
          placeholder="Программа, 2+2, 5 км в милях, таймер 10 мин, > команда"
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(results.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runAt(sel);
            } else if (e.key === "Tab" && q.trim()) {
              e.preventDefault();
              actions.ask(q.trim());
            } else if (e.key === "Escape") {
              e.preventDefault();
              actions.close();
            }
          }}
        />
      </div>
      {results.length > 0 && (
        <div className="cmd-results">
          {results.map((r, i) => (
            <div
              key={r.key}
              className={`cmd-row ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => runAt(i)}
            >
              <span className={`cmd-icon ${r.app ? "is-app" : ""}`}>
                {r.app ? (
                  <AppIcon api={api} kind="app" target={r.app} name={r.title} size={22} />
                ) : ICONS[r.icon] ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    {ICONS[r.icon]}
                  </svg>
                ) : (
                  r.icon
                )}
              </span>
              <span className="cmd-title">{r.title}</span>
              <span className="cmd-sub">{r.sub}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Height the command bar needs for `n` result rows. */
export const commandHeight = (n: number) => 54 + (n ? 8 + n * 36 : 0);
