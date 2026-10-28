/** Files tab: workspace path bar and a lazy, keyboard-navigable file tree. */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ChevronRight, File, FileCode, FileImage, FileText, Folder, RefreshCw } from "lucide-react";
import type { FileEntry } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText } from "../app/errors.ts";
import { fileIcon } from "./lib.ts";
import { dock } from "./store.ts";
import { CopyButton, ErrorLine, GitLetter, IconButton, Loading, PathBar } from "./ui.tsx";

interface TreeMemory {
  expanded: Set<string>;
  entries: Map<string, FileEntry[]>;
}

/** Expanded directories and cached levels survive tab switches (per workspace). */
const memories = new Map<string, TreeMemory>();

function memory(cwd: string): TreeMemory {
  let found = memories.get(cwd);
  if (!found) {
    found = { expanded: new Set(), entries: new Map() };
    memories.set(cwd, found);
  }
  return found;
}

type Row =
  | { kind: "entry"; entry: FileEntry; level: number }
  | { kind: "loading"; path: string; level: number }
  | { kind: "error"; path: string; message: string; level: number };

export function FilesTab({ cwd }: { cwd: string }) {
  const mem = useMemo(() => memory(cwd), [cwd]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(mem.expanded));
  const [entries, setEntries] = useState<Map<string, FileEntry[]>>(() => new Map(mem.entries));
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [focusPath, setFocusPath] = useState<string | null>(null);
  const alive = useRef(true);
  const loadSeq = useRef(0);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const dirs = ["", ...mem.expanded];
    setLoading(new Set(dirs));
    const results = await Promise.allSettled(dirs.map((dir) => api.fileTree(cwd, dir)));
    if (!alive.current || seq !== loadSeq.current) return;

    const loaded = new Map<string, FileEntry[]>();
    const failed = new Map<string, string>();
    results.forEach((result, index) => {
      const dir = dirs[index]!;
      if (result.status === "fulfilled") loaded.set(dir, result.value.entries);
      else failed.set(dir, errorText(result.reason));
    });

    if (loaded.size > 0) {
      setEntries((previous) => {
        const next = new Map(previous);
        for (const [dir, list] of loaded) next.set(dir, list);
        mem.entries = next;
        return next;
      });
    }
    setErrors(failed);
    setLoading(new Set());
  }, [cwd, mem]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const toggleDir = useCallback(
    (entry: FileEntry) => {
      if (entry.type !== "dir") return;
      if (mem.expanded.has(entry.path)) {
        const next = new Set(mem.expanded);
        next.delete(entry.path);
        mem.expanded = next;
        setExpanded(next);
        return;
      }

      const next = new Set(mem.expanded);
      next.add(entry.path);
      mem.expanded = next;
      setExpanded(next);
      if (mem.entries.has(entry.path)) return;

      setLoading((previous) => new Set(previous).add(entry.path));
      api
        .fileTree(cwd, entry.path)
        .then((response) => {
          if (!alive.current) return;
          const merged = new Map(mem.entries);
          merged.set(entry.path, response.entries);
          mem.entries = merged;
          setEntries(merged);
          setErrors((previous) => {
            if (!previous.has(entry.path)) return previous;
            const cleared = new Map(previous);
            cleared.delete(entry.path);
            return cleared;
          });
        })
        .catch((error: unknown) => {
          if (!alive.current) return;
          setErrors((previous) => new Map(previous).set(entry.path, errorText(error)));
        })
        .finally(() => {
          if (!alive.current) return;
          setLoading((previous) => {
            const done = new Set(previous);
            done.delete(entry.path);
            return done;
          });
        });
    },
    [cwd, mem],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (path: string, level: number) => {
      for (const entry of entries.get(path) ?? []) {
        out.push({ kind: "entry", entry, level });
        if (entry.type !== "dir" || !expanded.has(entry.path)) continue;
        const error = errors.get(entry.path);
        if (error) out.push({ kind: "error", path: entry.path, message: error, level: level + 1 });
        else if (loading.has(entry.path) && !entries.has(entry.path))
          out.push({ kind: "loading", path: entry.path, level: level + 1 });
        else walk(entry.path, level + 1);
      }
    };
    walk("", 0);
    return out;
  }, [entries, expanded, errors, loading]);

  const visible = useMemo(
    () => rows.flatMap((row) => (row.kind === "entry" ? [{ entry: row.entry, level: row.level }] : [])),
    [rows],
  );
  const firstPath = visible[0]?.entry.path ?? null;
  const focus = focusPath ?? firstPath;

  const focusRow = (path: string) => {
    setFocusPath(path);
    rowRefs.current.get(path)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = visible.findIndex((item) => item.entry.path === focus);
    const current = visible[index];
    if (!current) return;
    const { entry, level } = current;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = visible[index + 1];
      if (next) focusRow(next.entry.path);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const previous = visible[index - 1];
      if (previous) focusRow(previous.entry.path);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (entry.type === "dir" && !expanded.has(entry.path)) void toggleDir(entry);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (entry.type === "dir" && expanded.has(entry.path)) {
        void toggleDir(entry);
        return;
      }
      for (let at = index - 1; at >= 0; at -= 1) {
        const candidate = visible[at]!;
        if (candidate.level < level) {
          focusRow(candidate.entry.path);
          break;
        }
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (entry.type === "dir") void toggleDir(entry);
      else dock.openFile(entry.path);
    }
  };

  const rootError = errors.get("");
  const rootLoading = loading.has("") && !entries.has("");

  return (
    <div className="dock-files">
      <div className="dock-bar">
        <PathBar path={cwd} />
        <IconButton label="刷新" onClick={() => void load()}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <CopyButton text={cwd} label="复制路径" />
      </div>

      <div className="dock-tree" role="tree" aria-label="工作区文件" onKeyDown={onKeyDown}>
        {rootError ? <ErrorLine message={rootError} onRetry={() => void load()} /> : null}
        {rootLoading && !rootError ? <Loading /> : null}
        {rows.map((row) => {
          if (row.kind === "loading") {
            return (
              <div key={`loading:${row.path}`} className="dock-note dock-tree-note" style={{ paddingLeft: 8 + row.level * 16 }}>
                加载中…
              </div>
            );
          }
          if (row.kind === "error") {
            return (
              <div key={`error:${row.path}`} className="dock-tree-error" style={{ paddingLeft: 8 + row.level * 16 }}>
                {row.message}
              </div>
            );
          }

          const { entry, level } = row;
          const isDir = entry.type === "dir";
          const open = isDir && expanded.has(entry.path);
          return (
            <div
              key={entry.path}
              ref={(element) => {
                if (element) rowRefs.current.set(entry.path, element);
                else rowRefs.current.delete(entry.path);
              }}
              role="treeitem"
              aria-level={level + 1}
              aria-expanded={isDir ? open : undefined}
              tabIndex={focus === entry.path ? 0 : -1}
              data-path={entry.path}
              className="dock-tree-row"
              style={{ paddingLeft: 8 + level * 16 }}
              onClick={() => {
                setFocusPath(entry.path);
                if (isDir) void toggleDir(entry);
                else dock.openFile(entry.path);
              }}
              onFocus={() => setFocusPath(entry.path)}
            >
              <span className="dock-tree-chevron" data-open={open ? "" : undefined}>
                {isDir ? <ChevronRight size={14} strokeWidth={1.75} aria-hidden /> : null}
              </span>
              <span className={entry.ignored ? "dock-tree-icon is-ignored" : "dock-tree-icon"}>
                <EntryIcon entry={entry} />
              </span>
              <span
                className={`dock-tree-name${entry.ignored ? " is-ignored" : ""}${isDir && entry.git ? " is-changed" : ""}`}
              >
                {entry.name}
              </span>
              {entry.git ? <GitLetter kind={entry.git} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EntryIcon({ entry }: { entry: FileEntry }) {
  if (entry.type === "dir") {
    return <Folder size={14} strokeWidth={1.75} className="dock-icon-folder" aria-hidden />;
  }
  const size = 14;
  switch (fileIcon(entry.name)) {
    case "code":
      return <FileCode size={size} strokeWidth={1.75} aria-hidden />;
    case "markdown":
      return <FileText size={size} strokeWidth={1.75} aria-hidden />;
    case "image":
      return <FileImage size={size} strokeWidth={1.75} aria-hidden />;
    case "file":
      return <File size={size} strokeWidth={1.75} aria-hidden />;
  }
}
