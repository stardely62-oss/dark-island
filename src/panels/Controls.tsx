import { useEffect, useRef, useState } from "react";
import type { Bridge } from "../ipc";

type Controls = { wifi: boolean | null; ssid: string | null; bluetooth: boolean | null; dark: boolean };

const line = (body: React.ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {body}
  </svg>
);
const WIFI = line(<><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.3a9.5 9.5 0 0 1 13 0M8.6 15.5a5 5 0 0 1 6.8 0" /><circle cx="12" cy="19" r="1" fill="currentColor" /></>);
const BT = line(<path d="m7 7 10 10-5 4.5V2.5L17 7 7 17" />);
const MOON = line(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />);
const LOCK = line(<><rect x="5" y="11" width="14" height="9.5" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
const SLEEP = line(<path d="M14 4h6l-6 7h6M4 12h5l-5 6h5" />);
const RESTART = line(<><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4.5h-4.5" /></>);
const MIC = line(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></>);
const SHIELD = line(<><path d="M12 3 5 6v5.5c0 4.3 3 7.8 7 9.5 4-1.7 7-5.2 7-9.5V6Z" /><path d="m9 12 2.2 2.2L15.5 10" /></>);
const THROUGH = line(<><path d="M5 4.5 11 19l2.2-6.2L19.5 10.6Z" /><path d="m13.5 13.5 5 5" /></>);
const POWER = line(<><path d="M12 3v8.5" /><path d="M6.5 6.8a7.5 7.5 0 1 0 11 0" /></>);

/** Wi-Fi, Bluetooth and the dark theme in one press; lock, sleep, restart, shut down. */
const TOOLS: [string, string, React.ReactNode][] = [
  ["area", "Снимок области", line(<><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /></>)],
  ["full", "Снимок экрана", line(<><rect x="3" y="4.5" width="18" height="12.5" rx="1.5" /><path d="M9 20.5h6" /></>)],
  ["record", "Запись экрана", line(<><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.2" fill="currentColor" /></>)],
  ["ocr", "Текст с экрана", line(<><path d="M4 8V5h3M17 5h3v3M20 16v3h-3M7 19H4v-3M9 9h6M12 9v7" /></>)],
  ["qr", "QR-код", line(<><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2v2M20 14v6h-6v-2M17 17h0" /></>)],
  ["color", "Пипетка", line(<><path d="m14.5 6.5 3 3M16 5l3 3-9.5 9.5H6.5v-3Z" /><path d="M6.5 17.5 4 20" /></>)],
  ["voice", "Голос в текст", line(<><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /><path d="M2.5 9v3M21.5 9v3" /></>)],
  ["pomodoro", "Помодоро", line(<><circle cx="12" cy="13.5" r="7" /><path d="M12 10v3.5l2.5 1.5M9.5 3.5h5M12 3.5v3" /></>)],
];

export function ControlsTab({
  api,
  visible,
  lastColor,
  onTool,
  onCopyColor,
  micMuted,
  onMic,
  through,
  onThrough,
  vpnClient,
}: {
  api: Bridge | null;
  visible: boolean;
  lastColor: string | null;
  onTool: (mode: string) => void;
  onCopyColor: (c: string) => void;
  micMuted: boolean;
  onMic: () => void;
  through: boolean;
  onThrough: (v: boolean) => void;
  vpnClient: string;
}) {
  const [c, setC] = useState<Controls | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [btOpen, setBtOpen] = useState(false);
  const armTimer = useRef(0);

  const [vpn, setVpn] = useState<string | null | undefined>(undefined);
  const [vpnErr, setVpnErr] = useState<string | null>(null);
  useEffect(() => {
    if (visible) api?.call<Controls>("controls_get").then(setC);
  }, [api, visible]);
  useEffect(() => {
    if (!visible) return;
    const load = () => api?.call<string | null>("vpn_status").then((v) => setVpn(v ?? null));
    load();
    const id = window.setInterval(load, 3000);
    return () => clearInterval(id);
  }, [api, visible]);
  const toggleVpn = () => {
    const on = !vpn;
    setBusy("vpn");
    setVpnErr(null);
    api
      ?.call("vpn_set", { on })
      .then(() => window.setTimeout(() => api?.call<string | null>("vpn_status").then((v) => setVpn(v ?? null)), 1500))
      .catch((e) => setVpnErr(String(e)))
      .finally(() => window.setTimeout(() => setBusy(null), 1500));
  };

  const toggle = (what: "wifi" | "bluetooth" | "dark" | "mic", on: boolean) => {
    setBusy(what);
    setC((v) => (v ? { ...v, [what]: on } : v));
    api?.call<Controls>("controls_set", { what, on }).then((v) => {
      setC(v);
      setBusy(null);
    });
  };

  // Restart and shut down ask for a second press.
  const power = (action: string, confirm: boolean) => {
    if (confirm && armed !== action) {
      setArmed(action);
      clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmed(null), 3000);
      return;
    }
    setArmed(null);
    api?.call("power", { action });
  };

  const tile = (what: "wifi" | "bluetooth" | "dark" | "mic" | "vpn" | "through", icon: React.ReactNode, title: string, on: boolean | null | undefined, sub: string) => (
    <button
      className={`ctl-tile ${on ? "on" : ""} ${busy === what ? "busy" : ""}`}
      disabled={on === null || on === undefined}
      title={what === "vpn" && vpnErr ? vpnErr : `${title}: ${sub}`}
      onClick={() =>
        what === "mic" ? onMic() : what === "vpn" ? toggleVpn() : what === "through" ? onThrough(!through) : toggle(what, !on)
      }
    >
      <span className="ctl-icon">{icon}</span>
      <span className="ctl-text">
        <span className="ctl-title">{title}</span>
        <span className="ctl-sub">{sub}</span>
      </span>
    </button>
  );

  return (
    <div className="tab-controls">
      <div className="ctl-grid">
        {tile("wifi", WIFI, "Wi-Fi", c?.wifi, c?.wifi === null ? "нет адаптера" : c?.wifi ? c?.ssid || "включён" : "выключен")}
        <div className="tile-wrap">
          {tile("bluetooth", BT, "Bluetooth", c?.bluetooth, c?.bluetooth === null ? "нет адаптера" : c?.bluetooth ? "включён" : "выключен")}
          {c?.bluetooth && (
            <button className={`tile-more ${btOpen ? "on" : ""}`} title="Устройства" onClick={() => setBtOpen(!btOpen)}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                <path d="m4 2.5 3.5 3.5L4 9.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
        {tile(
          "vpn",
          SHIELD,
          "VPN",
          vpn === undefined ? false : !!vpn,
          vpnErr ? "не вышло" : vpn ? vpn : vpnClient === "warp" ? "WARP выключен" : "выключен",
        )}
        {tile("dark", MOON, "Тема", c?.dark ?? false, c?.dark ? "тёмная" : "светлая")}
        {tile("mic", MIC, "Микрофон", !micMuted, micMuted ? "выключен" : "включён")}
        {tile("through", THROUGH, "Сквозной", through, through ? "клики насквозь" : "выключен")}
      </div>
      {btOpen ? (
        <BtDevices api={api} />
      ) : (
      <div className="tools-row">
        {TOOLS.map(([id, label, icon]) => (
          <button key={id} className="tool-btn" onClick={() => onTool(id)}>
            {icon}
            <span>{label}</span>
            {id === "color" && lastColor && (
              <i
                className="last-color"
                title={`${lastColor} — скопировать`}
                style={{ background: lastColor }}
                onClick={(e) => {
                  e.stopPropagation();
                  onCopyColor(lastColor);
                }}
              />
            )}
          </button>
        ))}
      </div>
      )}
      {!btOpen && <div className="power-row">
        {[
          ["lock", LOCK, "Блокировка", false],
          ["sleep", SLEEP, "Сон", false],
          ["restart", RESTART, "Перезагрузка", true],
          ["shutdown", POWER, "Выключение", true],
        ].map(([id, icon, label, confirm]) => (
          <button
            key={id as string}
            className={`power-btn ${armed === id ? "armed" : ""}`}
            onClick={() => power(id as string, confirm as boolean)}
          >
            {icon as React.ReactNode}
            <span>{armed === id ? "Ещё раз" : (label as string)}</span>
          </button>
        ))}
      </div>}
    </div>
  );
}

type Bt = { id: string; name: string; connected: boolean; battery: number | null; audio: boolean; container: string };

/** Paired Bluetooth devices with their charge; headphones and speakers connect in one press. */
function BtDevices({ api }: { api: Bridge | null }) {
  const [list, setList] = useState<Bt[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api?.call<Bt[]>("bt_devices").then((l) => setList(l ?? []));
  useEffect(() => {
    load();
    const id = window.setInterval(load, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  const toggle = (d: Bt) => {
    setBusy(d.container);
    setErr(null);
    api
      ?.call("bt_connect", { container: d.container, on: !d.connected })
      .then(() => window.setTimeout(load, 2500))
      .catch((e) => setErr(String(e)))
      .finally(() => window.setTimeout(() => setBusy(null), 2500));
  };
  return (
    <div className="bt-list">
      {list === null && <div className="hint-line">Ищу устройства…</div>}
      {list?.length === 0 && <div className="hint-line">Нет сопряжённых устройств</div>}
      {list?.map((d) => (
        <div key={d.container} className={`bt-row ${d.connected ? "on" : ""}`}>
          <span className="bt-dot" />
          <span className="bt-name">{d.name}</span>
          {d.battery !== null && <span className="bt-battery">{d.battery}%</span>}
          {d.audio && (
            <button className="text-btn solid" disabled={busy === d.container} onClick={() => toggle(d)}>
              {busy === d.container ? "…" : d.connected ? "Отключить" : "Подключить"}
            </button>
          )}
        </div>
      ))}
      {err && <div className="set-error">{err}</div>}
      <button className="text-btn" onClick={() => api?.call("open_windows_settings", { page: "bluetooth" })}>
        Параметры Bluetooth
      </button>
    </div>
  );
}
