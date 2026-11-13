// The full-screen window of the screen tools. It shows the frozen picture of
// the monitor; you select an area and mark it up, or pick a colour.
// Everything is in physical pixels of the frame; the mouse is converted.

import { useCallback, useEffect, useRef, useState } from "react";
import "./overlay.css";

import { t } from "../i18n";
type Mode = "area" | "full" | "ocr" | "qr" | "color" | "record";
type Tool = "arrow" | "rect" | "marker" | "text" | "blur";
type Pt = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
type Shape =
  | { t: "arrow" | "rect" | "blur"; c: string; a: Pt; b: Pt }
  | { t: "marker"; c: string; pts: Pt[] }
  | { t: "text"; c: string; a: Pt; text: string };

const COLORS = ["#ff4d4f", "#ffc53d", "#52c41a", "#40a9ff", "#ffffff", "#141414"];
const isTauri = "__TAURI_INTERNALS__" in window;
const FRAME_BASE = navigator.userAgent.includes("Windows") ? "http://frame.localhost" : "frame://localhost";

async function call(cmd: string, args?: Record<string, unknown>) {
  if (!isTauri) {
    console.log("overlay call", cmd, args);
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args).catch(() => {});
}

function norm(a: Pt, b: Pt): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

/** A stand-in screen for designing the overlay in a browser. */
function mockFrame(): Promise<HTMLImageElement> {
  const c = document.createElement("canvas");
  c.width = window.innerWidth * devicePixelRatio;
  c.height = window.innerHeight * devicePixelRatio;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, c.width, c.height);
  grad.addColorStop(0, "#b5427f");
  grad.addColorStop(0.55, "#6b3f8f");
  grad.addColorStop(1, "#d97a52");
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#fff";
  g.fillRect(c.width * 0.18, c.height * 0.2, c.width * 0.42, c.height * 0.5);
  g.fillStyle = "#222";
  g.font = `${28 * devicePixelRatio}px Segoe UI, sans-serif`;
  [t("Отчёт за ноябрь"), t("Выручка выросла на 12%"), t("Пароль: hunter2")].forEach((t, i) =>
    g.fillText(t, c.width * 0.21, c.height * 0.3 + i * 48 * devicePixelRatio),
  );
  const img = new Image();
  img.src = c.toDataURL();
  return img.decode().then(() => img);
}

