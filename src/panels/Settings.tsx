import { useEffect, useState } from "react";
import type { Bridge } from "../ipc";
import { ENGINES, type Settings } from "../settings";

type Conn = { claude: boolean; codex: boolean; codex_busy: boolean };

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
  const [conn, setConn] = useState<Conn | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [skip, setSkip] = useState(settings.clipSkipApps.join(", "));
  useEffect(() => {
    if (visible) api?.call<Conn>("agents_connections").then(setConn);
  }, [api, visible]);
  useEffect(() => setSkip(settings.clipSkipApps.join(", ")), [settings.clipSkipApps]);

  const connect = (which: "claude" | "codex", on: boolean) => {
    setErr(null);
    api
      ?.call<Conn>("agents_connect", { which, on })
      .then(setConn)
      .catch((e) => setErr(String(e)));
  };

  return (
    <div className="tab-settings list">
      <div className="set-group">Остров</div>
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

      <div className="set-group">ИИ-агенты в терминале</div>
      <Row title="Claude Code" sub={conn?.claude ? "Подключён: остров видит, что он делает" : "Остров добавит свои хуки в ~/.claude/settings.json, копия файла останется рядом"}>
        <button className="text-btn solid" onClick={() => connect("claude", !conn?.claude)}>
          {conn?.claude ? "Отключить" : "Подключить"}
        </button>
      </Row>
      <Row title="Codex" sub={conn?.codex ? "Подключён: остров узнаёт, когда он закончил" : conn?.codex_busy ? "У Codex уже есть свой notify в config.toml" : "Остров добавит notify в ~/.codex/config.toml"}>
        <button className="text-btn solid" disabled={!conn?.codex && conn?.codex_busy} onClick={() => connect("codex", !conn?.codex)}>
          {conn?.codex ? "Отключить" : "Подключить"}
        </button>
      </Row>
      {err && <div className="set-error">{err}</div>}
      <Row title="Показывать агентов на острове">
        <Toggle on={settings.agents} onChange={(v) => set({ agents: v })} />
      </Row>
      <Row title="Отвечать на разрешения с острова" sub="30 секунд на ответ, потом вопрос уходит в терминал">
        <Toggle on={settings.agentsAnswer} onChange={(v) => set({ agentsAnswer: v })} />
      </Row>

      <div className="set-group">Буфер обмена</div>
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

      <div className="set-group">Скриншоты</div>
      <Row title="Сохранять в папку" sub="Изображения → Screenshots → Dark Island; в буфер снимок попадает всегда">
        <Toggle on={settings.screenshotSave !== false} onChange={(v) => set({ screenshotSave: v })} />
      </Row>
      <Row title="Показывать остров на скриншотах" sub="И в записи экрана, и на трансляциях">
        <Toggle on={settings.showInCaptures === true} onChange={(v) => set({ showInCaptures: v })} />
      </Row>

      <div className="set-group">Поиск в командной строке</div>
      <Row title="Поисковик">
        <Segmented
          value={settings.searchEngine}
          options={Object.entries(ENGINES).map(([k, v]) => [k, v.name] as [string, string])}
          onChange={(v) => set({ searchEngine: v })}
        />
      </Row>

      <div className="set-group">Горячие клавиши</div>
      <div className="keys">
        <span>Ctrl+Alt+I</span> открыть или закрыть остров
        <span>Alt+Space</span> командная строка
        <span>Ctrl+Alt+V</span> история буфера
        <span>Ctrl+Alt+S</span> скриншот области
        <span>Ctrl+Alt+Shift+S</span> скриншот экрана
        <span>Ctrl+Alt+O</span> текст с экрана
        <span>Ctrl+Alt+Q</span> QR-код с экрана
        <span>Ctrl+Alt+C</span> пипетка
      </div>
    </div>
  );
}
