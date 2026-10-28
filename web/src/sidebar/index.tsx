import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  FolderPlus,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Puzzle,
  Search,
  Settings,
  SlidersHorizontal,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SessionSummary, UiState, Workspace } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText, isStatus } from "../app/errors.ts";
import { navigate } from "../app/router.ts";
import { readStorage, writeStorage } from "../app/storage.ts";
import { setPrefs, usePrefs, type Prefs } from "../app/prefs.ts";
import { openSettings } from "../app/ui-store.ts";
import { Menu, type MenuEntry } from "../ui/menu.tsx";
import { Button } from "../ui/button.tsx";
import { ConfirmDialog } from "../ui/confirm.tsx";
import { Modal } from "../ui/modal.tsx";
import { toast } from "../ui/toasts.tsx";
import { relativeTime } from "./time.ts";
import {
  parseSidebarView,
  searchSessions,
  sessionTitle,
  visibleGroups,
  type SidebarView,
} from "./view.ts";
import "./sidebar.css";

const VIEW_KEY = "pi-web-sidebar-view";
const FOLDED_KEY = "pi-web-sidebar-folded";
/** Pseudo-cwd under which the whole 工作区 section's fold is remembered. */
const SECTION_FOLD = "";

function readFolded(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readStorage(FOLDED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

export interface SidebarProps {
  workspaces: Workspace[];
  currentSessionId: string | null;
  selectedCwd: string | null;
  authRequired: boolean;
  pluginsActive: boolean;
  /** Navigate home, optionally preselecting a workspace */
  onNewSession: (cwd?: string) => void;
  /** Open the directory picker for a new workspace */
  onPickCwd: () => void;
  /** Navigate to that workspace's home and open its files in the right dock */
  onOpenWorkspaceFiles: (cwd: string) => void;
  /** Called after any navigation action (closes the mobile drawer) */
  onNavigate: () => void;
  onCollapse: () => void;
  onRefresh: () => void;
  onLogout: () => void;
}

function dotClass(session: SessionSummary): string {
  if (session.running) return " session-dot-running";
  if (session.awaitingInput) return " session-dot-awaiting";
  return "";
}

const THEMES: { value: Prefs["theme"]; label: string; icon: ReactNode }[] = [
  { value: "light", label: "浅色", icon: <Sun size={14} /> },
  { value: "dark", label: "深色", icon: <Moon size={14} /> },
  { value: "system", label: "跟随系统", icon: <Monitor size={14} /> },
];

async function copyText(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("复制失败", "error");
  }
}

export function Sidebar(props: SidebarProps) {
  const { workspaces, currentSessionId, selectedCwd, authRequired, pluginsActive } = props;
  const prefs = usePrefs();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionSummary | null>(null);
  const [workspaceTarget, setWorkspaceTarget] = useState<Workspace | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [uiState, setUiState] = useState<UiState>({ pinned: [], archived: [] });
  const uiRef = useRef(uiState);
  const searchRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<SidebarView>(() => parseSidebarView(readStorage(VIEW_KEY)));
  const [folded, setFolded] = useState<Set<string>>(readFolded);

  useEffect(() => {
    let cancelled = false;
    api
      .uiState()
      .then((state) => {
        if (cancelled) return;
        uiRef.current = state;
        setUiState(state);
      })
      .catch(() => {
        // Pins/archives are optional decoration; the list still works without them.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const toggleFold = (key: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      writeStorage(FOLDED_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const changeView = (next: SidebarView) => {
    setView(next);
    writeStorage(VIEW_KEY, JSON.stringify(next));
  };

  // Optimistic ui-state update: on failure restore the previous value and toast.
  const updateUiState = (change: (current: UiState) => UiState) => {
    const previous = uiRef.current;
    const next = change(previous);
    uiRef.current = next;
    setUiState(next);
    api.setUiState(next).catch((error: unknown) => {
      if (uiRef.current === next) {
        uiRef.current = previous;
        setUiState(previous);
      }
      toast(errorText(error), "error");
    });
  };

  const togglePin = (id: string) => {
    updateUiState((current) => ({
      ...current,
      pinned: current.pinned.includes(id)
        ? current.pinned.filter((entry) => entry !== id)
        : [...current.pinned, id],
    }));
  };

  const toggleArchive = (id: string) => {
    updateUiState((current) => ({
      ...current,
      archived: current.archived.includes(id)
        ? current.archived.filter((entry) => entry !== id)
        : [...current.archived, id],
    }));
  };

  const goSession = (id: string) => {
    navigate(`/s/${encodeURIComponent(id)}`);
    props.onNavigate();
  };

  const newSession = (cwd?: string) => {
    props.onNewSession(cwd);
    props.onNavigate();
  };

  const startRename = (session: SessionSummary) => {
    setDraft(sessionTitle(session));
    setEditingId(session.id);
  };

  const commitRename = async (session: SessionSummary) => {
    const name = draft.trim();
    setEditingId(null);
    if (!name || name === sessionTitle(session)) return;
    try {
      await api.renameSession(session.id, name);
      props.onRefresh();
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      await api.deleteSession(target.id);
      if (target.id === currentSessionId) navigate("/");
      props.onRefresh();
    } catch (error) {
      if (isStatus(error, 409)) toast("会话运行中，无法删除", "warning");
      else toast(errorText(error), "error");
    }
  };

  const setWorkspaceArchived = async (workspace: Workspace, archived: boolean) => {
    try {
      await api.archiveWorkspace(workspace.cwd, archived);
      toast(archived ? `已归档「${workspace.label}」，可在视图选项 › 已归档里找回` : `已取消归档「${workspace.label}」`);
      props.onRefresh();
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  /** Deletes the workspace's session files too; the dialog says so and offers 归档 instead. */
  const deleteWorkspace = async (workspace: Workspace) => {
    setWorkspaceBusy(true);
    try {
      const { deleted } = await api.deleteWorkspace(workspace.cwd);
      if (workspace.sessions.some((session) => session.id === currentSessionId)) navigate("/");
      toast(deleted > 0 ? `已删除「${workspace.label}」及 ${deleted} 个会话记录` : `已移除「${workspace.label}」`);
      setWorkspaceTarget(null);
      props.onRefresh();
    } catch (error) {
      if (isStatus(error, 409)) toast("工作区里有会话正在运行，先停止它再删除", "warning");
      else toast(errorText(error), "error");
    } finally {
      setWorkspaceBusy(false);
    }
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch (error) {
      toast(errorText(error), "error");
      return;
    }
    props.onLogout();
  };

  const hits = workspaces.flatMap((workspace) =>
    workspace.sessions.map((session) => ({ session, workspace })),
  );
  const pinned = uiState.pinned
    .map((id) => hits.find((hit) => hit.session.id === id))
    .filter((hit): hit is { session: SessionSummary; workspace: Workspace } => hit !== undefined)
    // A session counts as archived when it or its workspace is.
    .filter(({ session, workspace }) => (uiState.archived.includes(session.id) || Boolean(workspace.archived)) === (view.show === "archived"));

  const row = (session: SessionSummary, workspace: Workspace, showWorkspace: boolean) => {
    const active = session.id === currentSessionId;
    const isPinned = uiState.pinned.includes(session.id);
    const isArchived = uiState.archived.includes(session.id);
    const title = sessionTitle(session);

    if (editingId === session.id) {
      return (
        <div className="sb-session" key={session.id}>
          <span className={`session-dot${dotClass(session)}`} aria-hidden="true" />
          <input
            className="sb-rename"
            value={draft}
            autoFocus
            aria-label="会话名称"
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename(session);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setEditingId(null);
              }
            }}
            onBlur={() => setEditingId(null)}
          />
        </div>
      );
    }

    const menu: MenuEntry[] = [
      { kind: "item", label: "重命名", icon: <Pencil size={14} />, onSelect: () => startRename(session) },
      {
        kind: "item",
        label: "删除",
        icon: <Trash2 size={14} />,
        danger: true,
        onSelect: () => setDeleteTarget(session),
      },
    ];

    return (
      <div className={active ? "sb-session active" : "sb-session"} key={session.id}>
        <button
          type="button"
          className="sb-session-main"
          title={title}
          onClick={() => goSession(session.id)}
        >
          <span className={`session-dot${dotClass(session)}`} aria-hidden="true" />
          <span className="session-title">{title}</span>
          {showWorkspace && <span className="session-ws">{workspace.label}</span>}
          <span className="session-time">{relativeTime(session.modified, Date.now())}</span>
        </button>
        <span className="sb-session-actions">
          <button
            type="button"
            className="sb-action"
            aria-label={isPinned ? "取消置顶" : "置顶"}
            title={isPinned ? "取消置顶" : "置顶"}
            onClick={() => togglePin(session.id)}
          >
            {isPinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            type="button"
            className="sb-action"
            aria-label={isArchived ? "取消归档" : "归档"}
            title={isArchived ? "取消归档" : "归档"}
            onClick={() => toggleArchive(session.id)}
          >
            {isArchived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </button>
          <Menu label="会话菜单" icon={<MoreHorizontal size={13} />} triggerClassName="sb-action" items={menu} />
        </span>
      </div>
    );
  };

  const viewMenu: MenuEntry[] = [
    { kind: "label", label: "排序" },
    {
      kind: "item",
      label: "最近活跃",
      checked: view.sort === "recent",
      onSelect: () => changeView({ ...view, sort: "recent" }),
    },
    { kind: "item", label: "名称", checked: view.sort === "name", onSelect: () => changeView({ ...view, sort: "name" }) },
    { kind: "separator" },
    { kind: "label", label: "显示" },
    {
      kind: "item",
      label: "进行中",
      checked: view.show === "active",
      onSelect: () => changeView({ ...view, show: "active" }),
    },
    {
      kind: "item",
      label: "已归档",
      checked: view.show === "archived",
      onSelect: () => changeView({ ...view, show: "archived" }),
    },
  ];

  const accountMenu: MenuEntry[] = [
    {
      kind: "item",
      label: "设置",
      icon: <Settings size={14} />,
      onSelect: () => {
        openSettings();
        props.onNavigate();
      },
    },
    { kind: "separator" },
    ...THEMES.map(
      (theme): MenuEntry => ({
        kind: "item",
        label: theme.label,
        icon: theme.icon,
        checked: prefs.theme === theme.value,
        onSelect: () => setPrefs({ theme: theme.value }),
      }),
    ),
    ...(authRequired
      ? [
          { kind: "separator" } as MenuEntry,
          {
            kind: "item" as const,
            label: "退出登录",
            icon: <LogOut size={14} />,
            danger: true,
            onSelect: () => void logout(),
          },
        ]
      : []),
  ];

  const searching = query.trim().length > 0;
  const results = searching ? searchSessions(workspaces, query) : [];
  const groups =
    view.sort === "name" ? [...workspaces].sort((a, b) => a.label.localeCompare(b.label, "zh")) : workspaces;

  const workspaceMenu = (workspace: Workspace): MenuEntry[] => [
    {
      kind: "item",
      label: "在右侧栏打开文件",
      icon: <FolderOpen size={14} />,
      onSelect: () => {
        props.onOpenWorkspaceFiles(workspace.cwd);
        props.onNavigate();
      },
    },
    {
      kind: "item",
      label: "复制路径",
      icon: <Copy size={14} />,
      onSelect: () => void copyText(workspace.cwd, "已复制路径"),
    },
    { kind: "separator" },
    workspace.archived
      ? {
          kind: "item",
          label: "取消归档",
          icon: <ArchiveRestore size={14} />,
          onSelect: () => void setWorkspaceArchived(workspace, false),
        }
      : {
          kind: "item",
          label: "归档工作区",
          detail: "隐藏，保留记录",
          icon: <Archive size={14} />,
          onSelect: () => void setWorkspaceArchived(workspace, true),
        },
    {
      kind: "item",
      label: "删除工作区…",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => setWorkspaceTarget(workspace),
    },
  ];

  return (
    <aside className="sidebar" aria-label="侧栏">
      <div className="sb-brand">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            π
          </span>
          <span className="brand-word">pi</span>
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label="收起侧栏"
          title="收起侧栏"
          onClick={props.onCollapse}
        >
          <PanelLeft size={16} />
        </button>
      </div>

      <div className="sb-search">
        <Search size={14} className="sb-search-icon" aria-hidden="true" />
        <input
          ref={searchRef}
          className="sb-search-input"
          value={query}
          placeholder="搜索"
          aria-label="搜索会话"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setQuery("");
            event.currentTarget.blur();
          }}
        />
      </div>

      <nav className="sb-nav">
        <button type="button" className="sb-row" onClick={() => newSession()}>
          <span className="sb-plus" aria-hidden="true">
            <Plus size={12} strokeWidth={2.5} />
          </span>
          <span>新会话</span>
        </button>
        <button
          type="button"
          className={pluginsActive ? "sb-row active" : "sb-row"}
          onClick={() => {
            navigate("/plugins");
            props.onNavigate();
          }}
        >
          <Puzzle size={14} className="sb-row-icon" />
          <span>插件</span>
        </button>
      </nav>

      <div className="sb-section">
        <button
          type="button"
          className="sb-section-title"
          aria-expanded={!folded.has(SECTION_FOLD)}
          onClick={() => toggleFold(SECTION_FOLD)}
        >
          工作区
          <ChevronRight size={12} className="sb-fold-chevron" aria-hidden="true" />
        </button>
        <span className="sb-section-actions">
          <Menu
            label="视图选项"
            icon={<SlidersHorizontal size={14} />}
            side="bottom"
            align="start"
            items={viewMenu}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="添加工作区"
            title="添加工作区"
            onClick={props.onPickCwd}
          >
            <FolderPlus size={14} />
          </button>
        </span>
      </div>

      <div className="sb-list">
        {searching ? (
          results.length === 0 ? (
            <p className="sb-empty">没有匹配的会话</p>
          ) : (
            results.map(({ session, workspace }) => row(session, workspace, true))
          )
        ) : (
          <>
            {pinned.length > 0 && (
              <section className="sb-group">
                <div className="sb-group-head">
                  <span className="sb-group-title">置顶</span>
                </div>
                {pinned.map(({ session, workspace }) => row(session, workspace, false))}
              </section>
            )}

            {!folded.has(SECTION_FOLD) &&
              visibleGroups(groups, uiState.archived, view).map(({ workspace, sessions }) => {
                const open = !folded.has(workspace.cwd);
                return (
                  <section className={open ? "sb-group" : "sb-group is-folded"} key={workspace.cwd}>
                    <div className={workspace.cwd === selectedCwd ? "sb-group-head is-current" : "sb-group-head"}>
                      <button
                        type="button"
                        className="sb-group-toggle"
                        title={workspace.cwd}
                        aria-expanded={open}
                        onClick={() => toggleFold(workspace.cwd)}
                      >
                        <span className="sb-group-icon" aria-hidden="true">
                          {open ? <FolderOpen size={14} /> : <Folder size={14} />}
                          <ChevronRight size={14} className="sb-fold-chevron" />
                        </span>
                        <span className="sb-group-title">{workspace.label}</span>
                        {workspace.archived && <span className="sb-group-count">已归档</span>}
                        {!open && sessions.length > 0 && <span className="sb-group-count">{sessions.length}</span>}
                      </button>
                      <span className="sb-group-actions">
                        <button
                          type="button"
                          className="sb-action"
                          aria-label="在此工作区新建会话"
                          title="在此工作区新建会话"
                          onClick={() => newSession(workspace.cwd)}
                        >
                          <Plus size={13} />
                        </button>
                        <Menu
                          label="工作区菜单"
                          icon={<MoreHorizontal size={13} />}
                          triggerClassName="sb-action"
                          items={workspaceMenu(workspace)}
                        />
                      </span>
                    </div>
                    {open && sessions.map((session) => row(session, workspace, false))}
                  </section>
                );
              })}

            {workspaces.length === 0 && (
              <div className="sb-empty sb-empty-workspaces">
                <p>还没有工作区。pi-web 只显示你添加的文件夹里的会话。</p>
                <button type="button" className="sb-empty-add" onClick={props.onPickCwd}>
                  <FolderPlus size={14} aria-hidden="true" />
                  添加工作区
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="sb-foot">
        <Menu
          label="账号菜单"
          side="top"
          align="stretch"
          triggerClassName="sb-account"
          trigger={
            <>
              <span className="sb-avatar" aria-hidden="true">
                π
              </span>
              <span className="sb-account-name">pi</span>
              <ChevronDown size={14} className="sb-account-chevron" aria-hidden="true" />
            </>
          }
          items={accountMenu}
        />
      </div>

      {workspaceTarget && (
        <Modal
          title={`删除工作区「${workspaceTarget.label}」？`}
          onClose={() => !workspaceBusy && setWorkspaceTarget(null)}
          footer={
            <>
              <Button disabled={workspaceBusy} onClick={() => setWorkspaceTarget(null)}>
                取消
              </Button>
              {!workspaceTarget.archived && (
                <Button
                  disabled={workspaceBusy}
                  onClick={() => {
                    const target = workspaceTarget;
                    setWorkspaceTarget(null);
                    void setWorkspaceArchived(target, true);
                  }}
                >
                  改为归档
                </Button>
              )}
              <Button variant="danger" disabled={workspaceBusy} onClick={() => void deleteWorkspace(workspaceTarget)}>
                {workspaceTarget.sessions.length > 0 ? `删除 ${workspaceTarget.sessions.length} 个会话记录` : "删除"}
              </Button>
            </>
          }
        >
          <div className="sb-delete-ws">
            <code title={workspaceTarget.cwd}>{workspaceTarget.cwd}</code>
            {workspaceTarget.sessions.length > 0 ? (
              <>
                <p>
                  删除工作区会<strong>永久删除</strong>它的 {workspaceTarget.sessions.length} 个会话记录（~/.pi/agent/sessions 里的文件），
                  pi CLI 里也无法再打开，且不能恢复。文件夹本身和其中的代码不受影响。
                </p>
                <p>只想从侧栏隐藏的话，请选择「改为归档」：记录会保留，可以在 视图选项 › 已归档 里找回。</p>
              </>
            ) : (
              <p>这个工作区还没有会话记录，删除只会把它从列表中移除，文件夹本身不受影响。</p>
            )}
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除会话？"
        message="此操作不可撤销。"
        confirmLabel="删除"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
  );
}
