import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/motion.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { applyDocumentPrefs } from "./app/prefs.ts";
import { App } from "./App.tsx";

// Theme and conversation font size before the first paint, to avoid a flash.
applyDocumentPrefs();

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
