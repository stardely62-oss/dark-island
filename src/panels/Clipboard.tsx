import { useMemo, useState } from "react";
import type { Bridge, Clip } from "../ipc";
import { PinIcon, TrashIcon } from "../components/Icons";

export function ago(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "сейчас";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} ч`;
  const d = Math.round(h / 24);
  return d < 7 ? `${d} дн` : new Date(at).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/**
 * Clipboard history. A click pastes the entry into the window you were typing
 * in (the island never took its focus); right side: pin and delete.
 */
export function ClipboardTab({
  api,
  clips,
  onUsed,
  onTypeStart,
}: {
  api: Bridge | null;
  clips: Clip[];
  onUsed: () => void;
  onTypeStart: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? clips.filter((c) => c.kind === "text" && c.preview.toLowerCase().includes(q)) : clips;
  }, [clips, query]);

  return (
    <div className="tab-clip">
      <div className="tab-bar">
        <input
          className="search"
          placeholder="Поиск в буфере"
          value={query}
          onFocus={onTypeStart}
          onChange={(e) => setQuery(e.target.value)}
        />
        {clips.some((c) => !c.pinned) && (
          <button className="text-btn" onClick={() => api?.call("clip_clear")}>
            Очистить
          </button>
        )}
      </div>
      <div className="list">
        {shown.length === 0 && (
          <div className="empty">{clips.length ? "Ничего не нашлось" : "Скопируй что-нибудь — оно появится здесь"}</div>
        )}
        {shown.map((c) => (
          <div
            key={c.id}
            className={`clip ${c.pinned ? "pinned" : ""}`}
            title={c.kind === "text" ? "Вставить" : "Вставить картинку"}
            onClick={() => {
              api?.call("clip_use", { id: c.id, paste: true });
              onUsed();
            }}
          >
            {c.kind === "image" ? (
              <div className="clip-image">
                {c.thumb && <img src={c.thumb} alt="" draggable={false} />}
                <span>
                  Картинка {c.w}×{c.h}
                </span>
              </div>
            ) : (
              <div className="clip-text">{c.preview}</div>
            )}
            <span className="meta">{ago(c.at)}</span>
            <span className="actions">
              <button
                className={c.pinned ? "on" : ""}
                aria-label={c.pinned ? "Открепить" : "Закрепить"}
                onClick={(e) => {
                  e.stopPropagation();
                  api?.call("clip_pin", { id: c.id });
                }}
              >
                <PinIcon />
              </button>
              <button
                aria-label="Удалить"
                onClick={(e) => {
                  e.stopPropagation();
                  api?.call("clip_delete", { id: c.id });
                }}
              >
                <TrashIcon />
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
