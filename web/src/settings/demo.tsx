/**
 * Demo page for the settings dialog and the plugins page. Fake config, real
 * API calls: without a running server the pages show their error states instead
 * of crashing. Open /demo-settings.html (add ?theme=dark for the dark palette).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { ConfigResponse } from "../../../shared/protocol.ts";
import { openSettings } from "../app/ui-store.ts";
import { PluginsPage } from "../plugins/index.tsx";
import { Button } from "../ui/button.tsx";
import { Toasts } from "../ui/toasts.tsx";
import { SettingsModal } from "./index.tsx";
import "../styles/tokens.css";
import "../styles/base.css";
import "./demo.css";

if (new URLSearchParams(window.location.search).get("theme") === "dark") {
  document.documentElement.dataset.theme = "dark";
}

const config: ConfigResponse = {
  defaultCwd: "/home/user/projects/pi-web",
  home: "/home/user",
  version: "0.1.0",
  piVersion: "1.4.0",
  defaultThinkingLevel: "medium",
};

const CWD = "/home/user/projects/pi-web";

function Demo() {
  return (
    <div className="settings-demo">
      <div className="settings-demo-bar">
        <span className="settings-demo-brand">π pi · 设置演示</span>
        <Button onClick={() => openSettings("general")}>打开设置</Button>
      </div>

      <PluginsPage cwd={CWD} />
      <SettingsModal config={config} cwd={CWD} onModelsChanged={() => {}} />
      <Toasts />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