export function Overlay() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [sel, setSel] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<Pt | null>(null);
  const [phase, setPhase] = useState<"select" | "edit" | "color">("select");
  const [tool, setTool] = useState<Tool>("arrow");
  const [color, setColor] = useState(COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [typing, setTyping] = useState<{ at: Pt; text: string } | null>(null);
  const [mouse, setMouse] = useState<Pt>({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pixels = useRef<ImageData | null>(null);
  const dpr = window.devicePixelRatio || 1;

  const reset = useCallback(() => {
    setSel(null);
    setDrag(null);
    setShapes([]);
    setDraft(null);
    setTyping(null);
    setBusy(false);
  }, []);

  const begin = useCallback(
    (m: Mode, image: HTMLImageElement) => {
      reset();
      setMode(m);
      setImg(image);
      const off = document.createElement("canvas");
      off.width = image.naturalWidth;
      off.height = image.naturalHeight;
      const g = off.getContext("2d", { willReadFrequently: true })!;
      g.drawImage(image, 0, 0);
      pixels.current = m === "color" ? g.getImageData(0, 0, off.width, off.height) : null;
      if (m === "full") {
        setSel({ x: 0, y: 0, w: image.naturalWidth, h: image.naturalHeight });
        setPhase("edit");
      } else {
        setPhase(m === "color" ? "color" : "select");
      }
      requestAnimationFrame(() => call("overlay_ready"));
    },
    [reset],
  );

  useEffect(() => {
    if (!isTauri) {
      const m = (new URLSearchParams(location.search).get("mock") ?? "area") as Mode;
      mockFrame().then((i) => begin(m, i));
      return;
    }
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ mode: Mode; id: number }>("overlay_start", (e) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.src = `${FRAME_BASE}/shot.png?id=${e.payload.id}`;
        image.decode().then(() => begin(e.payload.mode, image), () => call("overlay_cancel"));
      }).then((u) => (un = u)),
    );
    return () => un?.();
  }, [begin]);

  const cancel = useCallback(() => {
    reset();
    setImg(null);
    call("overlay_cancel");
  }, [reset]);

  // ---- drawing --------------------------------------------------------------

  const drawShape = (g: CanvasRenderingContext2D, s: Shape, src: HTMLImageElement, k: number) => {
    g.save();
    g.strokeStyle = g.fillStyle = s.c;
    g.lineCap = g.lineJoin = "round";
    if (s.t === "blur") {
      const r = norm(s.a, s.b);
      if (r.w > 2 && r.h > 2) {
        // Pixelate: much safer for passwords than a soft blur.
        const block = Math.max(8, Math.round(10 * k));
        const sw = Math.max(1, Math.round(r.w / block));
        const sh = Math.max(1, Math.round(r.h / block));
        const tmp = document.createElement("canvas");
        tmp.width = sw;
        tmp.height = sh;
        tmp.getContext("2d")!.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
        g.imageSmoothingEnabled = false;
        g.drawImage(tmp, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
      }
    } else if (s.t === "rect") {
      const r = norm(s.a, s.b);
      g.lineWidth = 4 * k;
      g.beginPath();
      g.roundRect(r.x, r.y, r.w, r.h, 6 * k);
      g.stroke();
    } else if (s.t === "arrow") {
      const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
      if (len > 2) {
        const ang = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
        const head = Math.min(26 * k, len * 0.5);
        g.lineWidth = 5 * k;
        g.beginPath();
        g.moveTo(s.a.x, s.a.y);
        g.lineTo(s.b.x - Math.cos(ang) * head * 0.6, s.b.y - Math.sin(ang) * head * 0.6);
        g.stroke();
        g.beginPath();
        g.moveTo(s.b.x, s.b.y);
        g.lineTo(s.b.x - Math.cos(ang - 0.45) * head, s.b.y - Math.sin(ang - 0.45) * head);
        g.lineTo(s.b.x - Math.cos(ang + 0.45) * head, s.b.y - Math.sin(ang + 0.45) * head);
        g.closePath();
        g.fill();
      }
    } else if (s.t === "marker") {
      g.globalAlpha = 0.4;
      g.lineWidth = 18 * k;
      g.beginPath();
      s.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
    } else if (s.t === "text") {
      g.font = `600 ${24 * k}px "Segoe UI", sans-serif`;
      g.textBaseline = "top";
      g.lineWidth = 4 * k;
      g.strokeStyle = s.c === "#141414" ? "#fff" : "rgba(0,0,0,.65)";
      s.text.split("\n").forEach((line, i) => {
        g.strokeText(line, s.a.x, s.a.y + i * 30 * k);
        g.fillText(line, s.a.x, s.a.y + i * 30 * k);
      });
    }
    g.restore();
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    if (phase === "color") return;
    const r = sel ?? (drag ? norm(drag, mouse) : null);
    g.fillStyle = "rgba(0,0,0,.45)";
    g.fillRect(0, 0, c.width, c.height);
    if (r && r.w > 0 && r.h > 0) {
      g.drawImage(img, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      g.save();
      g.beginPath();
      g.rect(r.x, r.y, r.w, r.h);
      g.clip();
      [...shapes, ...(draft ? [draft] : [])].forEach((s) => drawShape(g, s, img, dpr));
      g.restore();
      g.strokeStyle = "rgba(255,255,255,.9)";
      g.lineWidth = 1.5 * dpr;
      g.setLineDash([6 * dpr, 4 * dpr]);
      g.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
    }
  });

  // ---- result -----------------------------------------------------------------

  const exportSel = useCallback(() => {
    if (!img || !sel) return null;
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sel.w));
    out.height = Math.max(1, Math.round(sel.h));
    const g = out.getContext("2d")!;
    g.drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h);
    g.translate(-sel.x, -sel.y);
    shapes.forEach((s) => drawShape(g, s, img, dpr));
    return out.toDataURL("image/png");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, sel, shapes, dpr]);

  const finish = useCallback(
    (action: "copy" | "save" | "ocr" | "qr" | "upload", rect?: Rect) => {
      const r = rect ?? sel;
      if (!img || !r || busy) return;
      setBusy(true);
      let png: string | null;
      if (rect) {
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(r.w));
        out.height = Math.max(1, Math.round(r.h));
        out.getContext("2d")!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        png = out.toDataURL("image/png");
      } else {
        png = exportSel();
      }
      reset();
      setImg(null);
      call("capture_done", { png, action });
    },
    [img, sel, busy, exportSel, reset],
  );

  // ---- input ------------------------------------------------------------------

  const toFrame = (e: React.PointerEvent | React.MouseEvent): Pt => ({ x: e.clientX * dpr, y: e.clientY * dpr });

  const commitText = useCallback(() => {
    if (typing && typing.text.trim()) setShapes((s) => [...s, { t: "text", c: color, a: typing.at, text: typing.text }]);
    setTyping(null);
  }, [typing, color]);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !img) return;
    const p = toFrame(e);
    if (phase === "color") return;
    if (phase === "select") {
      setDrag(p);
      setMouse(p);
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (typing) {
      commitText();
      return;
    }
    if (tool === "text") {
      setTyping({ at: p, text: "" });
      return;
    }
    setDraft(tool === "marker" ? { t: "marker", c: color, pts: [p] } : { t: tool, c: color, a: p, b: p });
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent) => {
    const p = toFrame(e);
    setMouse(p);
    if (draft) {
      if (draft.t === "marker") setDraft({ ...draft, pts: [...draft.pts, p] });
      else if (draft.t !== "text") setDraft({ ...draft, b: p });
    }
  };

  const onUp = () => {
    if (phase === "select" && drag) {
      const r = norm(drag, mouse);
      setDrag(null);
      if (mode === "record" && img) {
        // A click records the whole screen.
        const area = r.w < 4 || r.h < 4 ? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight } : r;
        reset();
        setImg(null);
        call("record_start", { x: Math.round(area.x), y: Math.round(area.y), w: Math.round(area.w), h: Math.round(area.h) });
        return;
      }
      if (r.w < 4 || r.h < 4) {
        // A click selects the whole screen.
        if (mode === "area" && img) {
          setSel({ x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight });
          setPhase("edit");
        }
        return;
      }
      if (mode === "ocr" || mode === "qr") {
        finish(mode, r);
        return;
      }
      setSel(r);
      setPhase("edit");
      return;
    }
    if (draft) {
      setShapes((s) => [...s, draft]);
      setDraft(null);
    }
  };

  const pick = useCallback(
    (p: Pt) => {
      const d = pixels.current;
      if (!d) return null;
      const x = Math.max(0, Math.min(d.width - 1, Math.round(p.x)));
      const y = Math.max(0, Math.min(d.height - 1, Math.round(p.y)));
      const i = (y * d.width + x) * 4;
      return hex(d.data[i], d.data[i + 1], d.data[i + 2]);
    },
    [],
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (typing || (e.target as HTMLElement | null)?.tagName === "TEXTAREA") return;
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (phase === "edit" && (e.key === "Enter" || (e.ctrlKey && e.code === "KeyC"))) {
        e.preventDefault();
        finish("copy");
      } else if (phase === "edit" && e.ctrlKey && e.code === "KeyS") {
        e.preventDefault();
        finish("save");
      } else if (phase === "edit" && e.ctrlKey && e.code === "KeyZ") {
        e.preventDefault();
        setShapes((s) => s.slice(0, -1));
      } else if (phase === "color" && e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]!;
        setMouse((m) => ({ x: m.x + d[0], y: m.y + d[1] }));
      } else if (phase === "color" && e.key === "Enter") {
        const c = pick(mouse);
        if (c) {
          setImg(null);
          call("color_done", { hex: c });
        }
      } else if (phase === "edit" && !e.ctrlKey) {
        const k = { "1": "arrow", "2": "rect", "3": "marker", "4": "text", "5": "blur" }[e.key] as Tool | undefined;
        if (k) setTool(k);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [typing, phase, cancel, finish, pick, mouse]);

  if (!img || !mode) return <div className="ov-root" />;

  const cssSel = sel ? { left: sel.x / dpr, top: sel.y / dpr, width: sel.w / dpr, height: sel.h / dpr } : null;
  // The toolbar sits under the selection, or inside it when there is no room.
  const barTop = cssSel ? (cssSel.top + cssSel.height + 56 < window.innerHeight ? cssSel.top + cssSel.height + 10 : Math.max(10, cssSel.top + cssSel.height - 56)) : 0;
  const barLeft = cssSel ? Math.min(Math.max(10, cssSel.left + cssSel.width / 2), window.innerWidth - 10) : 0;

  return (
    <div className="ov-root">
      <canvas
        ref={canvas}
        className={`ov-canvas ${phase === "color" ? "picker" : phase === "edit" ? `tool-${tool}` : ""}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onClick={(e) => {
          if (phase !== "color") return;
          const c = pick(toFrame(e));
          if (c) {
            setImg(null);
            call("color_done", { hex: c });
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          cancel();
        }}
      />

      {phase === "select" && (
        <div className="ov-hint">
          {mode === "ocr"
            ? t("Выдели текст")
            : mode === "qr"
              ? t("Выдели QR-код")
              : mode === "record"
                ? t("Запись экрана: выдели область · клик — весь экран")
                : t("Выдели область · клик — весь экран")}{" "}
          {t("· Esc — отмена")}</div>
      )}
      {phase === "select" && drag && (
        <div className="ov-size" style={{ left: mouse.x / dpr + 14, top: mouse.y / dpr + 14 }}>
          {Math.round(norm(drag, mouse).w)} × {Math.round(norm(drag, mouse).h)}
        </div>
      )}

      {phase === "color" && <Magnifier img={img} at={mouse} pick={pick} dpr={dpr} />}

      {typing && (
        <textarea
          className="ov-text"
          autoFocus
          style={{ left: typing.at.x / dpr, top: typing.at.y / dpr, color }}
          value={typing.text}
          onChange={(e) => setTyping({ ...typing, text: e.target.value })}
          onKeyDown={(e) => {
            // Keys typed into a label never reach the overlay's shortcuts.
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commitText();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setTyping(null);
            }
          }}
        />
      )}

      {phase === "edit" && cssSel && (
        <div className="ov-bar" style={{ top: barTop, left: barLeft }} onPointerDown={(e) => e.stopPropagation()}>
          {(
            [
              ["arrow", t("Стрелка (1)"), <path key="a" d="M5 19 19 5M10 5h9v9" />],
              ["rect", t("Рамка (2)"), <rect key="r" x="4" y="6" width="16" height="12" rx="2" />],
              ["marker", t("Маркер (3)"), <path key="m" d="m14 4 6 6-9 9H5v-6Z" />],
              ["text", t("Текст (4)"), <path key="t" d="M5 6V4h14v2M12 4v16M9 20h6" />],
              ["blur", t("Скрыть (5)"), <path key="b" d="M4 4h5v5H4zM15 4h5v5h-5zM9.5 9.5h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5z" />],
            ] as [Tool, string, React.ReactNode][]
          ).map(([id, label, icon]) => (
            <button key={id} className={tool === id ? "on" : ""} title={label} onClick={() => setTool(id)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {icon}
              </svg>
            </button>
          ))}
          <span className="ov-sep" />
          {COLORS.map((c) => (
            <button key={c} className={`swatch ${color === c ? "on" : ""}`} style={{ background: c }} title={c} onClick={() => setColor(c)} />
          ))}
          <span className="ov-sep" />
          <button title={t("Отменить (Ctrl+Z)")} disabled={!shapes.length} onClick={() => setShapes((s) => s.slice(0, -1))}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
          </button>
          <button className="txt" title={t("Распознать текст")} onClick={() => finish("ocr")}>
            {t("Текст")}</button>
          <button className="txt" title={t("Прочитать QR-код")} onClick={() => finish("qr")}>
            QR
          </button>
          <button className="txt" title={t("Загрузить и скопировать ссылку")} onClick={() => finish("upload")}>
            {t("Ссылка")}</button>
          <button className="txt" title={t("Сохранить (Ctrl+S)")} onClick={() => finish("save")}>
            {t("Сохранить")}</button>
          <button className="txt main" title={t("Копировать (Enter)")} onClick={() => finish("copy")}>
            {t("Копировать")}</button>
          <button title={t("Закрыть (Esc)")} onClick={cancel}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The loupe sits right on the cursor: the pixel in its centre, framed, is
 * exactly the one a click takes. 17×17 pixels at 8×, the colour below.
 */
function Magnifier({ img, at, pick, dpr }: { img: HTMLImageElement; at: Pt; pick: (p: Pt) => string | null; dpr: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const N = 17;
  const Z = 8;
  const half = (N - 1) / 2;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = c.height = N * Z;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    g.fillStyle = "#000";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, Math.round(at.x) - half, Math.round(at.y) - half, N, N, 0, 0, N * Z, N * Z);
    g.strokeStyle = "rgba(255,255,255,.12)";
    g.lineWidth = 1;
    for (let i = 1; i < N; i++) {
      g.beginPath();
      g.moveTo(i * Z + 0.5, 0);
      g.lineTo(i * Z + 0.5, N * Z);
      g.moveTo(0, i * Z + 0.5);
      g.lineTo(N * Z, i * Z + 0.5);
      g.stroke();
    }
    // The pixel that will be taken: a black and a white frame, visible on any colour.
    const o = half * Z;
    g.lineWidth = 3;
    g.strokeStyle = "#000";
    g.strokeRect(o - 1, o - 1, Z + 2, Z + 2);
    g.lineWidth = 1.5;
    g.strokeStyle = "#fff";
    g.strokeRect(o - 0.5, o - 0.5, Z + 1, Z + 1);
  }, [img, at, half]);
  const c = pick(at);
  const x = at.x / dpr;
  const y = at.y / dpr;
  const size = N * Z;
  // Label under the loupe, or above it near the bottom edge of the screen.
  const below = y + size / 2 + 40 < window.innerHeight;
  return (
    <>
      <div className="ov-loupe" style={{ left: x - size / 2, top: y - size / 2, width: size, height: size }}>
        <canvas ref={ref} />
      </div>
      <div className="ov-loupe-hex" style={{ left: x, top: below ? y + size / 2 + 8 : y - size / 2 - 34 }}>
        <span style={{ background: c ?? "#000" }} />
        {c} {" "}{t("· клик — копировать · Esc — отмена")}</div>
    </>
  );
}
