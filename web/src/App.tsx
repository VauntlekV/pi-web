import { Menu as MenuIcon, PanelLeft } from "lucide-react";
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { ConfigResponse, ModelInfo, Workspace } from "../../shared/protocol.ts";
import { api, onUnauthorized } from "./api/client.ts";
import { errorText, isStatus } from "./app/errors.ts";
import { navigate, useRoute } from "./app/router.ts";
import { readStorage, writeStorage } from "./app/storage.ts";
import { DockToggle } from "./app/dock-toggle.tsx";
import { Conversation } from "./conversation/index.tsx";
import { CwdPicker } from "./dialogs/CwdPicker.tsx";
import { RightDock } from "./dock/index.tsx";
import { dock, useDock } from "./dock/store.ts";
import { Home } from "./home/index.tsx";
import { PluginsPage } from "./plugins/index.tsx";
import { SettingsModal } from "./settings/index.tsx";
import { Sidebar } from "./sidebar/index.tsx";
import { Button } from "./ui/button.tsx";
import { Splitter } from "./ui/splitter.tsx";
import { toast, Toasts } from "./ui/toasts.tsx";
import "./app/app.css";

const SIDEBAR_KEY = "pi-web-sidebar";
const CWD_KEY = "pi-web-cwd";
const SIDEBAR_WIDTH_KEY = "pi-web-sidebar-width";
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_MIN = 200;
const sidebarMax = () => Math.max(SIDEBAR_MIN, Math.min(480, Math.round(window.innerWidth * 0.4)));
const dockMax = () => Math.max(320, Math.round(window.innerWidth * 0.7));

function savedSidebarWidth(): number {
  const value = Number(readStorage(SIDEBAR_WIDTH_KEY));
  return Number.isFinite(value) && value >= SIDEBAR_MIN ? Math.min(480, value) : SIDEBAR_DEFAULT;
}

