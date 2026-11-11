import { useEffect, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { ENGINES, type Settings } from "../settings";
import { CLAUDE_MODELS, PROVIDERS, providerOf } from "../ai";
import { Buddy, COLORS, HATS, buddy, usePet } from "../components/Buddy";

type Conn = { claude: boolean; codex: boolean; codex_busy: boolean; opencode: boolean };

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
  const [groups, setGroups] = useState<string[]>([]);
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    setGroups([...root.querySelectorAll<HTMLElement>(":scope > .set-group")].map((g) => g.textContent ?? ""));
  }, [visible, settings.buddyName]);
  // Rows that don't match hide; a section without matches hides its title.
  useEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const f = q.trim().toLowerCase();
    let group: HTMLElement | null = null;
    let any = false;
    const close = () => group && (group.style.display = f && !any ? "none" : "");
    for (const el of root.querySelectorAll<HTMLElement>(":scope > *")) {
      if (el.classList.contains("set-tools")) continue;
      if (el.classList.contains("set-group")) {
        close();
        group = el;
        any = !f || (el.textContent ?? "").toLowerCase().includes(f);
        el.dataset.match = any ? "1" : "";
        continue;
      }
      const hit = !f || group?.dataset.match === "1" || (el.textContent ?? "").toLowerCase().includes(f);
      el.style.display = hit ? "" : "none";
      if (hit) any = true;
    }
    close();
  }, [q, settings]);
  const jump = (name: string) => {
    setQ("");
    const g = [...(listRef.current?.querySelectorAll<HTMLElement>(":scope > .set-group") ?? [])].find((x) => x.textContent === name);
    g?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // ---- data and version ----
  const [dataMsg, setDataMsg] = useState<string | null>(null);
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

  const connect = (which: "claude" | "codex" | "opencode", on: boolean) => {
    setErr(null);
    api
      ?.call<Conn>("agents_connect", { which, on })
      .then(setConn)
      .catch((e) => setErr(String(e)));
  };

  return (
    <div className="tab-settings list" ref={listRef}>
      <div className="set-tools">
        <input className="search" placeholder="Поиск по настройкам" value={q} onFocus={onTypeStart} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQ("")} />
        {!q && (
          <div className="set-jump">
            {groups.map((g) => (
              <button key={g} className="chip" onClick={() => jump(g)}>
                {g.replace(/\s*\(.*\)$/, "")}
              </button>
            ))}
          </div>
        )}
      </div>
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

      <Row title="Автоскрытие" sub="Остров уходит за край и возвращается, если задержать курсор у самого верха">
        <Toggle on={!!settings.autoHide} onChange={(v) => set({ autoHide: v })} />
      </Row>
      <Row title="Прятаться в программах" sub="Имена exe через запятую: остров уходит, пока одна из них впереди">
        <input className="search set-input" value={hideFor} onFocus={onTypeStart} onChange={(e) => setHideFor(e.target.value)} onBlur={() => set({ hideForApps: list(hideFor) })} />
      </Row>
      <Row title="Сквозной режим" sub="Свёрнутый остров пропускает клики и не раскрывается под курсором (Ctrl+Alt+T)">
        <Toggle on={!!settings.through} onChange={(v) => set({ through: v })} />
      </Row>

      <div className="set-group">Вид</div>
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

      <div className="set-group">{settings.buddyName || "Клодик"}</div>
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
      <Row title="Цвет">
        <div className="swatches">
          {COLORS.map(([c, name]) => (
            <button
              key={c}
              className={`swatch ${settings.buddyColor === c ? "on" : ""}`}
              title={name}
              style={{ background: c }}
              onClick={() => set({ buddyColor: c })}
            />
          ))}
        </div>
      </Row>
      <div className="set-row hats">
        <div className="set-text">
          <div className="set-title">Наряд</div>
        </div>
        <div className="hat-grid">
          {HATS.map(([id, label]) => (
            <button key={id} className={`chip ${settings.buddyHat === id ? "on" : ""}`} onClick={() => set({ buddyHat: id })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="set-group">ИИ</div>
      <Row title="Сервис" sub={preset.note}>
        <select className="search set-input select" value={provider.id} onChange={(e) => set({ aiProvider: e.target.value })}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Row>
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

      <div className="set-group">Голос в текст (Ctrl+Alt+D)</div>
      <Row title="Сервис распознавания" sub="Whisper; ключ тот же, что для ИИ этого сервиса">
        <Segmented
          value={(settings.sttService as string) ?? "groq"}
          options={[
            ["groq", "Groq"],
            ["openai", "OpenAI"],
          ]}
          onChange={(v) => set({ sttService: v })}
        />
      </Row>
      {!keyStatus[(settings.sttService as string) ?? "groq"] &&
        keyRow({
          id: (settings.sttService as string) ?? "groq",
          title: "Ключ для диктовки",
          url: PROVIDERS.find((p) => p.id === ((settings.sttService as string) ?? "groq"))?.keyUrl,
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

      <div className="set-group">Запись экрана (Ctrl+Alt+R)</div>
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

      <div className="set-group">Ссылка на скриншот</div>
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

      <div className="set-group">Звук</div>
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

      <div className="set-group">Музыка</div>
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

      <div className="set-group">Погода</div>
      <Row title="Температура на острове" sub="Город выбирается на вкладке «Погода»">
        <Toggle on={!!settings.weatherOnPill} onChange={(v) => set({ weatherOnPill: v })} />
      </Row>
      <Row title="Предупреждать о дожде и снеге" sub="Примерно за час">
        <Toggle on={!!settings.rainWarning} onChange={(v) => set({ rainWarning: v })} />
      </Row>

      <div className="set-group">Уведомления Windows</div>
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

      <div className="set-group">Сеть</div>
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

      <div className="set-group">OBS Studio</div>
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
      <Row title="opencode" sub={conn?.opencode ? "Подключён: работа, вопросы и конец ответа видны на острове" : "Остров положит свой плагин в ~/.config/opencode — перезапусти opencode после подключения"}>
        <button className="text-btn solid" onClick={() => connect("opencode", !conn?.opencode)}>
          {conn?.opencode ? "Отключить" : "Подключить"}
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

      <div className="set-group">Данные и версия</div>
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

      <div className="set-group">Если что-то не работает</div>
      <Row title="Журнал" sub="Полка, микрофон и другие системные действия пишут сюда, что произошло — пришли его, если что-то сломалось">
        <button className="text-btn solid" onClick={() => api?.call("diag_open")}>
          Открыть
        </button>
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
        <span>Ctrl+Alt+M</span> микрофон: выключить и включить
        <span>Ctrl+Alt+T</span> сквозной режим
        <span>Ctrl+Alt+A</span> чат с ИИ
        <span>Ctrl+Alt+D</span> голос в текст
        <span>Ctrl+Alt+R</span> запись экрана
        <span>Ctrl+Alt+Shift+V</span> вставить без форматирования
        <span>Ctrl+Alt+P</span> VPN: включить и выключить
      </div>
    </div>
  );
}
