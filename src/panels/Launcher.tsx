import { useEffect, useMemo, useRef, useState } from "react";
import type { Bridge } from "../ipc";
import type { Shortcut } from "../settings";
import { AppIcon } from "../components/AppIcon";
import { hopTo } from "../components/Buddy";

type App = { Name: string; AppID: string };

/** All shortcuts, groups opened up. */
const flat = (items: Shortcut[]): Shortcut[] => items.flatMap((s) => (s.kind === "group" ? s.items ?? [] : [s]));

/** Registers the per-shortcut hotkeys; returns the ones Windows refused. */
export function useLauncherHotkeys(api: Bridge | null, items: Shortcut[]) {
  const [failed, setFailed] = useState<string[]>([]);
  const keys = useMemo(
    () => flat(items).filter((s) => s.hotkey).map((s) => ({ hotkey: s.hotkey!, kind: s.kind, target: s.target })),
    [items],
  );
  const sig = JSON.stringify(keys);
  useEffect(() => {
    api?.call<string[]>("launcher_hotkeys", { keys }).then((f) => setFailed(f ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, sig]);
  return failed;
}

/** "Ctrl+Alt+KeyG" → "Ctrl+Alt+G". */
export const keyLabel = (k: string) => k.replace(/\bKey([A-Z])\b/g, "$1").replace(/\bDigit(\d)\b/g, "$1");

export function comboOf(e: React.KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
  // A bare key would fire while typing anywhere: at least one modifier, F-keys aside.
  if (!mods.length && !/^F\d+$/.test(e.code)) return null;
  return [...mods, e.code].join("+");
}

function ShortcutIcon({ api, s, size }: { api: Bridge | null; s: Shortcut; size: number }) {
  if (s.kind !== "group") return <AppIcon api={api} kind={s.kind} target={s.target} name={s.name} size={size} />;
  const inner = (s.items ?? []).slice(0, 4);
  return (
    <span className="app-icon group-icon" style={{ width: size, height: size }}>
      {inner.map((i) => (
        <AppIcon key={i.target} api={api} kind={i.kind as "app"} target={i.target} name={i.name} size={size / 2 - 1} />
      ))}
    </span>
  );
}

/**
 * A row of shortcuts on Home: programs (Store ones too), sites, folders.
 * "+" adds one; drag one onto another to make a group; right click for
 * a hotkey or to remove it.
 */
export function Launcher({
  api,
  items,
  setItems,
  failed = [],
  onTypeStart,
}: {
  api: Bridge | null;
  items: Shortcut[];
  setItems: (s: Shortcut[]) => void;
  failed?: string[];
  onTypeStart: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [apps, setApps] = useState<App[]>([]);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [menu, setMenu] = useState<Shortcut | null>(null);
  const [recording, setRecording] = useState(false);
  const [drag, setDrag] = useState<{ s: Shortcut; x: number; y: number; over: string | null } | null>(null);
  const press = useRef<{ s: Shortcut; x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (adding) api?.call<App[]>("apps_list").then((a) => setApps(a ?? []));
  }, [adding, api]);

  const found = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return [];
    return apps.filter((a) => a.Name.toLowerCase().includes(f)).slice(0, 4);
  }, [q, apps]);

  // Only as many as fit across the island: icons are 42px with 6px between.
  const [cap, setCap] = useState(9);
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCap(Math.max(3, Math.floor((el.clientWidth + 6) / 48))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [adding, menu]);
  const group = openGroup ? items.find((i) => i.target === openGroup && i.kind === "group") ?? null : null;
  // Shortcuts from before the limit are not lost: past the last place, a
  // "+N" opens the rest like a group.
  const MORE = "__more";
  const all = openGroup === MORE ? items.slice(cap - 1) : group ? group.items ?? [] : items;
  const inside = !!group || openGroup === MORE;
  const places = cap - (inside ? 1 : 0);
  const overflow = all.length > places;
  const shown = overflow ? all.slice(0, places - 1) : all;
  const hidden = overflow ? all.length - shown.length : 0;
  // The "+" takes a place too (and "back" inside a group).
  const roomForMore = !overflow && openGroup !== MORE && all.length < places;

  /** Replaces one shortcut wherever it is (top level or inside a group). */
  const update = (target: string, f: (s: Shortcut) => Shortcut | null): Shortcut[] =>
    items
      .map((s) => {
        if (s.target === target) return f(s);
        if (s.kind !== "group") return s;
        const inner = (s.items ?? []).map((i) => (i.target === target ? f(i) : i)).filter(Boolean) as Shortcut[];
        return { ...s, items: inner };
      })
      .filter(Boolean)
      // A group of one is just that shortcut again.
      .map((s) => (s!.kind === "group" && (s!.items ?? []).length === 1 ? s!.items![0] : s))
      .filter((s) => s!.kind !== "group" || (s!.items ?? []).length > 0) as Shortcut[];

  const add = (s: Shortcut) => {
    if (group) setItems(update(group.target, (g) => ({ ...g, items: [...(g.items ?? []).filter((i) => i.target !== s.target), s] })));
    else setItems([...items.filter((i) => i.target !== s.target), s]);
    setAdding(false);
    setQ("");
  };
  const link = q.trim();
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(link) || /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(link);
  const isPath = /^[a-z]:\\/i.test(link) || link.startsWith("\\\\");

  const launch = (s: Shortcut) => {
    if (s.kind === "app") api?.call("app_launch", { id: s.target });
    else if (s.kind === "url") api?.call("open_url", { url: /^https?:/.test(s.target) ? s.target : `https://${s.target}` });
    else api?.call("open_path", { path: s.target });
  };

  /** Drops `s` onto `onto`: into its group, or both into a new group. */
  const groupUp = (s: Shortcut, onto: Shortcut) => {
    if (s.target === onto.target || s.kind === "group") return;
    const rest = items.filter((i) => i.target !== s.target);
    if (onto.kind === "group") {
      setItems(rest.map((i) => (i.target === onto.target ? { ...i, items: [...(i.items ?? []), s] } : i)));
    } else {
      const g: Shortcut = { name: "Группа", kind: "group", target: `group:${Date.now()}`, items: [onto, s] };
      setItems(rest.map((i) => (i.target === onto.target ? g : i)));
    }
  };

  // ---- dragging, by hand: the window's own drop target takes the HTML kind ----
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      p.moved = true;
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-target]");
      const over = el && el.dataset.target !== p.s.target ? el.dataset.target! : null;
      setDrag({ s: p.s, x: e.clientX, y: e.clientY, over });
    };
    const up = () => {
      const p = press.current;
      press.current = null;
      if (p?.moved) {
        // The click that follows a drag is not a launch.
        dragged.current = true;
        window.setTimeout(() => (dragged.current = false), 0);
        const onto = drag?.over ? items.find((i) => i.target === drag.over) : undefined;
        if (onto) groupUp(p.s, onto);
      }
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  if (adding) {
    return (
      <div className="launcher adding">
        <input
          className="search"
          autoFocus
          placeholder={group ? `В «${group.name}»: программа, сайт или папка` : "Программа, сайт или папка"}
          value={q}
          onFocus={onTypeStart}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
        />
        <div className="launcher-found">
          {found.map((a) => (
            <button key={a.AppID} className="text-btn solid with-icon" onClick={() => add({ name: a.Name, kind: "app", target: a.AppID })}>
              <AppIcon api={api} kind="app" target={a.AppID} name={a.Name} size={16} />
              {a.Name}
            </button>
          ))}
          {(isUrl || isPath) && (
            <button
              className="text-btn solid accent"
              onClick={() =>
                add({
                  name: isPath ? link.split("\\").filter(Boolean).pop() ?? link : link.replace(/^https?:\/\//, "").split("/")[0],
                  kind: isPath ? "path" : "url",
                  target: link,
                })
              }
            >
              Добавить {isPath ? "папку" : "сайт"}
            </button>
          )}
          <button className="text-btn" onClick={() => setAdding(false)}>
            Отмена
          </button>
        </div>
      </div>
    );
  }

  if (menu) {
    const close = () => {
      setMenu(null);
      setRecording(false);
    };
    const inGroup = !!group;
    const bad = menu.hotkey && failed.includes(menu.hotkey);
    return (
      <div className="launcher menu">
        <ShortcutIcon api={api} s={menu} size={22} />
        {menu.kind !== "group" && <span className="menu-name">{menu.name}</span>}
        {menu.kind === "group" ? (
          <input
            className="search launch-rename"
            defaultValue={menu.name}
            onFocus={onTypeStart}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            onBlur={(e) => {
              const name = e.target.value.trim() || "Группа";
              setItems(update(menu.target, (s) => ({ ...s, name })));
            }}
          />
        ) : (
          <button
            className={`text-btn solid hotkey-btn ${recording ? "accent" : ""} ${bad ? "bad" : ""}`}
            title={bad ? "Это сочетание уже занято другой программой" : "Сочетание, которое открывает ярлык откуда угодно"}
            onClick={() => {
              onTypeStart();
              setRecording(true);
            }}
            onKeyDown={(e) => {
              if (!recording) return;
              e.preventDefault();
              if (e.key === "Escape") return setRecording(false);
              if (e.key === "Backspace" || e.key === "Delete") {
                setItems(update(menu.target, (s) => ({ ...s, hotkey: undefined })));
                setMenu({ ...menu, hotkey: undefined });
                return setRecording(false);
              }
              const k = comboOf(e);
              if (!k) return;
              setItems(update(menu.target, (s) => ({ ...s, hotkey: k })));
              setMenu({ ...menu, hotkey: k });
              setRecording(false);
            }}
          >
            {recording ? "Нажми сочетание…" : menu.hotkey ? keyLabel(menu.hotkey) : "Клавиша"}
          </button>
        )}
        {inGroup && (
          <button
            className="text-btn solid"
            onClick={() => {
              const without = update(menu.target, () => null);
              setItems([...without, { ...menu }]);
              close();
            }}
          >
            Вынуть
          </button>
        )}
        <button
          className="text-btn solid danger"
          onClick={() => {
            setItems(update(menu.target, () => null));
            if (menu.target === openGroup) setOpenGroup(null);
            close();
          }}
        >
          Убрать
        </button>
        <button className="text-btn" onClick={close}>
          Готово
        </button>
      </div>
    );
  }

  return (
    <div className={`launcher ${group ? "in-group" : ""}`} ref={row}>
      {inside && (
        <button className="launch-item back" title={group ? `Назад · ${group.name}` : "Назад"} onClick={() => setOpenGroup(null)}>
          <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden>
            <path d="M7 1.5 2.5 6 7 10.5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {shown.map((s) => (
        <button
          key={s.target}
          data-target={group ? undefined : s.target}
          className={`launch-item ${drag?.over === s.target ? "drop-on" : ""} ${drag?.s.target === s.target ? "dragging" : ""}`}
          title={`${s.name}${s.hotkey ? ` · ${keyLabel(s.hotkey)}` : ""}\n${group ? "Правый клик — клавиша, вынуть, убрать" : s.kind === "group" ? "Правый клик — переименовать или убрать" : "Перетащи на другой ярлык — будет группа\nПравый клик — клавиша или убрать"}`}
          onPointerDown={(e) => {
            if (e.button !== 0 || group) return;
            press.current = { s, x: e.clientX, y: e.clientY, moved: false };
            setDrag(null);
          }}
          onClick={(e) => {
            if (dragged.current) return;
            if (s.kind === "group") return setOpenGroup(s.target);
            // Клодик jumps onto the shortcut, then the app starts.
            hopTo(document.querySelector(".tab-buddy .buddy"), e.currentTarget.querySelector(".app-icon"));
            window.setTimeout(() => launch(s), 380);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(s);
          }}
        >
          <ShortcutIcon api={api} s={s} size={26} />
          {s.hotkey && failed.includes(s.hotkey) && <span className="launch-warn" title="Сочетание занято" />}
        </button>
      ))}
      {overflow && openGroup !== MORE && (
        <button className="launch-item more" title={`Ещё ${hidden}`} onClick={() => setOpenGroup(MORE)}>
          +{hidden}
        </button>
      )}
      {roomForMore && (
        <button className={`launch-item add ${items.length ? "" : "wide"}`} title={group ? "Добавить в группу" : "Добавить ярлык"} onClick={() => setAdding(true)}>
          <span className="launch-icon">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          {!items.length && <span className="launch-name">Добавить ярлык</span>}
        </button>
      )}
      {drag && (
        <span
          className="launch-ghost"
          style={{ left: drag.x - (row.current?.getBoundingClientRect().left ?? 0), top: drag.y - (row.current?.getBoundingClientRect().top ?? 0) }}
        >
          <ShortcutIcon api={api} s={drag.s} size={22} />
        </span>
      )}
    </div>
  );
}
