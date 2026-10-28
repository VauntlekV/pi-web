import { ChevronRight, Folder } from "lucide-react";
import { useEffect, useState } from "react";
import type { FsListResponse } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText } from "../app/errors.ts";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/modal.tsx";
import "./dialogs.css";

export interface CwdPickerProps {
  initialPath: string;
  onPick: (path: string) => void;
  onClose: () => void;
}

function join(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const result = [{ label: "/", path: "/" }];
  parts.forEach((part, index) => {
    result.push({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` });
  });
  return result;
}

/** Modal directory browser for picking a session working directory. */
export function CwdPicker({ initialPath, onPick, onClose }: CwdPickerProps) {
  const [path, setPath] = useState(initialPath);
  const [input, setInput] = useState(initialPath);
  const [data, setData] = useState<FsListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listDirs(path)
      .then((response) => {
        if (cancelled) return;
        setData(response);
        setError(null);
        setPath(response.path);
        setInput(response.path);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setData(null);
        setError(errorText(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const current = data?.path ?? path;
  const trail = crumbs(current);

  const go = () => {
    const next = input.trim();
    if (next) setPath(next);
  };

  return (
    <Modal
      title="选择工作目录"
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => onPick(current)}>
            选择此目录
          </Button>
        </>
      }
    >
      <div className="picker">
        <input
          className="text-input"
          value={input}
          aria-label="目录路径"
          spellCheck={false}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              go();
            }
          }}
        />

        <nav className="picker-crumbs" aria-label="路径">
          {trail.map((crumb, index) => (
            <span className="picker-crumb-item" key={crumb.path}>
              {index > 0 && <ChevronRight size={12} aria-hidden="true" />}
              <button type="button" className="picker-crumb" onClick={() => setPath(crumb.path)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>

        <div className="picker-list">
          {error !== null ? (
            <p className="picker-error">{error}</p>
          ) : data === null ? (
            <p className="picker-empty">{loading ? "加载中…" : "这里没有子目录"}</p>
          ) : data.dirs.length === 0 ? (
            <p className="picker-empty">这里没有子目录</p>
          ) : (
            data.dirs.map((name) => (
              <button
                key={name}
                type="button"
                className="picker-dir"
                title="双击进入"
                onDoubleClick={() => setPath(join(data.path, name))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    setPath(join(data.path, name));
                  }
                }}
              >
                <Folder size={14} />
                <span>{name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
