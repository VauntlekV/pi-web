/**
 * PluginsPage — 插件 page in the main column (route /plugins): pi packages,
 * built-in extensions, extensions, skills, prompt templates, install/remove.
 *
 * CONTRACT: the shell renders <PluginsPage cwd/> for the /plugins route.
 */
import {
  ChevronDown,
  FileCode2,
  FileText,
  Loader2,
  Package,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  PackageView,
  ResourceItem,
  ResourcesView,
  ResourceType,
} from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { ORIGIN_LABELS, errorText, filterResources, matchesQuery } from "../settings/lib.ts";
import { Button } from "../ui/button.tsx";
import { ConfirmDialog } from "../ui/confirm.tsx";
import { Modal } from "../ui/modal.tsx";
import { toast } from "../ui/toasts.tsx";
import "./plugins.css";

export interface PluginsPageProps {
  /** cwd for project-scoped resources; null = user scope only */
  cwd: string | null;
}

const TYPE_LABELS: Record<ResourceType, string> = {
  extension: "扩展",
  skill: "技能",
  prompt: "提示模板",
  theme: "主题",
};

const TYPE_ICONS: Partial<Record<ResourceType, typeof Package>> = {
  extension: Puzzle,
  skill: Sparkles,
  prompt: FileText,
};

interface BuiltinMeta {
  key: string;
  description: string;
  icon: typeof Package;
}

const BUILTIN_META: BuiltinMeta[] = [
  { key: "codemode", description: "让模型用脚本批量调用工具", icon: FileCode2 },
  { key: "tool-search", description: "按需搜索与加载工具", icon: Search },
  { key: "mcp", description: "连接 MCP 服务器提供的工具", icon: Server },
];

/** Only enriches a built-in the server listed; unknown ones get the generic icon and no description. */
function builtinMeta(item: ResourceItem): BuiltinMeta | undefined {
  const haystack = `${item.name} ${item.id}`.toLowerCase();
  return BUILTIN_META.find((meta) => haystack.includes(meta.key));
}

function builtinRank(item: ResourceItem): number {
  const haystack = `${item.name} ${item.id}`.toLowerCase();
  const index = BUILTIN_META.findIndex((meta) => haystack.includes(meta.key));
  return index === -1 ? BUILTIN_META.length : index;
}

function resourceDescription(item: ResourceItem): string {
  if (item.description) return item.description;
  if (item.path) return item.path.split("/").filter(Boolean).pop() ?? item.path;
  return item.id;
}

function countText(counts: PackageView["counts"]): string {
  const parts = (Object.keys(TYPE_LABELS) as ResourceType[])
    .filter((type) => (counts[type] ?? 0) > 0)
    .map((type) => `${counts[type]} 个${TYPE_LABELS[type]}`);
  return parts.length > 0 ? parts.join(" · ") : "未提供扩展或技能";
}

function PluginsSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className="plugins-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="plugins-switch-knob" aria-hidden="true" />
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="plugins-group">
      <h2 className="plugins-group-title">{title}</h2>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="plugins-skeleton" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((row) => (
        <div className="plugins-skeleton-row" key={row}>
          <span className="plugins-skeleton-icon" />
          <span className="plugins-skeleton-lines">
            <span />
            <span />
          </span>
        </div>
      ))}
    </div>
  );
}

