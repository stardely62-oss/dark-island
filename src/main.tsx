import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Overlay } from "./overlay/Overlay";
import { isTauri } from "./ipc";
import "./styles.css";

// One page, two windows: the island itself, and the full-screen overlay of
// the screen tools (screenshots, OCR, QR, colour picker).
const view = new URLSearchParams(location.search).get("view");
if (view !== "overlay" && !isTauri) document.body.classList.add("preview");

createRoot(document.getElementById("root")!).render(<StrictMode>{view === "overlay" ? <Overlay /> : <App />}</StrictMode>);
