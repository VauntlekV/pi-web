/**
 * Demo page for the right dock: `web/demo-dock.html?cwd=/some/workspace`.
 * Needs a running pi-web server for the file and git routes (the Vite proxy
 * forwards /api); a missing route renders the error state instead of crashing.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import "./demo.css";
import { RightDock } from "./index.tsx";
import { dock } from "./store.ts";

const params = new URLSearchParams(window.location.search);
if (params.get("theme") === "dark") document.documentElement.dataset.theme = "dark";
dock.setCwd(params.get("cwd"));
dock.open();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="dock-demo">
      <RightDock sessionId={null} />
    </div>
  </StrictMode>,
);
