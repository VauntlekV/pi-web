/** Diff tab: unified diff of one file, staged or unstaged. */
import { useEffect, useMemo, useState } from "react";
import { FileText, Minus, Plus, RefreshCw } from "lucide-react";
import type { GitDiffResponse } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText } from "../app/errors.ts";
import { parseUnifiedDiff } from "./lib.ts";
import { dock } from "./store.ts";
import { ErrorLine, IconButton, Loading, PathBar } from "./ui.tsx";

export function DiffTab({ cwd, path, staged }: { cwd: string; path: string; staged: boolean }) {
  const [data, setData] = useState<GitDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setData(null);
    setError(null);
    api
      .gitDiff(cwd, path, staged)
      .then((response) => {
        if (alive) setData(response);
      })
      .catch((caught: unknown) => {
        if (alive) setError(errorText(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cwd, path, staged, nonce]);

  const hunks = useMemo(() => (data ? parseUnifiedDiff(data.diff) : []), [data]);
  const fullPath = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;

  const toggle = async () => {
    setActionError(null);
    try {
      if (staged) await api.gitUnstage(cwd, [path]);
      else await api.gitStage(cwd, [path]);
      dock.openDiff(path, !staged);
    } catch (caught: unknown) {
      setActionError(errorText(caught));
    }
  };

  return (
    <div className="dock-diff">
      <div className="dock-bar">
        <PathBar path={fullPath} />
        <span className="dock-diff-tag">{staged ? "已暂存" : "未暂存"}</span>
        <IconButton label="打开文件" onClick={() => dock.openFile(path)}>
          <FileText size={14} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <IconButton label={staged ? "取消暂存" : "暂存"} onClick={() => void toggle()}>
          {staged ? <Minus size={14} strokeWidth={1.75} aria-hidden /> : <Plus size={14} strokeWidth={1.75} aria-hidden />}
        </IconButton>
        <IconButton label="刷新" onClick={() => setNonce((value) => value + 1)}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        </IconButton>
      </div>

      <div className="dock-content dock-diff-body">
        {loading && !data ? <Loading /> : null}
        {error ? <ErrorLine message={error} onRetry={() => setNonce((value) => value + 1)} /> : null}
        {actionError ? <ErrorLine message={actionError} /> : null}
        {data?.binary ? <div className="dock-empty">二进制文件已更改</div> : null}
        {data && !data.binary && hunks.length === 0 ? <div className="dock-empty">没有改动</div> : null}
        {data && !data.binary && hunks.length > 0 ? (
          <div className="dock-diff-hunks">
            {hunks.map((hunk, hunkIndex) => (
              <div className="dock-hunk" key={hunkIndex}>
                <div className="dock-hunk-head">{hunk.header}</div>
                {hunk.lines.map((line, lineIndex) => (
                  <div className={`dock-diff-row is-${line.kind}`} key={lineIndex}>
                    <span className="dock-diff-num">{line.oldLine ?? ""}</span>
                    <span className="dock-diff-num">{line.newLine ?? ""}</span>
                    <span className="dock-diff-sign" aria-hidden>
                      {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
                    </span>
                    <code className="dock-diff-text">{line.text || " "}</code>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        {data?.truncated ? <div className="dock-note">文件过大，diff 只显示前 512 KiB</div> : null}
      </div>
    </div>
  );
}
