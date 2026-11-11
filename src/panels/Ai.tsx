import { useEffect, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import { providerOf, useAi, type AiMsg } from "../ai";
import type { Settings } from "../settings";
import { b64dec, b64enc, fixLayout, minJson, prettyJson, sentence, title, translit } from "../textTools";

const CHAT_KEY = "island.chat";
const SYSTEM =
  "Ты — помощник в маленькой панели на рабочем столе Windows. Отвечай по-русски, если к тебе обращаются по-русски. Пиши коротко и по делу: панель узкая. Без Markdown-таблиц.";

function loadChat(): AiMsg[] {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/** Chat with the AI, and tools for a piece of text (local ones and AI actions). */
export function AiTab({
  api,
  settings,
  visible,
  onTypeStart,
  ask,
  onAsked,
  openSettings,
}: {
  api: Bridge | null;
  settings: Settings;
  visible: boolean;
  onTypeStart: () => void;
  /** A question from the command bar to send right away. */
  ask: string | null;
  onAsked: () => void;
  openSettings: () => void;
}) {
  const [view, setView] = useState<"chat" | "text">("chat");
  const run = useAi(api);
  const provider = providerOf(settings);
  const [hasKey, setHasKey] = useState(true);
  useEffect(() => {
    if (visible) api?.call<Record<string, boolean>>("ai_key_status", { ids: [provider.id] }).then((m) => setHasKey(!!m?.[provider.id]));
  }, [api, visible, provider.id]);

  // ---- chat ----
  const [msgs, setMsgs] = useState<AiMsg[]>(loadChat);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-40).map((m) => ({ ...m, images: [] }))));
    } catch {
      /* storage full or unavailable */
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);

  const send = (text: string, imgs: string[] = images) => {
    if (!text.trim() || busy) return;
    const next: AiMsg[] = [...msgs, { role: "user", text, images: imgs }];
    setMsgs([...next, { role: "assistant", text: "" }]);
    setInput("");
    setImages([]);
    setBusy(true);
    setError(null);
    stopRef.current = run(
      provider,
      SYSTEM,
      next.slice(-20),
      (t) => setMsgs([...next, { role: "assistant", text: t }]),
      (err) => {
        setBusy(false);
        stopRef.current = null;
        if (err) {
          setError(err);
          setMsgs((m) => (m[m.length - 1]?.text ? m : m.slice(0, -1)));
        }
      },
    );
  };

  useEffect(() => {
    if (ask && visible) {
      setView("chat");
      send(ask, []);
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
      setOut(`Не получилось: ${String(e)}`);
    }
  };
  const aiAction = (prompt: string) => {
    if (!src.trim() || toolBusy) return;
    setToolBusy(true);
    setOut("");
    run(
      provider,
      "Ты редактор текста. Верни только результат, без пояснений и кавычек.",
      [{ role: "user", text: `${prompt}\n\n${src}` }],
      (t) => setOut(t),
      (err) => {
        setToolBusy(false);
        if (err) setOut(`Ошибка: ${err}`);
      },
    );
  };

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
          Нужен ключ сервиса ИИ — он хранится только на этом компьютере, зашифрованный Windows.
          <button className="text-btn solid accent" onClick={openSettings}>
            Добавить ключ
          </button>
        </div>
      )}

      {view === "chat" ? (
        <>
          <div className="chat list" ref={listRef}>
            {msgs.length === 0 && <div className="empty">Спроси что угодно. Картинку можно вставить через Ctrl+V.</div>}
            {msgs.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.images?.map((u, k) => <img key={k} src={u} alt="" />)}
                {m.text || (busy && i === msgs.length - 1 ? <span className="dots"><i /><i /><i /></span> : null)}
              </div>
            ))}
            {error && <div className="set-error">{error}</div>}
          </div>
          <div className="chat-input">
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
            {busy ? (
              <button className="send" aria-label="Остановить" onClick={() => (stopRef.current?.(), setBusy(false))}>
                ■
              </button>
            ) : (
              <button className="send" aria-label="Отправить" disabled={!input.trim()} onClick={() => send(input)}>
                ↑
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
                ["JSON", () => local(prettyJson)],
                ["JSON→1", () => local(minJson)],
                ["Base64", () => local(b64enc)],
                ["из Base64", () => local(b64dec)],
                ["URL", () => local(encodeURIComponent)],
                ["из URL", () => local(decodeURIComponent)],
              ] as [string, () => void][]
            ).map(([label, f]) => (
              <button key={label} className="chip" onClick={f}>
                {label}
              </button>
            ))}
            {(
              [
                ["Перевести", "Переведи: с русского на английский, с любого другого языка — на русский."],
                ["Исправить", "Исправь орфографию, пунктуацию и стиль, сохранив смысл и язык."],
                ["Сократить", "Сократи текст вдвое, сохранив главное."],
                ["Объяснить", "Объясни простыми словами, что здесь написано."],
                ["Ответить", "Напиши короткий вежливый ответ на это сообщение, на его языке."],
              ] as [string, string][]
            ).map(([label, prompt]) => (
              <button key={label} className="chip ai" disabled={toolBusy || !hasKey} onClick={() => aiAction(prompt)}>
                ✦ {label}
              </button>
            ))}
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
