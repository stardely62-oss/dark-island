import { useEffect, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { ENGINES, type Settings } from "../settings";
import { CLAUDE_MODELS, PROVIDERS, providerOf } from "../ai";
import { Buddy, COLORS, HATS, STICKERS, buddy, usePet } from "../components/Buddy";
import { comboOf, keyLabel } from "./Launcher";

/** How to connect each AI service, step by step. */
const AI_HOWTO: Record<string, { steps: string[]; note: string }> = {
  anthropic: {
    steps: ["Открой platform.claude.com и войди", "Settings → API Keys → Create Key", "Скопируй ключ (sk-ant-…) и вставь в поле «Ключ» ниже"],
    note: "Платно: нужен баланс на счёте. Лучшее качество ответов.",
  },
  groq: {
    steps: ["Открой console.groq.com и войди (можно через Google)", "API Keys → Create API Key", "Вставь ключ ниже — он же подойдёт для диктовки Whisper"],
    note: "Бесплатно с дневным лимитом. Очень быстро.",
  },
  gemini: {
    steps: [
      "Открой aistudio.google.com/apikey → Create API key",
      "Вставь ключ ниже и нажми «Список», чтобы выбрать модель, например `gemini-3.8-flash`",
    ],
    note: "Бесплатный тариф с лимитами. Если модель сняли с поддержки, остров сам выберет похожую.",
  },
  openrouter: {
    steps: ["Открой openrouter.ai и войди", "Keys → Create Key", "Вставь ключ ниже; бесплатные модели — с «:free» в названии (кнопка «Список»)"],
    note: "Сотни моделей через один ключ, есть бесплатные.",
  },
  deepseek: {
    steps: ["Открой platform.deepseek.com", "API keys → Create new API key", "Пополни баланс и вставь ключ ниже"],
    note: "Платно, но дёшево.",
  },
  openai: {
    steps: ["Открой platform.openai.com/api-keys", "Create new secret key", "Пополни баланс (Billing) и вставь ключ ниже"],
    note: "Платно.",
  },
  custom: {
    steps: [
      "Ollama: поставь с ollama.com, в терминале — `ollama pull llama3.2`",
      "Адрес: `http://127.0.0.1:11434/v1`, модель: `llama3.2`, ключ — любой текст",
      "LM Studio: Developer → Start Server, адрес `http://127.0.0.1:1234/v1`",
    ],
    note: "Модель работает на твоём компьютере: бесплатно и без интернета, но нужен мощный компьютер.",
  },
};

/**
 * A line of instructions where web addresses can be opened or copied and
 * `code` can be copied.
 */
function HowtoText({ text, api }: { text: string; api: Bridge | null }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (v: string) => {
    navigator.clipboard?.writeText(v).catch(() => api?.call("paste_text", { text: v, paste: false }));
    setCopied(v);
    window.setTimeout(() => setCopied((c) => (c === v ? null : c)), 1500);
  };
  const parts = text.split(/(`[^`]+`|(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|org|io|dev|net)(?:\/[\w\-./?=&#]*)?)/gi);
  return (
    <>
      {parts.map((p, i) => {
        if (!p) return null;
        if (p.startsWith("`")) {
          const v = p.slice(1, -1);
          return (
            <span key={i} className="howto-code" title="Скопировать" onClick={() => copy(v)}>
              {v}
              <i>{copied === v ? "скопировано" : "копировать"}</i>
            </span>
          );
        }
        if (i % 2 === 1) {
          const url = /^https?:/.test(p) ? p : `https://${p}`;
          return (
            <span key={i} className="howto-link">
              <a onClick={() => api?.call("open_url", { url })} title="Открыть в браузере">
                {p}
              </a>
              <i title="Скопировать адрес" onClick={() => copy(url)}>
                {copied === url ? "✓" : "⧉"}
              </i>
            </span>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

type Hotkey = { action: string; title: string; default: string; combo: string; taken: boolean };

type Conn = { claude: boolean; codex: boolean; codex_busy: boolean; opencode: boolean; codex_hooks?: boolean; seen?: Record<string, number> };

/** "сигнал 3 мин назад" / "сигналов ещё не было". */
function seenText(conn: Conn | null, id: string) {
  const s = conn?.seen?.[id];
  if (s === undefined) return "сигналов с запуска острова ещё не было";
  if (s < 60) return "последний сигнал только что";
  if (s < 3600) return `последний сигнал ${Math.round(s / 60)} мин назад`;
  return `последний сигнал ${Math.round(s / 3600)} ч назад`;
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

function Row({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{title}</div>
        {sub && <div className="set-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * A slider that applies its value only when let go: moving or resizing the
 * island under the cursor while dragging makes it jump. The label shows the
 * value as it moves.
 */
function SlowRange({
  title,
  value,
  min,
  max,
  step,
  label,
  onCommit,
}: {
  title: string;
  value: number;
  min: number;
  max: number;
  step: number;
  label: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [v, setV] = useState<number | null>(null);
  const shown = v ?? value;
  const commit = () => {
    if (v !== null && v !== value) onCommit(v);
    setV(null);
  };
  return (
    <Row title={title} sub={v !== null && v !== value ? `${label(shown)} — отпусти, чтобы применить` : label(shown)}>
      <input
        className="range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </Row>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function SettingsTab({
  api,
  settings,
  set,
  visible,
  onTypeStart,
}: {
  api: Bridge | null;
  settings: Settings;
  set: (p: Partial<Settings>) => void;
  visible: boolean;
  onTypeStart: () => void;
}) {
  const pet = usePet();
  // ---- search and sections ----
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  /** The open section (by its place in the list); a search looks through all of them. */
  const [section, setSection] = useState(0);
  const groups = ["Остров", settings.buddyName || "Клодик", "ИИ и голос", "Экран", "Звук", "Разное", "Сеть", "О программе"];
  // One section at a time; a search shows matching rows from all of them
  // (a section without matches hides its title).
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const f = q.trim().toLowerCase();
    let group: HTMLElement | null = null;
    let gi = -1;
    let any = false;
    // gi: the tab this group belongs to.
    const close = () => group && (group.style.display = (f && !any) || (!f && gi !== section) ? "none" : "");
    for (const el of root.querySelectorAll<HTMLElement>(":scope > *")) {
      if (el.classList.contains("set-tools")) continue;
      if (el.classList.contains("set-group")) {
        close();
        group = el;
        gi = Number(el.dataset.tab ?? 0);
        any = !f || (el.textContent ?? "").toLowerCase().includes(f);
        el.dataset.match = any ? "1" : "";
        continue;
      }
      const hit = f ? group?.dataset.match === "1" || (el.textContent ?? "").toLowerCase().includes(f) : gi === section;
      el.style.display = hit ? "" : "none";
      if (hit) any = true;
    }
    close();
  }, [q, settings, section, visible]);
  const jump = (i: number) => {
    setQ("");
    setSection(i);
    listRef.current?.scrollTo({ top: 0 });
  };
  // Other tabs can open a section by its name (e.g. "ИИ" to add a key).
  useEffect(() => {
    const on = (e: Event) => {
      const name = (e as CustomEvent<string>).detail;
      const g = [...(listRef.current?.querySelectorAll<HTMLElement>(":scope > .set-group") ?? [])].find((x) => x.textContent?.startsWith(name));
      if (g) jump(Number(g.dataset.tab ?? 0));
    };
    window.addEventListener("settings-section", on);
    return () => window.removeEventListener("settings-section", on);
  }, []);
  // ---- data and version ----
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const [hotkeys, setHotkeys] = useState<Hotkey[]>([]);
  const [recordingKey, setRecordingKey] = useState<string | null>(null);
  useEffect(() => {
    if (visible) api?.call<Hotkey[]>("hotkeys_list").then((l) => setHotkeys(l ?? []));
  }, [api, visible]);
  const [checks, setChecks] = useState<{ group: string; title: string; status: "ok" | "warn" | "fail"; detail: string }[] | null>(null);
  const [checking, setChecking] = useState(false);
  const runCheck = () => {
    setChecking(true);
    api
      ?.call<typeof checks>("self_check")
      .then((c) => setChecks(c ?? []))
      .finally(() => setChecking(false));
  };
  const [resetArmed, setResetArmed] = useState(false);
  const [updateErr, setUpdateErr] = useState<string | null>(null);
  const [update, setUpdate] = useState<{ current: string; latest: string; url: string; newer: boolean } | null>(null);
  const [conn, setConn] = useState<Conn | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [skip, setSkip] = useState(settings.clipSkipApps.join(", "));
  const [hideFor, setHideFor] = useState((settings.hideForApps as string[]).join(", "));
  const [muted, setMuted] = useState((settings.notifyMuted as string[]).join(", "));
  const [access, setAccess] = useState<string | null>(null);
  useEffect(() => {
    if (visible && settings.showNotifications) api?.call<string>("notifications_access", { ask: false }).then(setAccess);
  }, [api, visible, settings.showNotifications]);
  // ---- keys ----
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});
  const [models, setModels] = useState<string[]>([]);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [devices, setDevices] = useState<{ outputs: { id: string; name: string; default: boolean }[]; inputs: { id: string; name: string; default: boolean }[] }>({ outputs: [], inputs: [] });
  const [vpnNames, setVpnNames] = useState<string[]>([]);
  const [apps, setApps] = useState<{ Name: string; AppID: string }[]>([]);
  const [monitors, setMonitors] = useState<{ index: number; name: string; width: number; height: number; primary: boolean }[]>([]);
  const refreshKeys = () =>
    api
      ?.call<Record<string, boolean>>("ai_key_status", { ids: [...PROVIDERS.map((p) => p.id), "imgbb", "imgur", "obs"] })
      .then((m) => setKeyStatus(m ?? {}));
  useEffect(() => {
    if (!visible) return;
    refreshKeys();
    api?.call<typeof monitors>("monitors_list").then((m) => setMonitors(m ?? []));
    api?.call<typeof devices>("audio_devices").then((d) => d && setDevices(d));
    api?.call<string[]>("vpn_names").then((n) => setVpnNames(n ?? []));
    api?.call<{ Name: string; AppID: string }[]>("apps_list").then((a) => setApps(a ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, visible]);
  const provider = providerOf(settings);
  const preset = PROVIDERS.find((p) => p.id === provider.id) ?? PROVIDERS[0];
  const keyRow = ({ id, title, sub, url }: { id: string; title: string; sub?: string; url?: string }) => (
    <Row title={title} sub={keyStatus[id] ? "Ключ сохранён (зашифрован Windows)" : sub}>
      <input
        className="search set-input"
        type="password"
        placeholder={keyStatus[id] ? "••••••••" : "вставь ключ"}
        value={keyDraft[id] ?? ""}
        onFocus={onTypeStart}
        onChange={(e) => setKeyDraft({ ...keyDraft, [id]: e.target.value })}
        onBlur={() => {
          const k = keyDraft[id];
          if (k === undefined) return;
          api?.call("ai_key_set", { id, key: k }).then(refreshKeys);
          setKeyDraft({ ...keyDraft, [id]: "" });
        }}
      />
      {url && !keyStatus[id] && (
        <button className="text-btn solid" onClick={() => api?.call("open_url", { url })}>
          Получить
        </button>
      )}
    </Row>
  );

  const list = (v: string) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  useEffect(() => {
    if (visible) api?.call<Conn>("agents_connections").then(setConn);
  }, [api, visible]);
  useEffect(() => setSkip(settings.clipSkipApps.join(", ")), [settings.clipSkipApps]);

  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const test = (which: string) => {
    setTestMsg((m) => ({ ...m, [which]: "проверяю…" }));
    api
      ?.call("agents_test", { which })
      .then(() => {
        setTestMsg((m) => ({ ...m, [which]: "связь есть — на острове должна была появиться карточка" }));
        api?.call<Conn>("agents_connections").then(setConn);
      })
      .catch((e) => setTestMsg((m) => ({ ...m, [which]: String(e) })));
  };
  const testBtn = (which: string, on?: boolean) =>
    on ? (
      <button className="text-btn" onClick={() => test(which)}>
        Проверить
      </button>
    ) : null;
  const connect = (which: "claude" | "codex" | "opencode", on: boolean, replace = false) => {
    setErr(null);
    api
      ?.call<Conn>("agents_connect", { which, on, replace })
      .then(setConn)
      .catch((e) => setErr(String(e)));
  };

  return (
    <div className="tab-settings list" ref={listRef}>
      <div className="set-tools">
        <input className="search" placeholder="Поиск по настройкам" value={q} onFocus={onTypeStart} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
        {!q && (
          <div className="set-jump">
            {groups.map((g, i) => (
              <button key={g} className={`chip ${i === section ? "on" : ""}`} onClick={() => jump(i)}>
                {g.replace(/\s*\(.*\)$/, "")}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="set-group" data-tab="0">Остров</div>
      <Row title="Линия над окнами" sub="Если окно заходит под остров (вкладки браузера), он становится тонкой линией">
        <Toggle on={settings.stripOverWindows} onChange={(v) => set({ stripOverWindows: v })} />
      </Row>
      <Row title="Прятаться в играх" sub="В полноэкранных играх острова нет совсем">
        <Toggle on={settings.hideInGames} onChange={(v) => set({ hideInGames: v })} />
      </Row>
      <Row title="Карточки событий">
        <Segmented
          value={settings.cardLength}
          options={[
            ["short", "Коротко"],
            ["normal", "Обычно"],
            ["long", "Дольше"],
          ]}
          onChange={(v) => set({ cardLength: v })}
        />
      </Row>

      <Row
        title="Важные уведомления"
        sub="Загрузки, ответы ИИ и агентов, напоминания, таймер, уведомления Windows. «Поверх всего» — и в играх (в окне без рамки; в исключительном полноэкранном режиме Windows не даёт рисовать поверх)"
      >
        <Segmented
          value={settings.cardsOver}
          options={[
            ["all", "Поверх всего"],
            ["apps", "Кроме игр"],
            ["desktop", "Только на свободном экране"],
          ]}
          onChange={(v) => set({ cardsOver: v })}
        />
      </Row>
      <Row title="Автоскрытие" sub="Остров уходит за край и возвращается, если задержать курсор у самого верха">
        <Toggle on={!!settings.autoHide} onChange={(v) => set({ autoHide: v })} />
      </Row>
      <Row title="Прятаться в программах" sub="Имена exe через запятую: остров уходит, пока одна из них впереди">
        <input className="search set-input" value={hideFor} onFocus={onTypeStart} onChange={(e) => setHideFor(e.target.value)} onBlur={() => set({ hideForApps: list(hideFor) })} />
      </Row>
      <Row title="Сквозной режим" sub="Свёрнутый остров пропускает клики и не раскрывается под курсором (Ctrl+Alt+T)">
        <Toggle on={!!settings.through} onChange={(v) => set({ through: v })} />
      </Row>

      <div className="set-group" data-tab="0">Вид</div>
      <Row title="Тема острова">
        <Segmented
          value={(settings.islandTheme as string) ?? "dark"}
          options={[
            ["dark", "Тёмная"],
            ["light", "Светлая"],
            ["system", "Как в Windows"],
          ]}
          onChange={(v) => set({ islandTheme: v })}
        />
      </Row>
      <SlowRange
        title="Размер"
        value={(settings.islandScale as number) ?? 1}
        min={0.8}
        max={2}
        step={0.1}
        label={(v) => `${Math.round(v * 100)}%`}
        onCommit={(v) => set({ islandScale: v })}
      />
      <Row title="Прозрачность свёрнутого" sub={`${Math.round(((settings.pillOpacity as number) ?? 1) * 100)}%`}>
        <input className="range" type="range" min={0.3} max={1} step={0.05} value={(settings.pillOpacity as number) ?? 1} onChange={(e) => set({ pillOpacity: Number(e.target.value) })} />
      </Row>
      <Row title="Прозрачность открытого" sub={`${Math.round(((settings.openOpacity as number) ?? 1) * 100)}%`}>
        <input className="range" type="range" min={0.5} max={1} step={0.05} value={(settings.openOpacity as number) ?? 1} onChange={(e) => set({ openOpacity: Number(e.target.value) })} />
      </Row>
      {monitors.length > 1 && (
        <Row title="Монитор">
          <Segmented
            value={String((settings.islandMonitor as number) ?? -1)}
            options={[["-1", "Основной"], ...monitors.map((m) => [String(m.index), `${m.index + 1}: ${m.width}×${m.height}`] as [string, string])]}
            onChange={(v) => set({ islandMonitor: Number(v) })}
          />
        </Row>
      )}
      <SlowRange
        title="Сдвиг вдоль края"
        value={(settings.islandOffset as number) ?? 0}
        min={-800}
        max={800}
        step={20}
        label={(v) => `${v} px`}
        onCommit={(v) => set({ islandOffset: v })}
      />

      <div className="set-group" data-tab="1">{settings.buddyName || "Клодик"}</div>
      <div className="set-row buddy-card">
        <div className="buddy-stage" title="Наведи, погладь, покрути колесо, кликни дважды">
          <Buddy size={64} />
        </div>
        <div className="buddy-side">
          <input
            className="search set-input buddy-name"
            defaultValue={settings.buddyName}
            maxLength={20}
            placeholder="Имя"
            onFocus={onTypeStart}
            onBlur={(e) => set({ buddyName: e.target.value.trim() || "Клодик" })}
          />
          <div className="buddy-tricks">
            {(
              [
                ["paper", "Бумаги"],
                ["magnify", "Лупа"],
                ["coffee", "Кофе"],
                ["read", "Книга"],
                ["laptop", "Ноутбук"],
                ["water", "Цветок"],
                ["juggle", "Жонглировать"],
                ["kite", "Змей"],
                ["dance", "Танец"],
              ] as [string, string][]
            ).map(([id, label]) => (
              <button key={id} className="chip" disabled={!settings.buddyLife} onClick={() => buddy.act(id, 4600)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="set-row pet-row">
        <div className="set-text">
          <div className="set-title">
            Дружба <span className="pet-hearts">{"♥".repeat(pet.hearts)}<i>{"♥".repeat(10 - pet.hearts)}</i></span>
          </div>
          <div className="set-sub">
            {pet.asleep ? "Спит в колпаке — не шуми" : pet.hungry ? "Проголодался и мечтает о печеньке" : "Сыт и доволен"}. Гладь, корми и играй — дружба растёт.
            Правый клик по нему в острове — то же меню.
          </div>
        </div>
        <div className="pet-buttons">
          <button className={`text-btn solid ${pet.hungry ? "accent" : ""}`} onClick={() => buddy.feed()}>
            Покормить
          </button>
          <button className="text-btn solid" onClick={() => buddy.play()}>
            Поиграть
          </button>
          <button className="text-btn solid" onClick={() => buddy.toggleSleep()}>
            {pet.asleep ? "Разбудить" : "Спать"}
          </button>
        </div>
      </div>
      <div className="look-label">
        Альбом наклеек · {Object.keys(buddy.stickers).length} из {STICKERS.length}
      </div>
      <div className="sticker-grid">
        {STICKERS.map((st) => {
          const got = buddy.stickers[st.id];
          return (
            <div key={st.id} className={`sticker ${got ? "" : "locked"}`} title={got ? `Получена ${new Date(got).toLocaleDateString("ru")}` : st.hint}>
              <i style={{ "--st": st.color } as React.CSSProperties}>{got ? st.icon : "?"}</i>
              <b>{st.title}</b>
              <small>{st.hint}</small>
            </div>
          );
        })}
      </div>
      <Row title="Твой день рождения" sub={`${settings.buddyName || "Клодик"} поздравит и испечёт торт`}>
        <select
          className="search set-input select narrow"
          value={(settings.userBirthday as string)?.split("-")[1] ?? ""}
          onChange={(e) => {
            const m = (settings.userBirthday as string)?.split("-")[0] || "01";
            set({ userBirthday: e.target.value ? `${m}-${e.target.value}` : "" });
          }}
        >
          <option value="">—</option>
          {Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0")).map((d) => (
            <option key={d} value={d}>
              {Number(d)}
            </option>
          ))}
        </select>
        <select
          className="search set-input select"
          value={(settings.userBirthday as string)?.split("-")[0] ?? ""}
          onChange={(e) => {
            const d = (settings.userBirthday as string)?.split("-")[1] || "01";
            set({ userBirthday: e.target.value ? `${e.target.value}-${d}` : "" });
          }}
        >
          <option value="">не указан</option>
          {["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"].map((name, i) => (
            <option key={name} value={String(i + 1).padStart(2, "0")}>
              {name}
            </option>
          ))}
        </select>
      </Row>
      <Row title="Звать на перерыв" sub="Если долго сидишь за компьютером без отдыха; во время помодоро молчит">
        {settings.breakReminder && (
          <Segmented
            value={String(settings.breakMinutes)}
            options={[
              ["30", "30 мин"],
              ["50", "50 мин"],
              ["90", "1,5 ч"],
            ]}
            onChange={(v) => set({ breakMinutes: Number(v) })}
          />
        )}
        <Toggle on={settings.breakReminder} onChange={(v) => set({ breakReminder: v })} />
      </Row>
      <Row
        title="Живёт своей жизнью"
        sub={
          settings.buddyLife
            ? "Сам находит себе дела, гуляет по вкладкам, одевается по погоде и к праздникам, голодает, если не кормить"
            : "Сидит на своём месте и следит за курсором"
        }
      >
        <Toggle on={settings.buddyLife} onChange={(v) => set({ buddyLife: v })} />
      </Row>
      <Row title="Звуки" sub="Тихие 8-битные пищалки: прыжки, еда, поглаживание, удивление">
        <Toggle on={settings.buddySounds} onChange={(v) => set({ buddySounds: v })} />
      </Row>
      <Row title="Размер" sub={`${Math.round(settings.buddyScale * 100)}%`}>
        <input className="range" type="range" min={1} max={2} step={0.1} value={settings.buddyScale} onChange={(e) => set({ buddyScale: Number(e.target.value) })} />
      </Row>
      <div className="look-label">Цвет</div>
      <div className="look-grid">
        {COLORS.map(([c, name]) => (
          <button key={c} className={`look-tile ${settings.buddyColor === c ? "on" : ""}`} title={name} onClick={() => set({ buddyColor: c })}>
            <Buddy size={30} still tint={c} wear={settings.buddyHat} />
            <span>{name}</span>
          </button>
        ))}
      </div>
      <div className="look-label">Наряд</div>
      <div className="look-grid">
        {HATS.map(([id, label]) => (
          <button key={id} className={`look-tile ${settings.buddyHat === id ? "on" : ""}`} onClick={() => set({ buddyHat: id })}>
            <Buddy size={30} still tint={settings.buddyColor} wear={id} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="set-group" data-tab="2">ИИ</div>
      <Row title="Сервис" sub={preset.note}>
        <select className="search set-input select" value={provider.id} onChange={(e) => set({ aiProvider: e.target.value })}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Row>
      {AI_HOWTO[provider.id] && (
        <details className="howto" open={!keyStatus[provider.id]}>
          <summary>Как подключить {preset.name}</summary>
          <ol>
            {AI_HOWTO[provider.id].steps.map((st) => (
              <li key={st}>
                <HowtoText text={st} api={api} />
              </li>
            ))}
          </ol>
          {provider.id !== "custom" && (
            <div className="howto-note howto-vpn">
              Из России и ряда других стран многие нейросети (Claude, OpenAI, Gemini и другие) работают только через VPN. Включи VPN
              (сервер в США или Европе) в режиме «системный прокси» или TUN — остров сам пойдёт через него. Ошибка «location is not
              supported», «unsupported country» или «Request not allowed» значит, что запрос прошёл мимо VPN: попробуй режим TUN.
            </div>
          )}
          <div className="howto-note">
            {AI_HOWTO[provider.id].note} Ключ шифруется Windows и уходит только в сам сервис. Чат — вкладка ✦ на острове или Ctrl+Alt+A; вопрос можно задать и в командной строке (Alt+Space).
          </div>
        </details>
      )}
      {keyRow({ id: provider.id, title: `Ключ ${preset.name}`, sub: "Хранится только на этом компьютере", url: preset.keyUrl })}
      {provider.id === "custom" && (
        <Row title="Адрес" sub="OpenAI-совместимый, например Ollama или LM Studio">
          <input className="search set-input" defaultValue={provider.base} onFocus={onTypeStart} onBlur={(e) => set({ [`aiBase_${provider.id}`]: e.target.value })} />
        </Row>
      )}
      <Row title="Модель" sub={modelErr ?? undefined}>
        <input
          className="search set-input"
          list="ai-models"
          key={provider.id}
          defaultValue={provider.model}
          onFocus={onTypeStart}
          onBlur={(e) => set({ [`aiModel_${provider.id}`]: e.target.value })}
        />
        <datalist id="ai-models">
          {(provider.protocol === "anthropic" && !models.length ? CLAUDE_MODELS : models).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <button
          className="text-btn solid"
          onClick={() => {
            setModelErr(null);
            api
              ?.call<string[]>("ai_models", { provider })
              .then((m) => setModels(m ?? []))
              .catch((e) => setModelErr(String(e)));
          }}
        >
          Список
        </button>
      </Row>

      <div className="set-group" data-tab="2">Голос в текст</div>
      <Row
        title="Чем распознавать"
        sub={
          settings.sttService === "windows"
            ? "Распознавание Windows: без ключа и регистрации. Нужно включить «Распознавание речи в сети» и языковой пакет речи"
            : "Whisper — точнее, особенно на длинных фразах; ключ тот же, что для ИИ этого сервиса"
        }
      >
        <Segmented
          value={settings.sttService}
          options={[
            ["windows", "Windows"],
            ["groq", "Groq"],
            ["openai", "OpenAI"],
          ]}
          onChange={(v) => set({ sttService: v })}
        />
      </Row>
      {settings.sttService === "windows" && (
        <Row title="Параметры речи Windows" sub="Если диктовка пишет, что выключена, — включи там распознавание в сети">
          <button className="text-btn solid" onClick={() => api?.call("open_windows_settings", { page: "speech" })}>
            Открыть
          </button>
        </Row>
      )}
      {settings.sttService !== "windows" &&
        !keyStatus[settings.sttService] &&
        keyRow({
          id: settings.sttService,
          title: "Ключ для диктовки",
          url: PROVIDERS.find((p) => p.id === settings.sttService)?.keyUrl,
        })}
      <Row title="Язык">
        <Segmented
          value={(settings.sttLang as string) ?? "ru"}
          options={[
            ["ru", "Русский"],
            ["en", "English"],
            ["", "Авто"],
          ]}
          onChange={(v) => set({ sttLang: v })}
        />
      </Row>
      <Row title="Сразу вставлять в окно" sub="Иначе текст только в буфере">
        <Toggle on={settings.dictationPaste !== false} onChange={(v) => set({ dictationPaste: v })} />
      </Row>

      <div className="set-group" data-tab="3">Запись экрана (Ctrl+Alt+R)</div>
      <Row title="Формат" sub="Файлы в «Видео → Dark Island»; GIF — 12 кадров в секунду, без звука">
        <Segmented
          value={settings.recordFormat}
          options={[
            ["mp4", "MP4"],
            ["gif", "GIF"],
          ]}
          onChange={(v) => set({ recordFormat: v })}
        />
      </Row>
      {settings.recordFormat !== "gif" && (
        <Row title="Звук в записи">
          <Segmented
            value={settings.recordSound}
            options={[
              ["none", "Без звука"],
              ["system", "Компьютер"],
              ["mic", "Микрофон"],
            ]}
            onChange={(v) => set({ recordSound: v })}
          />
        </Row>
      )}
      {settings.recordFormat !== "gif" && <Row title="Кадров в секунду" sub="H.264">
        <Segmented
          value={String((settings.recordFps as number) ?? 30)}
          options={[
            ["30", "30"],
            ["60", "60"],
          ]}
          onChange={(v) => set({ recordFps: Number(v) })}
        />
      </Row>}
      <Row title="Качество">
        <Segmented
          value={(settings.recordQuality as string) ?? "normal"}
          options={[
            ["normal", "Обычное"],
            ["high", "Высокое"],
          ]}
          onChange={(v) => set({ recordQuality: v })}
        />
      </Row>

      <div className="set-group" data-tab="3">Ссылка на скриншот</div>
      <Row title="Сервис" sub="Кнопка «Ссылка» на панели снимка; пока ключа нет, ничего не загружается">
        <Segmented
          value={(settings.uploadService as string) ?? "imgbb"}
          options={[
            ["imgbb", "ImgBB"],
            ["imgur", "Imgur"],
          ]}
          onChange={(v) => set({ uploadService: v })}
        />
      </Row>
      {keyRow({id: (settings.uploadService as string) ?? "imgbb",
        title: (settings.uploadService as string) === "imgur" ? "Client ID Imgur" : "Ключ ImgBB",
        url: (settings.uploadService as string) === "imgur" ? "https://api.imgur.com/oauth2/addclient" : "https://api.imgbb.com/",
      })}

      <div className="set-group" data-tab="4">Звук</div>
      <Row title="Громкость острова" sub="Чью громкость регулируют колесо и ползунок; сам звук никуда не переключается">
        <select className="search set-input select" value={(settings.volumeDevice as string) ?? ""} onChange={(e) => set({ volumeDevice: e.target.value })}>
          <option value="">Как в Windows</option>
          {devices.outputs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Row>
      <Row title="Микрофон острова" sub="Что выключает кнопка микрофона и откуда пишет диктовка">
        <select className="search set-input select" value={(settings.micDevice as string) ?? ""} onChange={(e) => set({ micDevice: e.target.value })}>
          <option value="">Все (диктовка — с основного)</option>
          {devices.inputs.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </Row>

      <div className="set-group" data-tab="4">Музыка</div>
      <Row title="Пилюля во время музыки" sub="«Текст» и «Только слова» — когда включён текст песни и он нашёлся">
        <Segmented
          value={settings.musicPill as string}
          options={[
            ["compact", "Обычная"],
            ["wide", "Широкая"],
            ["player", "Плеер"],
            ["lyrics", "Текст"],
            ["line", "Только слова"],
          ]}
          onChange={(v) => set({ musicPill: v as "compact" })}
        />
      </Row>
      <Row title="Текст песни" sub="Строка, которая звучит сейчас; тексты из открытой базы LRCLIB, только для играющей песни">
        <Toggle on={!!settings.lyrics} onChange={(v) => set({ lyrics: v })} />
      </Row>

      <div className="set-group" data-tab="5">Погода</div>
      <Row title="Температура на острове" sub="Город выбирается на вкладке «Погода»">
        <Toggle on={!!settings.weatherOnPill} onChange={(v) => set({ weatherOnPill: v })} />
      </Row>
      <Row title="Предупреждать о дожде и снеге" sub="Примерно за час">
        <Toggle on={!!settings.rainWarning} onChange={(v) => set({ rainWarning: v })} />
      </Row>

      <div className="set-group" data-tab="5">Уведомления Windows</div>
      <Row
        title="Показывать на острове"
        sub={
          !settings.showNotifications
            ? "Сообщения других программ карточкой; клик открывает программу"
            : access === "allowed"
              ? "Доступ есть"
              : "Нужно разрешить доступ к уведомлениям в Параметрах Windows"
        }
      >
        {settings.showNotifications && access !== "allowed" && (
          <button
            className="text-btn solid"
            onClick={() =>
              api?.call<string>("notifications_access", { ask: true }).then((a) => {
                setAccess(a);
                if (a !== "allowed") api?.call("open_windows_settings", { page: "notifications" });
              })
            }
          >
            Разрешить
          </button>
        )}
        <Toggle on={!!settings.showNotifications} onChange={(v) => set({ showNotifications: v })} />
      </Row>
      <Row title="Не показывать от программ" sub="Части названий через запятую">
        <input className="search set-input" value={muted} onFocus={onTypeStart} onChange={(e) => setMuted(e.target.value)} onBlur={() => set({ notifyMuted: list(muted).map((x) => x.toLowerCase()) })} />
      </Row>

      <div className="set-group" data-tab="6">Сеть</div>
      <Row title="Страна и IP при включении VPN" sub="Один запрос к ipwho.is, только когда VPN включается">
        <Toggle on={!!settings.vpnCountry} onChange={(v) => set({ vpnCountry: v })} />
      </Row>
      <Row title="Чем включать VPN" sub="Плитка в «Управлении», команда «vpn» и Ctrl+Alt+P">
        <Segmented
          value={settings.vpnClient}
          options={[
            ["app", "Программа"],
            ["warp", "WARP"],
            ["windows", "Windows"],
            ["custom", "Команды"],
          ]}
          onChange={(v) => set({ vpnClient: v })}
        />
      </Row>
      {settings.vpnClient === "app" && (
        <Row
          title="VPN-программа"
          sub="Happ, Incy, v2rayN, Hiddify… С системным прокси остров переключает сам, в режиме TUN — открывает программу"
        >
          <input
            className="search set-input"
            list="vpn-apps"
            key={settings.vpnAppName}
            defaultValue={settings.vpnAppName}
            placeholder="начни вводить название"
            onFocus={onTypeStart}
            onBlur={(e) => {
              const name = e.target.value.trim();
              const a = apps.find((x) => x.Name.toLowerCase() === name.toLowerCase());
              set(a ? { vpnApp: a.AppID, vpnAppName: a.Name } : { vpnApp: "", vpnAppName: "" });
            }}
          />
          <datalist id="vpn-apps">
            {apps.map((a) => (
              <option key={a.AppID} value={a.Name} />
            ))}
          </datalist>
        </Row>
      )}
      {settings.vpnClient === "windows" && (
        <Row title="Подключение" sub={vpnNames.length ? "Из Параметры → Сеть → VPN" : "В Windows нет VPN-подключений"}>
          {vpnNames.length ? (
            <select className="search set-input select" value={settings.vpnName} onChange={(e) => set({ vpnName: e.target.value })}>
              <option value="">не выбрано</option>
              {vpnNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          ) : (
            <button className="text-btn solid" onClick={() => api?.call("open_windows_settings", { page: "vpn" })}>
              Добавить
            </button>
          )}
        </Row>
      )}
      {settings.vpnClient === "custom" && (
        <>
          <Row title="Команда включения" sub="Например: wg-quick up или C:\Program Files\Client\cli.exe connect">
            <input className="search set-input" defaultValue={settings.vpnOn} onFocus={onTypeStart} onBlur={(e) => set({ vpnOn: e.target.value })} />
          </Row>
          <Row title="Команда выключения">
            <input className="search set-input" defaultValue={settings.vpnOff} onFocus={onTypeStart} onBlur={(e) => set({ vpnOff: e.target.value })} />
          </Row>
          <Row title="От администратора" sub="Windows спросит разрешение при каждом переключении">
            <Toggle on={!!settings.vpnAdmin} onChange={(v) => set({ vpnAdmin: v })} />
          </Row>
        </>
      )}

      <div className="set-group" data-tab="3">OBS Studio</div>
      <Row title="Показывать запись и эфир" sub="Через obs-websocket: в OBS — Инструменты → Настройки WebSocket-сервера, включить">
        <Toggle on={!!settings.obsEnabled} onChange={(v) => set({ obsEnabled: v })} />
      </Row>
      {settings.obsEnabled && (
        <>
          <Row title="Порт">
            <input className="search set-input narrow" defaultValue={settings.obsPort} onFocus={onTypeStart} onBlur={(e) => set({ obsPort: e.target.value.trim() || "4455" })} />
          </Row>
          {keyRow({ id: "obs", title: "Пароль сервера", sub: "Если в OBS включена аутентификация" })}
        </>
      )}

      <div className="set-group" data-tab="2">ИИ-агенты в терминале</div>
      <details className="howto">
        <summary>Как это работает</summary>
        <ol>
          <li>Нажми «Подключить» у своего агента — остров пропишет ему, куда сообщать (копия исходного файла сохранится рядом)</li>
          <li>Перезапусти агента: настройки он читает только при запуске</li>
          <li>Нажми «Проверить» — на острове должна появиться карточка «связь есть»</li>
        </ol>
        <div className="howto-note">
          На острове видно только важное: вопрос о разрешении с кнопками «Разрешить / Запретить» (30 секунд, потом вопрос остаётся в терминале) и итоговый ответ.
        </div>
      </details>
      <Row
        title="Claude Code"
        sub={testMsg.claude ?? (conn?.claude ? `Подключён: работа, вопросы и конец ответа; ${seenText(conn, "claude")}. Новые сессии подхватят сразу` : "Остров добавит свои хуки в ~/.claude/settings.json, копия файла останется рядом")}
      >
        {testBtn("claude", conn?.claude)}
        <button className="text-btn solid" onClick={() => connect("claude", !conn?.claude)}>
          {conn?.claude ? "Отключить" : "Подключить"}
        </button>
      </Row>
      <Row
        title="Codex"
        sub={
          testMsg.codex ??
          (conn?.codex
            ? `Подключён: вопросы о разрешении (с кнопками) и итоговые ответы; ${seenText(conn, "codex")}. Перезапусти Codex после подключения`
            : conn?.codex_busy
              ? "У Codex уже стоит другая программа уведомлений (notify), а он умеет только одну. «Заменить» — остров встанет вместо неё; старая строка останется в config.toml и вернётся при отключении"
              : "Остров добавит notify в ~/.codex/config.toml")
        }
      >
        {testBtn("codex", conn?.codex)}
        <button className="text-btn solid" onClick={() => connect("codex", !conn?.codex, !conn?.codex && conn?.codex_busy)}>
          {conn?.codex ? "Отключить" : conn?.codex_busy ? "Заменить" : "Подключить"}
        </button>
      </Row>
      <Row
        title="opencode"
        sub={testMsg.opencode ?? (conn?.opencode ? `Подключён: работа, вопросы и конец ответа; ${seenText(conn, "opencode")}` : "Остров положит свой плагин в ~/.config/opencode — перезапусти opencode после подключения")}
      >
        {testBtn("opencode", conn?.opencode)}
        <button className="text-btn solid" onClick={() => connect("opencode", !conn?.opencode)}>
          {conn?.opencode ? "Отключить" : "Подключить"}
        </button>
      </Row>
      {err && <div className="set-error">{err}</div>}
      <Row title="Показывать агентов на острове">
        <Toggle on={settings.agents} onChange={(v) => set({ agents: v })} />
      </Row>
      <Row title="Показывать, пока агент работает" sub="Клодик печатает в пилюле всё время работы. Выключено — только вопросы и итоговый ответ">
        <Toggle on={!!settings.agentsWorking} onChange={(v) => set({ agentsWorking: v })} />
      </Row>
      <Row title="Отвечать на разрешения с острова" sub="30 секунд на ответ, потом вопрос уходит в терминал">
        <Toggle on={settings.agentsAnswer} onChange={(v) => set({ agentsAnswer: v })} />
      </Row>

      <div className="set-group" data-tab="5">Буфер обмена</div>
      <Row title="Записывать историю">
        <Toggle on={settings.clipboardHistory} onChange={(v) => set({ clipboardHistory: v })} />
      </Row>
      <Row title="Не записывать из программ" sub="Имена exe через запятую, например keepass, 1password">
        <input
          className="search set-input"
          value={skip}
          onFocus={onTypeStart}
          onChange={(e) => setSkip(e.target.value)}
          onBlur={() =>
            set({
              clipSkipApps: skip
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </Row>

      <div className="set-group" data-tab="3">Скриншоты</div>
      <Row title="Сохранять в папку" sub="Изображения → Screenshots → Dark Island; в буфер снимок попадает всегда">
        <Toggle on={settings.screenshotSave !== false} onChange={(v) => set({ screenshotSave: v })} />
      </Row>
      <Row title="Показывать остров на скриншотах" sub="И в записи экрана, и на трансляциях">
        <Toggle on={settings.showInCaptures === true} onChange={(v) => set({ showInCaptures: v })} />
      </Row>

      <div className="set-group" data-tab="5">Поиск в командной строке</div>
      <Row title="Поисковик">
        <Segmented
          value={settings.searchEngine}
          options={Object.entries(ENGINES).map(([k, v]) => [k, v.name] as [string, string])}
          onChange={(v) => set({ searchEngine: v })}
        />
      </Row>

      <div className="set-group" data-tab="7">Проверка</div>
      <div className="set-row check-run">
        <div className="set-text">
          <div className="set-title">Проверить всё на этом компьютере</div>
          <div className="set-sub">Горячие клавиши, звук и микрофон, распознавание текста и речи, ключи, Wi-Fi и Bluetooth, уведомления, сеть, агенты, OBS, Steam</div>
        </div>
        <button className="text-btn solid accent" disabled={checking} onClick={runCheck}>
          {checking ? "Проверяю…" : checks ? "Ещё раз" : "Проверить"}
        </button>
      </div>
      {checks && (
        <div className="check-list">
          {checks.map((c, i) => (
            <div key={i} className={`check-item ${c.status}`}>
              <i>{c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✕"}</i>
              <span className="check-group">{c.group}</span>
              <b>{c.title}</b>
              <span className="check-detail">{c.detail}</span>
            </div>
          ))}
        </div>
      )}
      <div className="set-group" data-tab="7">Данные и версия</div>
      <Row title="Настройки в файл" sub={dataMsg ?? "Перенести на другой компьютер или сохранить на всякий случай. Ключи ИИ и подключения агентов в файл не попадают"}>
        <button
          className="text-btn solid"
          onClick={() =>
            api
              ?.call<string | null>("settings_export")
              .then((p) => p && setDataMsg(`Сохранено: ${p}`))
              .catch((e) => setDataMsg(String(e)))
          }
        >
          Сохранить
        </button>
        <button
          className="text-btn solid"
          onClick={() =>
            api
              ?.call<Record<string, unknown> | null>("settings_import")
              .then((v) => v && setDataMsg("Настройки загружены"))
              .catch((e) => setDataMsg(String(e)))
          }
        >
          Загрузить
        </button>
      </Row>
      <Row title="Сбросить настройки" sub={resetArmed ? "Нажми ещё раз — всё вернётся как после установки" : "Ключи, подключения агентов и Клодик-питомец останутся"}>
        <button
          className={`text-btn solid ${resetArmed ? "danger" : ""}`}
          onClick={() => {
            if (!resetArmed) {
              setResetArmed(true);
              window.setTimeout(() => setResetArmed(false), 4000);
              return;
            }
            setResetArmed(false);
            api?.call("settings_reset").then(() => setDataMsg("Настройки сброшены"));
          }}
        >
          {resetArmed ? "Точно сбросить" : "Сбросить"}
        </button>
      </Row>
      <Row
        title="Обновления"
        sub={
          updateErr
            ? updateErr
            : !update
            ? "Остров сам ничего не скачивает: кнопка только сравнит версию с последним релизом на GitHub"
            : update.newer
              ? `Есть версия ${update.latest} (у тебя ${update.current})`
              : `У тебя последняя версия — ${update.current}`
        }
      >
        {update?.newer ? (
          <button className="text-btn solid accent" onClick={() => api?.call("open_url", { url: update.url })}>
            Открыть релиз
          </button>
        ) : (
          <button
            className="text-btn solid"
            onClick={() =>
              api
                ?.call<typeof update>("update_check")
                .then(setUpdate)
                .catch((e) => setUpdateErr(String(e)))
            }
          >
            Проверить
          </button>
        )}
      </Row>

      <Row title="Знакомство" sub="Короткий тур по острову, как при первом запуске">
        <button className="text-btn solid" onClick={() => api?.call("tour_start")}>
          Показать снова
        </button>
      </Row>

      <div className="set-group" data-tab="7">Если что-то не работает</div>
      <Row title="Журнал" sub="Полка, микрофон и другие системные действия пишут сюда, что произошло — пришли его, если что-то сломалось">
        <button className="text-btn solid" onClick={() => api?.call("diag_open")}>
          Открыть
        </button>
      </Row>

      <div className="set-group" data-tab="7">Горячие клавиши</div>
      <div className="set-sub keys-hint">
        Нажми на сочетание и затем новые клавиши. Backspace — выключить, «Сброс» — как было. Красным — занято другой программой.
      </div>
      {hotkeys.map((h) => (
        <div key={h.action} className={`set-row hotkey-row ${h.taken ? "taken" : ""}`}>
          <div className="set-text">
            <div className="set-title">{h.title}</div>
            {h.taken && <div className="set-sub bad-text">занято другой программой — выбери другое</div>}
          </div>
          <button
            className={`text-btn solid hotkey-btn ${recordingKey === h.action ? "accent" : ""}`}
            onClick={() => {
              setRecordingKey(h.action);
              api?.call("hotkeys_pause", { on: true });
            }}
            onBlur={() => {
              if (recordingKey !== h.action) return;
              setRecordingKey(null);
              api?.call("hotkeys_pause", { on: false });
            }}
            onKeyDown={(e) => {
              if (recordingKey !== h.action) return;
              e.preventDefault();
              if (e.key === "Escape") {
                setRecordingKey(null);
                return void api?.call("hotkeys_pause", { on: false });
              }
              if (e.key === "Backspace" || e.key === "Delete") {
                setRecordingKey(null);
                return void api?.call<Hotkey[]>("hotkey_set", { action: h.action, combo: "" }).then((l) => l && setHotkeys(l));
              }
              const k = comboOf(e);
              if (!k) return;
              setRecordingKey(null);
              api?.call<Hotkey[]>("hotkey_set", { action: h.action, combo: k }).then((l) => l && setHotkeys(l));
            }}
          >
            {recordingKey === h.action ? "Нажми сочетание…" : h.combo ? keyLabel(h.combo) : "выключено"}
          </button>
          {h.combo !== h.default && (
            <button className="text-btn" onClick={() => api?.call<Hotkey[]>("hotkey_set", { action: h.action, combo: null }).then((l) => l && setHotkeys(l))}>
              Сброс
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
