/**
 * RightDock — the right-hand tabbed panel: 文件 and Git in the top bar, then
 * any file previews / diffs opened from them or from the conversation.
 * Reads everything from the dock store (./store.ts); the workspace is
 * `useDock().cwd`, which the shell keeps in sync with the current session.
 *
 * CONTRACT: the shell renders <RightDock/> inside the right column it sizes
 * from `useDock().width` (or full-width when `fullscreen`). Implementations may
 * add optional props but must not change these.
 */
import { File, FileCode, FileImage, FileText, Folder, GitBranch, GitCompare, Maximize2, Minimize2, PanelRightClose, Plus, X } from "lucide-react";
import { Menu } from "../ui/menu.tsx";
import { dock, useDock, type DockTab } from "./store.ts";
import { fileIcon, splitPath } from "./lib.ts";
import { DiffTab } from "./diff.tsx";
import { FilesTab } from "./files.tsx";
import { GitTab } from "./git.tsx";
import { FileTab } from "./preview.tsx";
import "./dock.css";

export interface RightDockProps {
  /** Current session id, if any (for "open in conversation" style links); null on home */
  sessionId: string | null;
}

export function RightDock(_props: RightDockProps) {
  const state = useDock();
  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];

  return (
    <div className="dock">
      <TabBar tabs={state.tabs} activeId={active?.id ?? null} fullscreen={state.fullscreen} />
      <div className="dock-body">
        {state.cwd === null ? (
          <div className="dock-empty">先打开一个会话或在首页选择工作区</div>
        ) : active === undefined || active.kind === "files" ? (
          <FilesTab key={state.cwd} cwd={state.cwd} />
        ) : active.kind === "file" ? (
          <FileTab key={`${state.cwd}:${active.path}`} cwd={state.cwd} path={active.path} line={active.line} />
        ) : active.kind === "git" ? (
          <GitTab key={state.cwd} cwd={state.cwd} />
        ) : (
          <DiffTab key={active.id} cwd={state.cwd} path={active.path} staged={active.staged} />
        )}
      </div>
    </div>
  );
}

function TabBar({ tabs, activeId, fullscreen }: { tabs: DockTab[]; activeId: string | null; fullscreen: boolean }) {
  return (
    <div className="dock-tabs">
      <div className="dock-tab-scroll">
        {tabs.map((tab) => (
          <Tab key={tab.id} tab={tab} active={tab.id === activeId} />
        ))}
        <Menu
          label="新标签"
          icon={<Plus size={15} strokeWidth={1.75} aria-hidden />}
          triggerClassName="dock-tab-add"
          side="bottom"
          align="start"
          items={[
            {
              kind: "item",
              label: "文件",
              icon: <Folder size={14} strokeWidth={1.75} className="dock-icon-folder" aria-hidden />,
              checked: tabs.some((tab) => tab.kind === "files"),
              onSelect: () => dock.openFiles(),
            },
            {
              kind: "item",
              label: "Git",
              icon: <GitBranch size={14} strokeWidth={1.75} aria-hidden />,
              checked: tabs.some((tab) => tab.kind === "git"),
              onSelect: () => dock.openGit(),
            },
          ]}
        />
      </div>
      <div className="dock-actions">
        <button
          type="button"
          className="dock-icon-btn"
          title={fullscreen ? "退出全屏" : "全屏"}
          aria-label={fullscreen ? "退出全屏" : "全屏"}
          onClick={() => dock.setFullscreen(!fullscreen)}
        >
          {fullscreen ? <Minimize2 size={15} strokeWidth={1.75} aria-hidden /> : <Maximize2 size={15} strokeWidth={1.75} aria-hidden />}
        </button>
        <button type="button" className="dock-icon-btn" title="收起右侧栏面板" aria-label="收起右侧栏面板" onClick={() => dock.close()}>
          <PanelRightClose size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function Tab({ tab, active }: { tab: DockTab; active: boolean }) {
  const label = tabLabel(tab);
  return (
    <div className="dock-tab" data-active={active ? "" : undefined} title={tab.kind === "file" || tab.kind === "diff" ? tab.path : label}>
      <button type="button" className="dock-tab-main" onClick={() => dock.activate(tab.id)} aria-current={active ? "page" : undefined}>
        <span className="dock-tab-icon">
          <TabIcon tab={tab} />
        </span>
        <span className="dock-tab-name">{label}</span>
      </button>
      <button type="button" className="dock-tab-close" title={`关闭 ${label}`} aria-label={`关闭 ${label}`} onClick={() => dock.closeTab(tab.id)}>
        <X size={12} strokeWidth={2} aria-hidden />
      </button>
    </div>
  );
}

function tabLabel(tab: DockTab): string {
  switch (tab.kind) {
    case "files":
      return "文件";
    case "file":
    case "diff":
      return splitPath(tab.path).name || tab.path;
    case "git":
      return "Git";
  }
}

function TabIcon({ tab }: { tab: DockTab }) {
  const size = 14;
  switch (tab.kind) {
    case "files":
      return <Folder size={size} strokeWidth={1.75} className="dock-icon-folder" aria-hidden />;
    case "file":
      switch (fileIcon(tab.path)) {
        case "code":
          return <FileCode size={size} strokeWidth={1.75} aria-hidden />;
        case "markdown":
          return <FileText size={size} strokeWidth={1.75} aria-hidden />;
        case "image":
          return <FileImage size={size} strokeWidth={1.75} aria-hidden />;
        case "file":
          return <File size={size} strokeWidth={1.75} aria-hidden />;
      }
    case "git":
      return <GitBranch size={size} strokeWidth={1.75} aria-hidden />;
    case "diff":
      return <GitCompare size={size} strokeWidth={1.75} aria-hidden />;
  }
}
