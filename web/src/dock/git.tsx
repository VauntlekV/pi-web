/**
 * Git tab: a header row with the branch, a compact commit box and the
 * commit / pull / push actions, then the staged and unstaged groups and the
 * commit graph. The commit box can pop out into a movable floating editor, and
 * ✨ asks the conversation's model (thinking off) to write the message.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FileText,
  GitBranch,
  LoaderCircle,
  Minus,
  PictureInPicture2,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import type { GitCommit, GitFileChange, GitRef, GitStatus } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText } from "../app/errors.ts";
import { layoutGraph, type Edge, type GraphRow } from "./graph.ts";
import { relativeTime, splitPath } from "./lib.ts";
import { dock } from "./store.ts";
import { ErrorLine, GitLetter, IconButton, Loading } from "./ui.tsx";

const LOG_LIMIT = 100;

type Busy = "commit" | "pull" | "push" | null;

export function GitTab({ cwd, sessionId }: { cwd: string; sessionId: string | null }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(true);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [generating, setGenerating] = useState(false);
  const [floating, setFloating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.gitStatus(cwd);
      if (!alive.current) return;
      setStatus(next);
      setError(null);
    } catch (caught: unknown) {
      if (!alive.current) return;
      setError(errorText(caught));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [cwd]);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      const response = await api.gitLog(cwd, LOG_LIMIT, true);
      if (!alive.current) return;
      setCommits(response.commits);
    } catch (caught: unknown) {
      if (!alive.current) return;
      setLogError(errorText(caught));
    } finally {
      if (alive.current) setLogLoading(false);
    }
  }, [cwd]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    // Opening the history section loads it by itself; this covers mount and 刷新.
    if (logOpen) void loadLog();
  }, [refresh, loadLog, nonce]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // Status may change from the agent's tools while the tab is open.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const apply = async (paths: string[], unstage: boolean) => {
    if (paths.length === 0) return;
    setActionError(null);
    try {
      const next = unstage ? await api.gitUnstage(cwd, paths) : await api.gitStage(cwd, paths);
      if (alive.current) setStatus(next);
    } catch (caught: unknown) {
      if (alive.current) setActionError(errorText(caught));
    }
  };

  const staged = status?.files.filter((file) => file.staged) ?? [];
  const unstaged = status?.files.filter((file) => file.unstaged) ?? [];
  const canCommit = message.trim().length > 0 && staged.length > 0 && busy === null;
  const branch = status && status.isRepo ? (status.branch ?? "分离头指针") : null;

  /** Run a write action; on success show `done` and reload the graph. */
  const run = async (kind: Exclude<Busy, null>, action: () => Promise<string>) => {
    if (busy !== null) return false;
    setBusy(kind);
    setActionError(null);
    try {
      const done = await action();
      if (!alive.current) return false;
      setNotice(done);
      if (logOpen) void loadLog();
      return true;
    } catch (caught: unknown) {
      if (alive.current) setActionError(errorText(caught));
      return false;
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const commit = async () => {
    const text = message.trim();
    if (!canCommit) return false;
    return run("commit", async () => {
      const response = await api.gitCommit(cwd, text);
      if (alive.current) {
        setStatus(response.status);
        setMessage("");
      }
      return `已提交 ${response.commit.short} ${response.commit.subject}`;
    });
  };

  const pull = () =>
    void run("pull", async () => {
      const next = await api.gitPull(cwd);
      if (alive.current) setStatus(next);
      return "已拉取";
    });

  const push = () =>
    void run("push", async () => {
      const next = await api.gitPush(cwd);
      if (alive.current) setStatus(next);
      return next.upstream ? `已推送到 ${next.upstream}` : "已推送";
    });

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setActionError(null);
    try {
      const response = await api.gitMessage(cwd, sessionId);
      if (alive.current) setMessage(response.message);
    } catch (caught: unknown) {
      if (alive.current) setActionError(errorText(caught));
    } finally {
      if (alive.current) setGenerating(false);
    }
  };

  const canGenerate = !generating && (status?.files.length ?? 0) > 0;

  return (
    <div className="dock-git">
      <div className="dock-git-head">
        <span className="dock-git-where" title={status?.upstream ? `${branch} → ${status.upstream}` : (branch ?? "")}>
          <GitBranch size={15} strokeWidth={1.75} aria-hidden />
          <span className="dock-git-branch">{branch ?? "Git"}</span>
        </span>
        {status?.isRepo ? (
          <>
            <div className="dock-git-message">
              <textarea
                className="dock-git-message-input"
                rows={1}
                placeholder={staged.length > 0 ? "提交信息（Enter 提交）" : "提交信息"}
                aria-label="提交信息"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void commit();
                  }
                }}
              />
              <IconButton
                label={generating ? "生成中…" : "AI 生成提交信息"}
                disabled={!canGenerate}
                onClick={() => void generate()}
              >
                {generating ? <Spinner /> : <Sparkles size={14} strokeWidth={1.75} aria-hidden />}
              </IconButton>
              <IconButton label="悬浮编辑" active={floating} onClick={() => setFloating(!floating)}>
                <PictureInPicture2 size={14} strokeWidth={1.75} aria-hidden />
              </IconButton>
            </div>
            <button
              type="button"
              className="dock-primary dock-primary-sm"
              disabled={!canCommit}
              title={staged.length === 0 ? "没有暂存的更改" : "提交暂存的更改"}
              onClick={() => void commit()}
            >
              {busy === "commit" ? <Spinner /> : <Check size={13} strokeWidth={2} aria-hidden />}
              提交
            </button>
            <SyncButton label="拉取" count={status.behind} busy={busy === "pull"} disabled={busy !== null} onClick={pull}>
              <ArrowDown size={14} strokeWidth={1.75} aria-hidden />
            </SyncButton>
            <SyncButton
              label={status.upstream ? "推送" : "发布分支"}
              count={status.ahead}
              busy={busy === "push"}
              disabled={busy !== null || !status.branch}
              onClick={push}
            >
              <ArrowUp size={14} strokeWidth={1.75} aria-hidden />
            </SyncButton>
          </>
        ) : (
          <span className="dock-grow" />
        )}
        <IconButton label="刷新" onClick={() => setNonce((value) => value + 1)}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>

      {notice || actionError ? (
        <div className="dock-git-status" data-error={actionError ? "" : undefined} role={actionError ? "alert" : "status"}>
          <span>{actionError ?? notice}</span>
          {actionError ? (
            <IconButton label="关闭" onClick={() => setActionError(null)}>
              <X size={13} strokeWidth={1.75} aria-hidden />
            </IconButton>
          ) : null}
        </div>
      ) : null}

      <div className="dock-git-body">
        {loading && !status ? <Loading /> : null}
        {error ? <ErrorLine message={error} onRetry={() => setNonce((value) => value + 1)} /> : null}
        {!loading && status && !status.isRepo ? <div className="dock-empty">当前工作区不是 Git 仓库</div> : null}

        {status?.isRepo ? (
          <>
            <ChangeGroup
              title="暂存的更改"
              changes={staged}
              staged
              open={stagedOpen}
              onToggle={() => setStagedOpen(!stagedOpen)}
              onAll={() => void apply(staged.map((file) => file.path), true)}
              onToggleFile={(file) => void apply([file.path], true)}
            />
            <ChangeGroup
              title="更改"
              changes={unstaged}
              staged={false}
              open={unstagedOpen}
              onToggle={() => setUnstagedOpen(!unstagedOpen)}
              onAll={() => void apply(unstaged.map((file) => file.path), false)}
              onToggleFile={(file) => void apply([file.path], false)}
            />

            <div className="dock-commits">
              <button
                type="button"
                className="dock-commits-head"
                aria-expanded={logOpen}
                onClick={() => {
                  const next = !logOpen;
                  setLogOpen(next);
                  if (next) void loadLog();
                }}
              >
                <span className="dock-chevron" data-open={logOpen ? "" : undefined}>
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
                </span>
                提交历史
              </button>
              {logOpen ? (
                logLoading && commits.length === 0 ? (
                  <Loading />
                ) : logError ? (
                  <ErrorLine message={logError} onRetry={() => void loadLog()} />
                ) : commits.length === 0 ? (
                  <div className="dock-note">还没有提交</div>
                ) : (
                  <CommitGraph commits={commits} />
                )
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {floating && status?.isRepo ? (
        <FloatingCommit
          branch={branch ?? ""}
          message={message}
          onChange={setMessage}
          stagedCount={staged.length}
          canCommit={canCommit}
          committing={busy === "commit"}
          canGenerate={canGenerate}
          generating={generating}
          onGenerate={() => void generate()}
          onCommit={() => void commit().then((ok) => ok && alive.current && setFloating(false))}
          onClose={() => setFloating(false)}
        />
      ) : null}
    </div>
  );
}

function Spinner() {
  return <LoaderCircle className="dock-spin" size={13} strokeWidth={2} aria-hidden />;
}

function SyncButton({
  label,
  count,
  busy,
  disabled,
  onClick,
  children,
}: {
  label: string;
  count: number;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const title = count > 0 ? `${label}（${count}）` : label;
  return (
    <button type="button" className="dock-sync-btn" title={title} aria-label={title} disabled={disabled} onClick={onClick}>
      {busy ? <Spinner /> : children}
      {count > 0 ? <span className="dock-sync-count">{count}</span> : null}
    </button>
  );
}

// ------------------------------------------------------------ floating editor

interface Point {
  x: number;
  y: number;
}

const FLOAT_WIDTH = 420;
/** Where the editor was last left, kept while the page lives. */
let floatAt: Point | null = null;

function clampPoint(point: Point, box: HTMLElement | null): Point {
  const width = box?.offsetWidth ?? FLOAT_WIDTH;
  const height = box?.offsetHeight ?? 220;
  return {
    x: Math.min(Math.max(8, point.x), Math.max(8, window.innerWidth - width - 8)),
    y: Math.min(Math.max(8, point.y), Math.max(8, window.innerHeight - height - 8)),
  };
}

function FloatingCommit({
  branch,
  message,
  onChange,
  stagedCount,
  canCommit,
  committing,
  canGenerate,
  generating,
  onGenerate,
  onCommit,
  onClose,
}: {
  branch: string;
  message: string;
  onChange: (value: string) => void;
  stagedCount: number;
  canCommit: boolean;
  committing: boolean;
  canGenerate: boolean;
  generating: boolean;
  onGenerate: () => void;
  onCommit: () => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const [at, setAt] = useState<Point>(
    () => floatAt ?? { x: window.innerWidth - FLOAT_WIDTH - 32, y: Math.max(8, window.innerHeight - 320) },
  );

  useEffect(() => {
    setAt((point) => clampPoint(point, boxRef.current));
    textRef.current?.focus();
    const onResize = () => setAt((point) => clampPoint(point, boxRef.current));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    floatAt = at;
  }, [at]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    drag.current = { dx: event.clientX - at.x, dy: event.clientY - at.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const offset = drag.current;
    if (!offset) return;
    setAt(clampPoint({ x: event.clientX - offset.dx, y: event.clientY - offset.dy }, boxRef.current));
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  return createPortal(
    <div
      ref={boxRef}
      className="dock-float"
      role="dialog"
      aria-label="编辑提交信息"
      style={{ left: at.x, top: at.y }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div
        className="dock-float-head"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <GitBranch size={14} strokeWidth={1.75} aria-hidden />
        <span className="dock-float-title">提交到 {branch}</span>
        <span className="dock-float-count">{stagedCount} 个暂存文件</span>
        <IconButton label="关闭" onClick={onClose}>
          <X size={14} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>
      <textarea
        ref={textRef}
        className="dock-float-input"
        aria-label="提交信息（悬浮编辑）"
        placeholder={"提交信息\n\n第一行写摘要，空一行后写详细说明"}
        value={message}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            onCommit();
          }
        }}
      />
      <div className="dock-float-foot">
        <button type="button" className="dock-button" disabled={!canGenerate} onClick={onGenerate}>
          {generating ? <Spinner /> : <Sparkles size={14} strokeWidth={1.75} aria-hidden />}
          {generating ? "生成中…" : "AI 生成"}
        </button>
        <span className="dock-float-hint">Ctrl+Enter 提交</span>
        <button type="button" className="dock-primary" disabled={!canCommit} onClick={onCommit}>
          {committing ? "提交中…" : "提交"}
        </button>
      </div>
    </div>,
    document.body,
  );
}

// --------------------------------------------------------------- commit graph

const ROW_HEIGHT = 26;
const LANE_WIDTH = 12;
const MAX_LANES = 10;
const LANE_COLORS = [
  "var(--accent)",
  "var(--git-renamed)",
  "var(--git-added)",
  "var(--git-modified)",
  "var(--git-conflicted)",
  "var(--ink-3)",
];

const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const laneX = (lane: number) => LANE_WIDTH / 2 + 2 + lane * LANE_WIDTH;

function CommitGraph({ commits }: { commits: GitCommit[] }) {
  const layout = layoutGraph(commits);
  const width = laneX(Math.min(layout.lanes, MAX_LANES) - 1) + LANE_WIDTH / 2 + 2;
  const now = Date.now();

  return (
    <div className="dock-graph">
      {commits.map((commit, index) => {
        const row = layout.rows[index];
        const head = commit.refs?.some((ref) => ref.kind === "head") ?? false;
        return (
          <div
            key={commit.hash}
            className="dock-graph-row"
            data-head={head ? "" : undefined}
            title={`${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}\n${commit.subject}`}
          >
            <GraphCell row={row} width={width} head={head} />
            <RefChips refs={commit.refs ?? []} />
            <span className="dock-commit-subject">{commit.subject}</span>
            <code className="dock-commit-hash">{commit.short}</code>
            <span className="dock-commit-time">{relativeTime(commit.date, now)}</span>
          </div>
        );
      })}
    </div>
  );
}

function GraphCell({ row, width, head }: { row: GraphRow; width: number; head: boolean }) {
  const mid = ROW_HEIGHT / 2;
  const segment = ([from, to]: Edge, y0: number, y1: number, color: number, key: string) => {
    const x0 = laneX(from);
    const x1 = laneX(to);
    const d =
      from === to
        ? `M${x0} ${y0}V${y1}`
        : `M${x0} ${y0}C${x0} ${y0 + (y1 - y0) * 0.75} ${x1} ${y0 + (y1 - y0) * 0.25} ${x1} ${y1}`;
    return <path key={key} d={d} stroke={laneColor(color)} />;
  };
  const x = laneX(row.lane);

  return (
    <svg className="dock-graph-cell" width={width} height={ROW_HEIGHT} viewBox={`0 0 ${width} ${ROW_HEIGHT}`} aria-hidden>
      {row.top.map((edge, index) => segment(edge, 0, mid, edge[0], `t${index}`))}
      {row.bottom.map((edge, index) => segment(edge, mid, ROW_HEIGHT, edge[1], `b${index}`))}
      <circle
        cx={x}
        cy={mid}
        r={head ? 4 : 3.5}
        fill={head ? "var(--canvas)" : laneColor(row.lane)}
        stroke={laneColor(row.lane)}
        strokeWidth={head ? 2 : 0}
      />
    </svg>
  );
}

function RefChips({ refs }: { refs: GitRef[] }) {
  if (refs.length === 0) return null;
  return (
    <span className="dock-refs">
      {refs.map((ref) => (
        <span key={`${ref.kind}:${ref.name}`} className="dock-ref" data-kind={ref.kind} title={ref.name}>
          {ref.name}
        </span>
      ))}
    </span>
  );
}

function ChangeGroup({
  title,
  changes,
  staged,
  open,
  onToggle,
  onAll,
  onToggleFile,
}: {
  title: string;
  changes: GitFileChange[];
  staged: boolean;
  open: boolean;
  onToggle: () => void;
  onAll: () => void;
  onToggleFile: (file: GitFileChange) => void;
}) {
  return (
    <div className="dock-git-group">
      <div className="dock-git-group-head">
        <button type="button" className="dock-git-group-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="dock-chevron" data-open={open ? "" : undefined}>
            <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
          </span>
          <span>{title}</span>
          <span className="dock-git-count">{changes.length}</span>
        </button>
        {changes.length > 0 ? (
          <button type="button" className="dock-git-all" onClick={onAll}>
            {staged ? "全部取消暂存" : "全部暂存"}
          </button>
        ) : null}
      </div>
      {open
        ? changes.map((file) => (
            <GitRow
              key={`${staged ? "s" : "u"}:${file.path}`}
              file={file}
              staged={staged}
              onToggle={() => onToggleFile(file)}
            />
          ))
        : null}
    </div>
  );
}

function GitRow({ file, staged, onToggle }: { file: GitFileChange; staged: boolean; onToggle: () => void }) {
  const kind = (staged ? file.staged : file.unstaged) ?? "modified";
  const { dir, name } = splitPath(file.path);

  return (
    <div className="dock-git-row">
      <button type="button" className="dock-git-main" onClick={() => dock.openDiff(file.path, staged)} title={file.path}>
        <GitLetter kind={kind} />
        <span className="dock-git-name">{name}</span>
        <span className="dock-git-dir">{dir}</span>
      </button>
      <div className="dock-git-row-actions">
        {kind !== "deleted" ? (
          <IconButton label="打开文件" onClick={() => dock.openFile(file.path)}>
            <FileText size={14} strokeWidth={1.75} aria-hidden />
          </IconButton>
        ) : null}
        {staged ? (
          <IconButton label="取消暂存" onClick={onToggle}>
            <Minus size={14} strokeWidth={1.75} aria-hidden />
          </IconButton>
        ) : (
          <IconButton label="暂存" onClick={onToggle}>
            <Plus size={14} strokeWidth={1.75} aria-hidden />
          </IconButton>
        )}
      </div>
    </div>
  );
}
