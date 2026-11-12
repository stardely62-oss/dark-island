import { useEffect, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { providerOf, useAi, type AiDoc, type AiMsg } from "../ai";
import type { Settings } from "../settings";
import { TabAi } from "../components/Icons";
import { b64dec, b64enc, fixLayout, minJson, prettyJson, sentence, title, translit, urlDec } from "../textTools";

const CHAT_KEY = "island.chat";
const SYSTEM =
  "Ты — помощник в маленькой панели на рабочем столе Windows. Отвечай по-русски, если к тебе обращаются по-русски. Пиши коротко и по делу: панель узкая. Без Markdown-таблиц.";

/** Where "Перевести" goes: auto is Russian ↔ English. */
export const LANGS: [string, string][] = [
  ["auto", "Авто (рус ↔ англ)"],
  ["русский", "Русский"],
  ["английский", "Английский"],
  ["украинский", "Украинский"],
  ["немецкий", "Немецкий"],
  ["французский", "Французский"],
  ["испанский", "Испанский"],
  ["итальянский", "Итальянский"],
  ["польский", "Польский"],
  ["турецкий", "Турецкий"],
  ["китайский", "Китайский"],
  ["японский", "Японский"],
  ["корейский", "Корейский"],
  ["казахский", "Казахский"],
];
const translatePrompt = (to: string) =>
  !to || to === "auto"
    ? "Переведи: с русского на английский, с любого другого языка — на русский."
    : `Переведи на ${to} язык (если текст уже на нём — на русский).`;

function loadChat(): AiMsg[] {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

const DOC = (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" aria-hidden>
    <path d="M6 3h8l4 4v14H6Z M14 3v4h4" />
  </svg>
);

/** Chat with the AI, and tools for a piece of text (local ones and AI actions). */
export function AiTab({
  api,
  settings,
  visible,
  onTypeStart,
  ask,
  onAsked,
  tool,
  onTool,
  openSettings,
}: {
  api: Bridge | null;
  settings: Settings;
  visible: boolean;
  onTypeStart: () => void;
  /** A question from the command bar to send right away. */
  ask: string | null;
  onAsked: () => void;
  /** Text from elsewhere (the screen) to run a text tool on. */
  tool: { text: string; action: "translate" } | null;
  onTool: () => void;
  openSettings: () => void;
}) {
  const [view, setView] = useState<"chat" | "text">("chat");
  const run = useAi(api);
  const provider = providerOf(settings);
  const translateTo = (settings.translateTo as string) || "auto";
  const [hasKey, setHasKey] = useState(true);
  useEffect(() => {
    if (visible) api?.call<Record<string, boolean>>("ai_key_status", { ids: [provider.id] }).then((m) => setHasKey(!!m?.[provider.id]));
  }, [api, visible, provider.id]);

  // ---- chat ----
  const [msgs, setMsgs] = useState<AiMsg[]>(loadChat);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [docs, setDocs] = useState<AiDoc[]>([]);
  // ---- dictation into the box ----
  const [listening, setListening] = useState<"" | "rec" | "busy">("");
  const mine = useRef(false);
  useEffect(() => {
    if (!api) return;
    return api.on("dictation", (d) => {
      if (!mine.current) return;
      if (d.state === "rec" || d.state === "busy") setListening((l) => (l === "busy" ? "busy" : d.state === "busy" ? "busy" : "rec"));
      else {
        clearTimeout(resetTimer.current);
        setListening("");
        mine.current = false;
      }
    });
  }, [api]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<string>).detail.trim();
      if (t) setInput((v) => (v.trim() ? `${v.trimEnd()} ${t}` : t));
    };
    window.addEventListener("chat-dictation", on);
    return () => window.removeEventListener("chat-dictation", on);
  }, []);
  const resetTimer = useRef(0);
  const dictate = () => {
    clearTimeout(resetTimer.current);
    if (listening === "busy") return;
    mine.current = true;
    if (!listening) setListening("rec");
    else {
      // Stopping: show it at once; if nothing comes back, the button frees itself.
      setListening("busy");
      resetTimer.current = window.setTimeout(() => {
        setListening("");
        mine.current = false;
      }, 12_000);
    }
    api?.call("dictate_toggle", { target: "chat" });
  };
  const [docErr, setDocErr] = useState<string | null>(null);
  const attach = () =>
    api?.call<{ name: string; text: string | null; error: string | null }[]>("doc_pick").then((list) => {
      const ok = (list ?? []).filter((d) => d.text).map((d) => ({ name: d.name, text: d.text! }));
      const bad = (list ?? []).filter((d) => d.error);
      setDocs((cur) => [...cur, ...ok].slice(-4));
      setDocErr(bad.length ? `${bad[0].name}: ${bad[0].error}` : null);
    });
  const [busy, setBusy] = useState(false);
  const answer = useRef("");
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      // Pictures and documents stay out of storage: only their names are kept.
      localStorage.setItem(
        CHAT_KEY,
        JSON.stringify(msgs.slice(-40).map((m) => ({ ...m, images: [], docs: m.docs?.map((d) => ({ name: d.name, text: "" })) }))),
      );
    } catch {
      /* storage full or unavailable */
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);

  const send = (text: string, imgs: string[] = images, files: AiDoc[] = docs) => {
    if ((!text.trim() && !files.length) || busy) return;
    const ask = text.trim() || "Что в этом документе? Коротко перескажи главное.";
    const next: AiMsg[] = [...msgs, { role: "user", text: ask, images: imgs, docs: files }];
    setMsgs([...next, { role: "assistant", text: "" }]);
    setInput("");
    setImages([]);
    setDocs([]);
    setDocErr(null);
    setBusy(true);
    setError(null);
    stopRef.current = run(
      provider,
      SYSTEM,
      next.slice(-20),
      (t) => {
        answer.current = t;
        setMsgs([...next, { role: "assistant", text: t }]);
      },
      (err) => {
        setBusy(false);
        stopRef.current = null;
        if (err) {
          setError(err);
          setMsgs((m) => (m[m.length - 1]?.text ? m : m.slice(0, -1)));
        } else if (!visibleRef.current && answer.current) {
          // You went elsewhere while it thought: the answer comes as a card.
          window.dispatchEvent(new CustomEvent("ai-answered", { detail: answer.current }));
        }
      },
    );
  };

  useEffect(() => {
    if (ask && visible) {
      setView("chat");
      send(ask, [], []);
      onAsked();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask, visible]);

  // ---- text tools ----
  const [src, setSrc] = useState("");
  const [out, setOut] = useState("");
  const [toolBusy, setToolBusy] = useState(false);
  useEffect(() => {
    if (visible && view === "text" && !src) api?.call<string | null>("clip_current_text").then((t) => t && setSrc(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, view]);
  const local = (f: (s: string) => string) => {
    try {
      setOut(f(src));
    } catch (e) {
      setOut(e instanceof Error && /^Это не/.test(e.message) ? e.message : `Не получилось: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const aiAction = (prompt: string, text = src) => {
    if (!text.trim() || toolBusy) return;
    setToolBusy(true);
    setOut("");
    run(
      provider,
      "Ты редактор текста. Верни только результат, без пояснений и кавычек.",
      [{ role: "user", text: `${prompt}\n\n${text}` }],
      (t) => setOut(t),
      (err) => {
        setToolBusy(false);
        if (err) setOut(`Ошибка: ${err}`);
      },
    );
  };

  useEffect(() => {
    if (!tool || !visible) return;
    setView("text");
    setSrc(tool.text);
    if (tool.action === "translate") aiAction(translatePrompt(translateTo), tool.text);
    onTool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, visible]);

  return (
    <div className="tab-ai">
      <div className="tab-bar">
        <div className="segmented">
          <button className={view === "chat" ? "on" : ""} onClick={() => setView("chat")}>
            Чат
          </button>
          <button className={view === "text" ? "on" : ""} onClick={() => setView("text")}>
            Текст
          </button>
        </div>
        <span className="grow" />
        <span className="muted model-name" title={provider.base}>
          {provider.model || "модель не выбрана"}
        </span>
        {view === "chat" && msgs.length > 0 && (
          <button className="text-btn" onClick={() => (stopRef.current?.(), setMsgs([]), setBusy(false))}>
            Новый
          </button>
        )}
      </div>

      {!hasKey && (
        <div className="ai-nokey">
          <span className="grow">Нужен ключ ИИ — хранится только на этом компьютере</span>
          <button className="text-btn solid accent" onClick={openSettings}>
            Добавить ключ
          </button>
        </div>
      )}

      {view === "chat" ? (
        <>
          <div className="chat list" ref={listRef}>
            {msgs.length === 0 && <div className="empty">Спроси что угодно. Картинку можно вставить через Ctrl+V, документ — скрепкой.</div>}
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.images?.map((u, k) => <img key={k} src={u} alt="" />)}
                {m.docs?.map((d, k) => (
                  <span key={k} className="doc-chip sent">
                    {DOC} {d.name}
                  </span>
                ))}
                {m.text || (busy && i === msgs.length - 1 ? <span className="dots"><i /><i /><i /></span> : null)}
              </div>
            ))}
            {error && <div className="set-error">{error}</div>}
            {docErr && <div className="set-error">{docErr}</div>}
          </div>
          {docs.length > 0 && (
            <div className="doc-row">
              {docs.map((d, k) => (
                <button key={k} className="doc-chip" title={`${d.text.length.toLocaleString("ru")} знаков — убрать`} onClick={() => setDocs(docs.filter((_, j) => j !== k))}>
                  {DOC} {d.name}
                  <span className="x">×</span>
                </button>
              ))}
            </div>
          )}
          <div className="chat-input">
            <button className="clip-btn" aria-label="Приложить документ" title="PDF, Word, Excel, PowerPoint или текст" onClick={attach}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="m20 11.5-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l8-8" />
              </svg>
            </button>
            {images.map((u, k) => (
              <img key={k} className="attach" src={u} alt="" title="Убрать" onClick={() => setImages(images.filter((_, j) => j !== k))} />
            ))}
            <textarea
              rows={1}
              value={input}
              placeholder="Сообщение"
              onFocus={onTypeStart}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                for (const item of e.clipboardData.items) {
                  if (item.type.startsWith("image/")) {
                    const f = item.getAsFile();
                    if (!f) continue;
                    e.preventDefault();
                    const r = new FileReader();
                    r.onload = () => setImages((im) => [...im, String(r.result)].slice(-3));
                    r.readAsDataURL(f);
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
            <button
              className={`mic-btn ${listening}`}
              aria-label={listening ? "Закончить диктовку" : "Сказать голосом"}
              title={listening === "busy" ? "Распознаю…" : listening ? "Нажми, когда закончишь" : "Сказать голосом"}
              onClick={dictate}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
              </svg>
            </button>
            {busy ? (
              <button className="send" aria-label="Остановить" onClick={() => (stopRef.current?.(), setBusy(false))}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button className="send" aria-label="Отправить" disabled={!input.trim() && !docs.length} onClick={() => send(input)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 19V5M6 11l6-6 6 6" />
                </svg>
              </button>
            )}
          </div>
        </>
      ) : (
        <div className="text-tools">
          <textarea className="note small" value={src} placeholder="Текст (подставляется из буфера)" onFocus={onTypeStart} onChange={(e) => setSrc(e.target.value)} />
          <div className="tool-chips">
            {(
              [
                ["Раскладка", () => local(fixLayout)],
                ["АБВ", () => local((s) => s.toUpperCase())],
                ["абв", () => local((s) => s.toLowerCase())],
                ["Аа", () => local(sentence)],
                ["Аа Бб", () => local(title)],
                ["Транслит", () => local(translit)],
                ["JSON красиво", () => local(prettyJson)],
                ["JSON в строку", () => local(minJson)],
                ["Base64", () => local(b64enc)],
                ["из Base64", () => local(b64dec)],
                ["URL", () => local(encodeURIComponent)],
                ["из URL", () => local(urlDec)],
              ] as [string, () => void][]
            ).map(([label, f]) => (
              <button key={label} className="chip" onClick={f}>
                {label}
              </button>
            ))}
            {(
              [
                ["Исправить", "Исправь орфографию, пунктуацию и стиль, сохранив смысл и язык."],
                ["Сократить", "Сократи текст вдвое, сохранив главное."],
                ["Объяснить", "Объясни простыми словами, что здесь написано."],
                ["Ответить", "Напиши короткий вежливый ответ на это сообщение, на его языке."],
              ] as [string, string][]
            ).map(([label, prompt]) => (
              <button key={label} className="chip ai" disabled={toolBusy || !hasKey} onClick={() => aiAction(prompt)}>
                <TabAi size={11} /> {label}
              </button>
            ))}
          </div>
          <div className="tool-chips translate-row">
            <button className="chip ai" disabled={toolBusy || !hasKey} onClick={() => aiAction(translatePrompt(translateTo))}>
              <TabAi size={11} /> Перевести
            </button>
            <span className="muted">на</span>
            <select
              className="chip lang-pick"
              value={translateTo}
              onChange={(e) => {
                api?.call("settings_set", { patch: { translateTo: e.target.value } });
                if (src.trim() && !toolBusy && hasKey) aiAction(translatePrompt(e.target.value));
              }}
            >
              {LANGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
          <div className="text-out">
            <div className="out">{out || <span className="muted">Результат появится здесь</span>}</div>
            <div className="out-actions">
              <button className="text-btn solid" disabled={!out} onClick={() => api?.call("paste_text", { text: out, paste: false })}>
                Копировать
              </button>
              <button className="text-btn solid accent" disabled={!out} onClick={() => api?.call("paste_text", { text: out, paste: true })}>
                Вставить
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
