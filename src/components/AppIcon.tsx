import { useEffect, useState } from "react";
import type { Bridge } from "../ipc";

const cache = new Map<string, Promise<string | null>>();

/** The real icon of a program, site or file; a letter while it loads or if there is none. */
export function AppIcon({
  api,
  kind,
  target,
  name,
  size = 24,
  fallback,
}: {
  api: Bridge | null;
  kind: "app" | "url" | "path";
  target: string;
  name: string;
  size?: number;
  /** Shown instead of a letter until (or unless) the real icon arrives. */
  fallback?: React.ReactNode;
}) {
  const key = `${kind}\u0001${target}`;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!api) return;
    let alive = true;
    if (!cache.has(key)) cache.set(key, api.call<string | null>("icon_get", { kind, target }).catch(() => null));
    cache.get(key)!.then((s) => alive && setSrc(s ?? null));
    return () => {
      alive = false;
    };
  }, [api, key, kind, target]);
  if (src) return <img className="app-icon" src={src} alt="" width={size} height={size} draggable={false} />;
  if (fallback) return <>{fallback}</>;
  return (
    <span className={`app-icon letter k-${kind}`} style={{ width: size, height: size, fontSize: size * 0.46 }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
