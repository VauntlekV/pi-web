/** Git tab: branch header, staged/unstaged groups, commit box and recent commits. */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, FileText, GitBranch, Minus, Plus, RefreshCw } from "lucide-react";
import type { GitCommit, GitFileChange, GitStatus } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText } from "../app/errors.ts";
import { relativeTime, splitPath } from "./lib.ts";
import { dock } from "./store.ts";
import { ErrorLine, GitLetter, IconButton, Loading } from "./ui.tsx";

export function GitTab({ cwd }: { cwd: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [unstagedOpen, setUnstagedOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const alive = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [refresh, nonce]);

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

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    setLogError(null);
    try {
      const response = await api.gitLog(cwd, 15);
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
    const element = textarea.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, 132)}px`;
  }, [message]);

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

  const commit = async () => {
    const text = message.trim();
    if (!text || committing || !status?.files.some((file) => file.staged)) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const response = await api.gitCommit(cwd, text);
      if (!alive.current) return;
      setStatus(response.status);
      setMessage("");
      setNotice(`已提交 ${response.commit.short} ${response.commit.subject}`);
      if (logOpen) void loadLog();
    } catch (caught: unknown) {
      if (alive.current) setCommitError(errorText(caught));
    } finally {
      if (alive.current) setCommitting(false);
    }
  };

  const staged = status?.files.filter((file) => file.staged) ?? [];
  const unstaged = status?.files.filter((file) => file.unstaged) ?? [];
  const canCommit = message.trim().length > 0 && staged.length > 0 && !committing;
  const branch = status && status.isRepo ? (status.branch ?? "分离头指针") : null;

  return (
    <div className="dock-git">
      <div className="dock-git-head">
        <GitBranch size={15} strokeWidth={1.75} aria-hidden />
        <span className="dock-git-branch">{branch ?? "Git"}</span>
        {status && status.ahead > 0 ? <span className="dock-git-track">↑{status.ahead}</span> : null}
        {status && status.behind > 0 ? <span className="dock-git-track">↓{status.behind}</span> : null}
        <span className="dock-grow" />
        <IconButton label="刷新" onClick={() => setNonce((value) => value + 1)}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>

      <div className="dock-git-body">
        {loading && !status ? <Loading /> : null}
        {error ? <ErrorLine message={error} onRetry={() => setNonce((value) => value + 1)} /> : null}
        {!loading && status && !status.isRepo ? <div className="dock-empty">当前工作区不是 Git 仓库</div> : null}
        {actionError ? <ErrorLine message={actionError} /> : null}

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
                  if (next && commits.length === 0) void loadLog();
                }}
              >
                <span className="dock-chevron" data-open={logOpen ? "" : undefined}>
                  <ChevronRight size={14} strokeWidth={1.75} aria-hidden />
                </span>
                最近提交
              </button>
              {logOpen ? (
                logLoading ? (
                  <Loading />
                ) : logError ? (
                  <ErrorLine message={logError} onRetry={() => void loadLog()} />
                ) : commits.length === 0 ? (
                  <div className="dock-note">还没有提交</div>
                ) : (
                  <div className="dock-commit-list">
                    {commits.map((commit) => (
                      <div key={commit.hash} className="dock-commit-row">
                        <code className="dock-commit-hash">{commit.short}</code>
                        <span className="dock-commit-subject" title={commit.subject}>
                          {commit.subject}
                        </span>
                        <span className="dock-commit-time">{relativeTime(commit.date, Date.now())}</span>
                      </div>
                    ))}
                  </div>
                )
              ) : null}
            </div>
          </>
        ) : null}
      </div>

      {status?.isRepo ? (
        <div className="dock-commit">
          {notice ? (
          <div className="dock-commit-notice" role="status">
            {notice}
          </div>
          ) : null}
          <textarea
            ref={textarea}
            className="dock-commit-input"
            rows={2}
            placeholder="提交信息"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void commit();
              }
            }}
          />
          <div className="dock-commit-foot">
            <span className="dock-commit-error" role="alert">
              {commitError}
            </span>
            <button type="button" className="dock-primary" disabled={!canCommit} onClick={() => void commit()}>
              {committing ? "提交中…" : "提交"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
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