function AddPackageDialog({
  cwd,
  onClose,
  onInstalled,
}: {
  cwd: string | null;
  onClose: () => void;
  onInstalled: (resources: ResourcesView) => void;
}) {
  const [source, setSource] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const install = async () => {
    const value = source.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    setLog([]);
    try {
      const result = await api.installPackage(value, {
        local: scope === "project",
        cwd: scope === "project" ? cwd ?? undefined : undefined,
      });
      setLog(result.log);
      if (result.ok) {
        onInstalled(result.resources);
      } else {
        setError(result.error ?? "安装失败");
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="添加插件"
      width={540}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void install()} disabled={busy || source.trim() === ""}>
            {busy && <Loader2 size={14} className="plugins-spin" aria-hidden="true" />}
            安装
          </Button>
        </>
      }
    >
      <div className="plugins-add-form">
        <label className="plugins-field">
          <span className="plugins-field-label">来源</span>
          <input
            className="text-input"
            value={source}
            placeholder="npm:@scope/pkg、git:github.com/user/repo 或本地路径"
            aria-label="插件来源"
            autoFocus
            disabled={busy}
            onChange={(event) => setSource(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void install();
              }
            }}
          />
        </label>

        <div className="plugins-scope">
          <span className="plugins-field-label">安装位置</span>
          <label className="plugins-radio">
            <input
              type="radio"
              name="plugin-scope"
              checked={scope === "user"}
              disabled={busy}
              onChange={() => setScope("user")}
            />
            用户
          </label>
          {cwd !== null && (
            <label className="plugins-radio">
              <input
                type="radio"
                name="plugin-scope"
                checked={scope === "project"}
                disabled={busy}
                onChange={() => setScope("project")}
              />
              当前项目
            </label>
          )}
        </div>

        {error !== null && <p className="plugins-error-text">{error}</p>}

        {(busy || log.length > 0) && (
          <div className="plugins-log-card">
            {busy && (
              <p className="plugins-log-wait">
                <Loader2 size={14} className="plugins-spin" aria-hidden="true" />
                正在安装，可能需要几分钟…
              </p>
            )}
            {log.length > 0 && <pre className="plugins-log">{log.join("\n")}</pre>}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function PluginsPage({ cwd }: PluginsPageProps) {
  const [view, setView] = useState<ResourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<PackageView | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await api.resources(cwd ?? undefined));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const toggleResource = async (item: ResourceItem, enabled: boolean) => {
    const before = view;
    if (view) {
      setView({
        ...view,
        items: view.items.map((entry) =>
          entry.type === item.type && entry.id === item.id ? { ...entry, enabled } : entry,
        ),
      });
    }
    setPending(item.id);
    try {
      setView(await api.toggleResource({ cwd: cwd ?? undefined, type: item.type, id: item.id, enabled }));
      setNotice(true);
    } catch (cause) {
      setView(before);
      toast(errorText(cause), "error");
    } finally {
      setPending(null);
    }
  };

  const updatePackage = async (pkg: PackageView) => {
    setPending(pkg.source);
    try {
      const result = await api.updatePackages(pkg.source, pkg.scope === "project" ? cwd ?? undefined : undefined);
      if (result.ok) {
        setView(result.resources);
        setNotice(true);
        toast("已更新插件");
      } else {
        toast(result.error ?? "更新失败", "error");
      }
    } catch (cause) {
      toast(errorText(cause), "error");
    } finally {
      setPending(null);
    }
  };

  const updateAll = async () => {
    setUpdatingAll(true);
    try {
      const result = await api.updatePackages();
      if (result.ok) {
        setView(result.resources);
        setNotice(true);
        toast("已检查更新全部插件");
      } else {
        toast(result.error ?? "更新失败", "error");
      }
    } catch (cause) {
      toast(errorText(cause), "error");
    } finally {
      setUpdatingAll(false);
    }
  };

  const removePackage = async () => {
    const pkg = removeTarget;
    setRemoveTarget(null);
    if (!pkg) return;
    setPending(pkg.source);
    try {
      const result = await api.removePackage(pkg.source, {
        local: pkg.scope === "project",
        cwd: pkg.scope === "project" ? cwd ?? undefined : undefined,
      });
      if (result.ok) {
        setView(result.resources);
        setNotice(true);
        toast("已移除插件");
      } else {
        toast(result.error ?? "移除失败", "error");
      }
    } catch (cause) {
      toast(errorText(cause), "error");
    } finally {
      setPending(null);
    }
  };

  const builtins = (view?.items ?? [])
    .filter((item) => item.type === "extension" && item.origin === "builtin")
    .filter((item) => matchesQuery([item.name, builtinMeta(item)?.description, item.id], query))
    .sort((a, b) => builtinRank(a) - builtinRank(b));

  const filtered = view ? filterResources(view, query) : null;
  const packages = filtered?.packages ?? [];
  const resourcesOf = (type: ResourceType) =>
    (filtered?.items ?? []).filter(
      (item) => item.type === type && !(type === "extension" && item.origin === "builtin"),
    );

  const renderResource = (item: ResourceItem) => {
    const Icon = TYPE_ICONS[item.type] ?? Puzzle;
    const description = resourceDescription(item);
    return (
      <div className="plugins-row" key={`${item.type}:${item.id}`}>
        <span className="plugins-row-icon">
          <Icon size={20} aria-hidden="true" />
        </span>
        <div className="plugins-row-text">
          <div className="plugins-row-name">
            <span className="plugins-row-name-text">{item.name}</span>
            <span className="plugins-badge" title={item.origin === "package" ? item.packageSource : undefined}>
              {ORIGIN_LABELS[item.origin]}
            </span>
          </div>
          <div className="plugins-row-desc" title={description}>
            {description}
          </div>
        </div>
        <PluginsSwitch
          checked={item.enabled}
          disabled={pending === item.id}
          label={`启用 ${item.name}`}
          onChange={(enabled) => void toggleResource(item, enabled)}
        />
      </div>
    );
  };

  const renderGroup = (type: ResourceType, title: string) => {
    const items = resourcesOf(type);
    return (
      <Group title={title}>
        {items.length === 0 ? <p className="plugins-empty">暂无</p> : items.map(renderResource)}
      </Group>
    );
  };

  return (
    <div className="plugins-page">
      <div className="plugins-inner">
        <header className="plugins-header">
          <div className="plugins-heading">
            <h1 className="plugins-title">插件</h1>
            <p className="plugins-desc">安装、启用和配置 pi 的扩展、技能与提示模板</p>
          </div>
          <div className="plugins-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="刷新"
              title="刷新"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={16} className={loading ? "plugins-spin" : undefined} aria-hidden="true" />
            </button>
            <div className="plugins-add">
              <Button variant="primary" onClick={() => setAddOpen(true)}>
                <Plus size={15} aria-hidden="true" />
                添加插件
              </Button>
              <div className="plugins-add-more" ref={menuRef}>
                <button
                  type="button"
                  className="plugins-add-toggle"
                  aria-label="更多安装操作"
                  title="更多安装操作"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
                {menuOpen && (
                  <div className="plugins-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="plugins-menu-item"
                      disabled={updatingAll}
                      onClick={() => {
                        setMenuOpen(false);
                        void updateAll();
                      }}
                    >
                      {updatingAll ? (
                        <Loader2 size={14} className="plugins-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw size={14} aria-hidden="true" />
                      )}
                      检查更新全部
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </header>

        {notice && (
          <div className="plugins-notice" role="status">
            <span>更改会在新会话生效；已打开的会话可在顶栏 ··· 菜单中重新加载扩展。</span>
            <button
              type="button"
              className="icon-btn plugins-notice-close"
              aria-label="关闭提示"
              title="关闭提示"
              onClick={() => setNotice(false)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}

        <div className="plugins-search">
          <Search size={15} aria-hidden="true" />
          <input
            className="text-input"
            value={query}
            placeholder="搜索插件、技能与提示模板"
            aria-label="搜索插件"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {error !== null && (
          <div className="plugins-error" role="alert">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>{error}</span>
            <Button onClick={() => void load()}>重试</Button>
          </div>
        )}

        {loading && view === null ? (
          <Skeleton />
        ) : view !== null ? (
          <>
            <Group title="内置扩展">
              {builtins.length === 0 ? (
                <p className="plugins-empty">暂无</p>
              ) : (
                builtins.map((item) => {
                  const meta = builtinMeta(item);
                  const Icon = meta?.icon ?? Puzzle;
                  return (
                    <div className="plugins-row" key={item.id}>
                      <span className="plugins-row-icon">
                        <Icon size={20} aria-hidden="true" />
                      </span>
                      <div className="plugins-row-text">
                        <div className="plugins-row-name">
                          <span className="plugins-row-name-text">{item.name}</span>
                        </div>
                        {meta !== undefined && (
                          <div className="plugins-row-desc" title={meta.description}>
                            {meta.description}
                          </div>
                        )}
                      </div>
                      <PluginsSwitch
                        checked={item.enabled}
                        disabled={pending === item.id}
                        label={`启用 ${item.name}`}
                        onChange={(enabled) => void toggleResource(item, enabled)}
                      />
                    </div>
                  );
                })
              )}
            </Group>

            <Group title="已安装包">
              {packages.length === 0 ? (
                <p className="plugins-empty">暂无</p>
              ) : (
                packages.map((pkg) => (
                  <div className="plugins-row" key={`${pkg.scope}:${pkg.source}`}>
                    <span className="plugins-row-icon">
                      <Package size={20} aria-hidden="true" />
                    </span>
                    <div className="plugins-row-text">
                      <div className="plugins-row-name">
                        <span className="plugins-source">{pkg.source}</span>
                        <span className="plugins-badge">{pkg.scope === "user" ? "用户" : "项目"}</span>
                      </div>
                      <div className="plugins-row-desc">{countText(pkg.counts)}</div>
                    </div>
                    <div className="plugins-row-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`更新 ${pkg.source}`}
                        title="更新"
                        disabled={pending === pkg.source}
                        onClick={() => void updatePackage(pkg)}
                      >
                        {pending === pkg.source ? (
                          <Loader2 size={16} className="plugins-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw size={16} aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`移除 ${pkg.source}`}
                        title="移除"
                        onClick={() => setRemoveTarget(pkg)}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </Group>

            {renderGroup("extension", "扩展")}
            {renderGroup("skill", "技能")}
            {renderGroup("prompt", "提示模板")}

            {view.diagnostics.length > 0 && (
              <details className="plugins-diagnostics">
                <summary>加载问题（{view.diagnostics.length}）</summary>
                <ul>
                  {view.diagnostics.map((line, index) => (
                    <li key={`${index}:${line}`}>{line}</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        ) : null}
      </div>

      {addOpen && (
        <AddPackageDialog
          cwd={cwd}
          onClose={() => setAddOpen(false)}
          onInstalled={(resources) => {
            setView(resources);
            setNotice(true);
            toast("已安装插件");
            setAddOpen(false);
          }}
        />
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="移除插件"
        message={
          removeTarget
            ? `移除 ${removeTarget.source}？移除后其扩展与技能将不再加载。`
            : undefined
        }
        confirmLabel="移除"
        danger
        onConfirm={() => void removePackage()}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