type Boot =
  | { status: "loading" }
  | { status: "login" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      config: ConfigResponse;
      models: ModelInfo[];
      workspaces: Workspace[];
      authRequired: boolean;
    };

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export function App() {
  const route = useRoute();
  const dockState = useDock();
  const mobile = useMedia("(max-width: 767.5px)");
  const dockNarrow = useMedia("(max-width: 1023.5px)");

  const [boot, setBoot] = useState<Boot>({ status: "loading" });
  const [token, setToken] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [homeCwd, setHomeCwd] = useState<string>(() => readStorage(CWD_KEY) ?? "");
  const [collapsed, setCollapsed] = useState<boolean>(() => readStorage(SIDEBAR_KEY) === "collapsed");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [picker, setPicker] = useState<{ onPick: (path: string) => void } | null>(null);
  const [modelsVersion, setModelsVersion] = useState(0);

  // Splitter drags follow the pointer locally and commit on release.
  const [sidebarWidth, setSidebarWidth] = useState(savedSidebarWidth);
  const [sidebarDrag, setSidebarDrag] = useState<number | null>(null);
  const [dockDrag, setDockDrag] = useState<number | null>(null);

  const load = useCallback(async () => {
    setBoot({ status: "loading" });
    let authRequired = false;
    try {
      authRequired = (await api.authCheck()).authRequired;
    } catch (error) {
      if (isStatus(error, 401)) {
        setBoot({ status: "login" });
        return;
      }
      setBoot({ status: "error", message: errorText(error) });
      return;
    }
    try {
      const [config, models, workspaces] = await Promise.all([api.config(), api.models(), api.workspaces()]);
      setBoot({
        status: "ready",
        config,
        models: models.models,
        workspaces: workspaces.workspaces,
        authRequired,
      });
    } catch (error) {
      if (isStatus(error, 401)) {
        setBoot({ status: "login" });
        return;
      }
      setBoot({ status: "error", message: errorText(error) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const off = onUnauthorized(() => setBoot({ status: "login" }));
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    setDrawerOpen(false);
  }, [mobile]);

  useEffect(() => {
    if (homeCwd) writeStorage(CWD_KEY, homeCwd);
  }, [homeCwd]);

  useEffect(() => {
    if (route.name === "home") document.title = "pi";
    else if (route.name === "plugins") document.title = "插件 · pi";
  }, [route.name]);

  const refreshWorkspaces = useCallback(async () => {
    try {
      const data = await api.workspaces();
      setBoot((current) =>
        current.status === "ready" ? { ...current, workspaces: data.workspaces } : current,
      );
    } catch {
      // Keep the last list; a 401 already flipped the screen via onUnauthorized.
    }
  }, []);

  const ready = boot.status === "ready";

  useEffect(() => {
    if (!ready) return;
    void refreshWorkspaces();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshWorkspaces();
    }, 5000);
    const onVisible = () => {
      if (!document.hidden) void refreshWorkspaces();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ready, refreshWorkspaces]);

  const selectedCwd = boot.status === "ready" ? homeCwd || boot.config.defaultCwd : homeCwd;

  // Home follows the picked workspace; a session binds its own cwd (Conversation
  // calls dock.setCwd); the plugins page keeps whatever workspace came last.
  useEffect(() => {
    if (route.name === "home" && selectedCwd) dock.setCwd(selectedCwd);
  }, [route.name, selectedCwd]);

  const routeKey = route.name === "session" ? `s:${route.id}` : route.name;

  useEffect(() => {
    setDrawerOpen(false);
  }, [routeKey]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [drawerOpen]);

  const submitLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (loginBusy) return;
    setLoginBusy(true);
    setLoginError(null);
    try {
      await api.login(token);
      setToken("");
      await load();
    } catch (error) {
      if (isStatus(error, 401)) setLoginError("令牌不正确");
      else if (isStatus(error, 429)) setLoginError("尝试太频繁，请稍后再试");
      else setLoginError(errorText(error));
    } finally {
      setLoginBusy(false);
    }
  };

  const collapseSidebar = () => {
    setCollapsed(true);
    writeStorage(SIDEBAR_KEY, "collapsed");
  };

  const expandSidebar = () => {
    setCollapsed(false);
    writeStorage(SIDEBAR_KEY, "expanded");
  };

  const openPicker = (onPick: (path: string) => void) => setPicker({ onPick });

  const openWorkspaceFiles = (cwd: string) => {
    // Bind the dock first so the files tab lands in that workspace's tab set.
    dock.setCwd(cwd);
    dock.openFiles();
    setHomeCwd(cwd);
    navigate("/");
  };

  const modelsChanged = useCallback(async () => {
    try {
      const data = await api.models();
      setBoot((current) => (current.status === "ready" ? { ...current, models: data.models } : current));
    } catch {
      // Keep the old list; the session page refetches its own models anyway.
    }
    setModelsVersion((value) => value + 1);
  }, []);

  const commitSidebarWidth = (width: number) => {
    setSidebarWidth(width);
    writeStorage(SIDEBAR_WIDTH_KEY, String(width));
  };

  const currentSessionId = route.name === "session" ? route.id : null;
  const dockWidth = dockDrag ?? dockState.width;
  const dockOverlay = dockNarrow && !dockState.fullscreen;

  const leading: ReactNode = mobile ? (
    <button
      type="button"
      className="icon-btn"
      aria-label="打开侧栏"
      title="打开侧栏"
      onClick={() => setDrawerOpen(true)}
    >
      <MenuIcon size={16} />
    </button>
  ) : collapsed ? (
    <button
      type="button"
      className="icon-btn"
      aria-label="展开侧栏"
      title="展开侧栏"
      onClick={expandSidebar}
    >
      <PanelLeft size={16} />
    </button>
  ) : null;

  if (boot.status === "loading") {
    return (
      <div className="screen">
        <div className="boot">
          <div className="login-brand">
            <span className="login-mark" aria-hidden="true">
              π
            </span>
            <span className="login-word">pi</span>
          </div>
          <p className="login-hint">加载中…</p>
        </div>
      </div>
    );
  }

  if (boot.status === "error") {
    return (
      <div className="screen">
        <div className="login-card">
          <div className="login-brand">
            <span className="login-mark" aria-hidden="true">
              π
            </span>
            <span className="login-word">pi</span>
          </div>
          <p className="login-error">{boot.message}</p>
          <Button variant="primary" onClick={() => void load()}>
            重试
          </Button>
        </div>
      </div>
    );
  }

  if (boot.status === "login") {
    return (
      <div className="screen">
        <form className="login-card" onSubmit={submitLogin}>
          <div className="login-brand">
            <span className="login-mark" aria-hidden="true">
              π
            </span>
            <span className="login-word">pi</span>
          </div>
          <h1 className="login-title">输入访问令牌</h1>
          <input
            className="text-input"
            type="password"
            value={token}
            autoFocus
            aria-label="访问令牌"
            placeholder="访问令牌"
            onChange={(event) => setToken(event.target.value)}
          />
          {loginError !== null && <p className="login-error">{loginError}</p>}
          <Button type="submit" variant="primary" disabled={loginBusy || token.length === 0}>
            进入
          </Button>
          <p className="login-hint">令牌在启动 pi-web 的终端输出中</p>
        </form>
      </div>
    );
  }

  const showSidebar = mobile || !collapsed;
  const appStyle = mobile ? undefined : ({ "--sidebar-width": `${sidebarDrag ?? sidebarWidth}px` } as CSSProperties);

  return (
    <div className="app" style={appStyle}>
      {showSidebar && (
        <div className={mobile && drawerOpen ? "sidebar-shell open" : "sidebar-shell"}>
          <Sidebar
            workspaces={boot.workspaces}
            currentSessionId={currentSessionId}
            selectedCwd={selectedCwd}
            authRequired={boot.authRequired}
            pluginsActive={route.name === "plugins"}
            onNewSession={(cwd) => {
              if (cwd) setHomeCwd(cwd);
              navigate("/");
            }}
            onPickCwd={() =>
              openPicker((path) => {
                void api
                  .addWorkspace(path)
                  .then((data) => {
                    setBoot((current) => (current.status === "ready" ? { ...current, workspaces: data.workspaces } : current));
                    setHomeCwd(path);
                    navigate("/");
                  })
                  .catch((error: unknown) => toast(errorText(error), "error"));
              })
            }
            onOpenWorkspaceFiles={openWorkspaceFiles}
            onNavigate={() => setDrawerOpen(false)}
            onCollapse={mobile ? () => setDrawerOpen(false) : collapseSidebar}
            onRefresh={refreshWorkspaces}
            onLogout={() => setBoot({ status: "login" })}
          />
        </div>
      )}

      {showSidebar && !mobile && (
        <Splitter
          label="调整侧栏宽度"
          panel="left"
          className="sidebar-split"
          width={sidebarDrag ?? sidebarWidth}
          min={SIDEBAR_MIN}
          max={sidebarMax}
          onDrag={setSidebarDrag}
          onCommit={commitSidebarWidth}
          onReset={() => commitSidebarWidth(SIDEBAR_DEFAULT)}
        />
      )}

      {mobile && drawerOpen && (
        <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      )}

      <div className="app-body">
        <main className={dockState.fullscreen ? "app-main is-hidden" : "app-main"}>
          {route.name === "session" ? (
            <Conversation
              key={route.id}
              id={route.id}
              models={boot.models}
              modelsVersion={modelsVersion}
              leading={leading}
              onRefresh={refreshWorkspaces}
            />
          ) : (
            <>
              <header className="page-head">
                {leading}
                <span className="page-head-spacer" />
                <DockToggle />
              </header>
              {route.name === "plugins" ? (
                <PluginsPage cwd={dockState.cwd ?? (selectedCwd || null)} />
              ) : (
                <Home
                  config={boot.config}
                  models={boot.models}
                  cwd={selectedCwd}
                  onPickCwd={() => openPicker((path) => setHomeCwd(path))}
                />
              )}
            </>
          )}
        </main>

        {dockState.open && !dockState.fullscreen && !dockNarrow && (
          <Splitter
            label="调整右侧栏宽度"
            panel="right"
            className="dock-split"
            width={dockWidth}
            min={320}
            max={dockMax}
            onDrag={setDockDrag}
            onCommit={(width) => dock.setWidth(width)}
            onReset={() => dock.setWidth(560)}
          />
        )}

        {dockState.open && (
          <aside
            className={[
              "dock-col",
              dockState.fullscreen ? "is-full" : "",
              dockOverlay ? "is-overlay" : "",
              mobile ? "is-mobile" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={dockState.fullscreen || mobile ? undefined : { width: dockWidth + 16 }}
            aria-label="右侧栏"
          >
            <div className="dock-card">
              <RightDock sessionId={currentSessionId} />
            </div>
          </aside>
        )}

        {dockState.open && dockOverlay && !mobile && (
          <div className="dock-scrim" onClick={() => dock.close()} aria-hidden="true" />
        )}
      </div>

      <SettingsModal
        config={boot.config}
        cwd={dockState.cwd ?? (selectedCwd || null)}
        onModelsChanged={modelsChanged}
      />
      <Toasts />

      {picker && (
        <CwdPicker
          initialPath={selectedCwd}
          onPick={(path) => {
            const onPick = picker.onPick;
            setPicker(null);
            onPick(path);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
