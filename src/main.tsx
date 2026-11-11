import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isTauri } from "./ipc";
import "./styles.css";

if (!isTauri) document.body.classList.add("preview");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
