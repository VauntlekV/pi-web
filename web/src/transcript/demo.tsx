/** Demo page for the transcript renderer: `web/demo-transcript.html`. */
import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "../styles/base.css";
import "./demo.css";
import { setPrefs, usePrefs, type Prefs } from "../app/prefs.ts";
import { dock } from "../dock/store.ts";
import { Trajectory } from "../trajectory/index.tsx";
import { Transcript, TurnNav } from "./index.tsx";
import { fixtureCwd, fixtureItems, fixtureStreaming, fixtureTools } from "./fixtures.ts";

type Theme = "system" | "light" | "dark";
type View = "chat" | "trajectory";

const THEMES: Theme[] = ["system", "light", "dark"];
const THEME_LABELS: Record<Theme, string> = { system: "跟随系统", light: "亮色", dark: "暗色" };
const VIEW_LABELS: Record<View, string> = { chat: "对话", trajectory: "轨迹" };
const COLLAPSE_MODES: Prefs["stepCollapse"][] = ["afterAnswer", "always", "never"];
const COLLAPSE_LABELS: Record<Prefs["stepCollapse"], string> = {
  afterAnswer: "回答后收起",
  always: "始终收起",
  never: "从不收起",
};

function initialTheme(): Theme {
  const value = new URLSearchParams(window.location.search).get("theme");
  return value === "light" || value === "dark" ? value : "system";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

// Set before the first paint so `?theme=dark` screenshots never flash light.
const startingTheme = initialTheme();
applyTheme(startingTheme);

function App() {
  const [theme, setTheme] = useState<Theme>(startingTheme);
  const [view, setView] = useState<View>("chat");
  const prefs = usePrefs();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    setScrollRoot(scrollRef.current);
  }, []);

  const cycleTheme = () => setTheme((current) => THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]!);

  // setPrefs also mirrors the theme onto <html>; the demo's own choice wins.
  const pickCollapse = (mode: Prefs["stepCollapse"]) => {
    setPrefs({ stepCollapse: mode });
    applyTheme(theme);
  };

  // The demo stands in for the dock: open the file, and show the call on the page.
  const openPath = useCallback((path: string) => {
    dock.openFile(path);
    setLog((previous) => [`dock.openFile(${JSON.stringify(path)})`, ...previous].slice(0, 8));
  }, []);

  return (
    <>
      <header className="demo-bar">
        <button type="button" className="demo-btn" onClick={cycleTheme} title="循环切换主题">
          主题：{THEME_LABELS[theme]}
        </button>
        <div className="demo-seg" role="group" aria-label="视图">
          {(Object.keys(VIEW_LABELS) as View[]).map((value) => (
            <button
              key={value}
              type="button"
              className="demo-btn"
              aria-pressed={view === value}
              onClick={() => {
                setView(value);
                scrollRef.current?.scrollTo({ top: 0 });
              }}
            >
              {VIEW_LABELS[value]}
            </button>
          ))}
        </div>
        <div className="demo-seg" role="group" aria-label="收起时机">
          {COLLAPSE_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="demo-btn"
              aria-pressed={prefs.stepCollapse === mode}
              onClick={() => pickCollapse(mode)}
            >
              {COLLAPSE_LABELS[mode]}
            </button>
          ))}
        </div>
        <span className="demo-note">步骤展示：{prefs.stepDisplay === "detailed" ? "详细" : "简洁"}</span>
      </header>

      <div className="demo-shell">
        <div className="demo-scroll" ref={scrollRef}>
          <main className="demo-column">
            <div className="demo-label">transcript demo · 对话折叠 / 步骤 / 回合导航 / 轨迹</div>
            {view === "chat" ? (
              <Transcript
                items={fixtureItems}
                streaming={fixtureStreaming}
                tools={fixtureTools}
                running
                cwd={fixtureCwd}
                onOpenPath={openPath}
              />
            ) : (
              <Trajectory items={fixtureItems} streaming={fixtureStreaming} cwd={fixtureCwd} />
            )}
          </main>
        </div>
        {view === "chat" ? <TurnNav items={fixtureItems} scrollRoot={scrollRoot} /> : null}
        {log.length > 0 ? (
          <div className="demo-log" aria-live="polite">
            {log.map((line, index) => (
              <div key={`${line}-${index}`}>{line}</div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
