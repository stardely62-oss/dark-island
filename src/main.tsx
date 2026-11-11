import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Overlay } from "./overlay/Overlay";
import { SettingsWindow } from "./windows/SettingsWindow";
import { isTauri } from "./ipc";
import "./styles.css";
import "./buddy.css";

// One page, two windows: the island itself, and the full-screen overlay of
// the screen tools (screenshots, OCR, QR, colour picker).
const view = new URLSearchParams(location.search).get("view");
if (view === "settings") document.body.classList.add("settings-page");
if (view !== "overlay" && !isTauri) {
  document.body.classList.add("preview");
  // For trying Клодик's moods in a browser: window.__buddy.react("love")
  import("./components/Buddy").then((m) => ((window as unknown as { __buddy: unknown }).__buddy = m.buddy));
}

createRoot(document.getElementById("root")!).render(<StrictMode>{view === "overlay" ? <Overlay /> : view === "settings" ? <SettingsWindow /> : <App />}</StrictMode>);
