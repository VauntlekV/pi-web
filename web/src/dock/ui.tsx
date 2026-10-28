/** Small shared pieces of the right dock: icon buttons, path bar, copy, status lines. */
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { AlertCircle, Check, Copy, RefreshCw } from "lucide-react";
import type { GitChangeKind } from "../../../shared/protocol.ts";
import { gitLetter, splitPath } from "./lib.ts";

export function IconButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="dock-icon-btn"
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-active={active ? "" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Absolute path with its directory truncated on the left and the name in bold. */
export function PathBar({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <div className="dock-path" title={path}>
      {dir ? <span className="dock-path-dir">{dir}/</span> : null}
      <span className="dock-path-name">{name || path}</span>
    </div>
  );
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void copyText(text).then((ok) => {
      if (ok) setCopied(true);
    });
  };

  return (
    <IconButton label={copied ? "已复制" : label} onClick={copy}>
      {copied ? <Check size={14} strokeWidth={1.75} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
    </IconButton>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context; LAN http deployments fall back.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

export function GitLetter({ kind }: { kind: GitChangeKind }) {
  return (
    <span className="dock-git-letter" data-kind={kind} aria-hidden>
      {gitLetter(kind)}
    </span>
  );
}

export function ErrorLine({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="dock-error" role="alert">
      <AlertCircle size={14} strokeWidth={1.75} aria-hidden />
      <span className="dock-error-text">{message}</span>
      {onRetry ? (
        <IconButton label="重试" onClick={onRetry}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        </IconButton>
      ) : null}
    </div>
  );
}

export function Loading({ text = "加载中…" }: { text?: string }) {
  return <div className="dock-note">{text}</div>;
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="dock-note">{children}</div>;
}
