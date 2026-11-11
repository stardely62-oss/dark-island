import { useRef } from "react";
import type { Bridge, ShelfItem } from "../ipc";
import { CloseIcon, FileIcon, FolderIcon, TabShelf } from "../components/Icons";
import { AppIcon } from "../components/AppIcon";

let dragIcon: string | null = null;
/** The picture under the cursor while files are dragged out (PNG data URL). */
function getDragIcon() {
  if (dragIcon) return dragIcon;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#e9ebf2";
  g.beginPath();
  g.roundRect(14, 6, 36, 50, 6);
  g.fill();
  g.fillStyle = "#d97757";
  g.fillRect(20, 34, 24, 10);
  dragIcon = c.toDataURL("image/png");
  return dragIcon;
}

function ext(name: string) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1) : "";
}

function size(b: number) {
  if (!b) return "";
  const u = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

/**
 * Files dropped on the island wait here until they are dragged into another
 * window — one by one, or all at once from the handle.
 */
export function ShelfTab({
  api,
  items,
  setItems,
  dragOver,
}: {
  api: Bridge | null;
  items: ShelfItem[];
  setItems: (i: ShelfItem[]) => void;
  dragOver: boolean;
}) {
  const press = useRef<{ x: number; y: number; paths: string[] } | null>(null);

  const down = (e: React.PointerEvent, paths: string[]) => {
    press.current = { x: e.clientX, y: e.clientY, paths };
  };
  const move = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) {
      press.current = null;
      api?.dragOut(p.paths, getDragIcon());
    }
  };
  const up = () => {
    press.current = null;
  };

  return (
    <div className="tab-shelf" onPointerMove={move} onPointerUp={up} onPointerLeave={up}>
      <div className="tab-bar">
        {items.length > 0 ? (
          <>
            <span
              className="drag-all"
              title="Потяни, чтобы перенести все файлы"
              onPointerDown={(e) => down(e, items.map((i) => i.path))}
            >
              <TabShelf size={15} /> {items.length} {plural(items.length)} — потяни, чтобы перенести все
            </span>
            <span className="grow" />
            <button className="text-btn" onClick={() => api?.call<ShelfItem[]>("shelf_clear").then(setItems)}>
              Очистить
            </button>
          </>
        ) : (
          <span className="hint">Брось файлы на остров — они подождут здесь</span>
        )}
      </div>
      <div className={`shelf ${dragOver ? "over" : ""} ${items.length ? "" : "empty-shelf"}`}>
        {items.map((it) => (
          <div
            key={it.path}
            className="tile"
            title={`${it.path}\nДвойной клик — открыть, правый — показать в папке`}
            onPointerDown={(e) => e.button === 0 && down(e, [it.path])}
            onDoubleClick={() => api?.call("open_path", { path: it.path })}
            onContextMenu={(e) => {
              e.preventDefault();
              api?.call("reveal_path", { path: it.path });
            }}
          >
            <AppIcon
              api={api}
              kind="path"
              target={it.path}
              name={it.name}
              size={32}
              fallback={it.dir ? <FolderIcon /> : <FileIcon ext={ext(it.name) || "file"} />}
            />
            <span className="name">{it.name}</span>
            <span className="size">{it.dir ? "папка" : size(it.size)}</span>
            <button
              className="remove"
              aria-label="Убрать с полки"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => api?.call<ShelfItem[]>("shelf_remove", { path: it.path }).then(setItems)}
            >
              <CloseIcon size={10} />
            </button>
          </div>
        ))}
        {dragOver && <div className="drop-hint">Отпусти — и файлы лягут на полку</div>}
      </div>
    </div>
  );
}

function plural(n: number) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "файл";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "файла";
  return "файлов";
}
