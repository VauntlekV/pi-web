/**
 * Small controls shared by the settings sections: a row (title + description +
 * control), the switch, the select shell and a copy button.
 */
import { Check, ChevronDown, Copy, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "../ui/toasts.tsx";

export function SettingsRow({
  title,
  description,
  block = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Stack the control under the text (choice cards, model lists) */
  block?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={block ? "settings-row settings-row-block" : "settings-row"}>
      <div className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        {description !== undefined && <span className="settings-row-desc">{description}</span>}
      </div>
      {children !== undefined && <div className="settings-row-control">{children}</div>}
    </div>
  );
}

export function SettingsGroup({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h3 className="settings-group-title">{title}</h3>
      {children}
    </section>
  );
}

export function Switch({
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
      className="settings-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="settings-switch-knob" aria-hidden="true" />
    </button>
  );
}

/** Native select with the chip look and a chevron. Children are <option>/<optgroup>. */
export function Select({
  value,
  onChange,
  label,
  disabled = false,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={disabled ? "settings-select is-disabled" : "settings-select"}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} className="settings-spin" aria-hidden="true" />;
}

function legacyCopy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function CopyButton({ text, label = "复制", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const done = (ok: boolean) => {
      setCopied(ok);
      toast(ok ? "已复制" : "复制失败", ok ? "info" : "error");
    };
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      done(legacyCopy(text));
      return;
    }
    clipboard
      .writeText(text)
      .then(() => done(true))
      .catch(() => done(legacyCopy(text)));
  };

  return (
    <button
      type="button"
      className={className ?? "settings-copy"}
      aria-label={label}
      title={label}
      onClick={copy}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}
