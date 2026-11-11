import { useEffect, useMemo, useState } from "react";
import type { Bridge } from "../ipc";
import type { Shortcut } from "../settings";
import { AppIcon } from "../components/AppIcon";

type App = { Name: string; AppID: string };

/**
 * A row of shortcuts on Home: programs (Store ones too), sites, folders.
 * "+" adds one; right click removes it.
 */
export function Launcher({
  api,
  items,
  setItems,
  onTypeStart,
}: {
  api: Bridge | null;
  items: Shortcut[];
  setItems: (s: Shortcut[]) => void;
  onTypeStart: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [apps, setApps] = useState<App[]>([]);
  useEffect(() => {
    if (adding) api?.call<App[]>("apps_list").then((a) => setApps(a ?? []));
  }, [adding, api]);

  const found = useMemo(() => {
    const f = q.trim().toLowerCase();
    if (!f) return [];
    return apps.filter((a) => a.Name.toLowerCase().includes(f)).slice(0, 4);
  }, [q, apps]);

  const add = (s: Shortcut) => {
    setItems([...items.filter((i) => i.target !== s.target), s]);
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

  if (adding) {
    return (
      <div className="launcher adding">
        <input
          className="search"
          autoFocus
          placeholder="Программа, сайт или папка"
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

  return (
    <div className="launcher">
      {items.map((s) => (
        <button
          key={s.target}
          className="launch-item"
          title={`${s.name}\nПравый клик — убрать`}
          onClick={() => launch(s)}
          onContextMenu={(e) => {
            e.preventDefault();
            setItems(items.filter((i) => i !== s));
          }}
        >
          <AppIcon api={api} kind={s.kind} target={s.target} name={s.name} size={22} />
          <span className="launch-name">{s.name}</span>
        </button>
      ))}
      <button className="launch-item add" title="Добавить ярлык" onClick={() => setAdding(true)}>
        <span className="launch-icon">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </span>
        {!items.length && <span className="launch-name">Добавить ярлык</span>}
      </button>
    </div>
  );
}
