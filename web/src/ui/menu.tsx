import { Check } from "lucide-react";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Popover } from "./popover.tsx";
import "./ui.css";

export type MenuEntry =
  | {
      kind: "item";
      label: string;
      /** Muted text right after the label (an English/command name) */
      detail?: string;
      /** Muted text at the right edge (a one-line description) */
      hint?: string;
      icon?: ReactNode;
      danger?: boolean;
      /** Renders a check mark and aria-checked (single-choice entries) */
      checked?: boolean;
      onSelect: () => void;
    }
  | { kind: "label"; label: string }
  | { kind: "separator" };

export interface MenuProps {
  /** Accessible name / tooltip of the trigger button */
  label: string;
  /** Icon-button trigger, used when `trigger` is absent */
  icon?: ReactNode;
  /** Custom trigger content (a whole row, a split-button chevron, …) */
  trigger?: ReactNode;
  triggerClassName?: string;
  items: MenuEntry[];
  side?: "auto" | "top" | "bottom";
  align?: "end" | "start" | "stretch";
  listClassName?: string;
}

/** Popover menu used by the sidebar rows, the conversation header and the composer. */
export function Menu({
  label,
  icon,
  trigger,
  triggerClassName = "icon-btn",
  items,
  side = "auto",
  align = "end",
  listClassName,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % buttons.length
        : (current - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {trigger ?? icon}
      </button>
      {open && (
        <Popover anchor={triggerRef.current} onClose={close} className="menu-popover" side={side} align={align}>
          <div
            ref={listRef}
            className={listClassName ? `menu-list ${listClassName}` : "menu-list"}
            role="menu"
            aria-label={label}
            onKeyDown={onKeyDown}
          >
            {items.map((entry, index) => {
              if (entry.kind === "separator") {
                return <div key={`sep-${index}`} className="menu-separator" role="separator" />;
              }
              if (entry.kind === "label") {
                return (
                  <div key={`label-${index}`} className="menu-label">
                    {entry.label}
                  </div>
                );
              }
              const checkable = entry.checked !== undefined;
              return (
                <button
                  key={`item-${index}-${entry.label}`}
                  type="button"
                  role={checkable ? "menuitemradio" : "menuitem"}
                  aria-checked={checkable ? entry.checked : undefined}
                  className={entry.danger ? "menu-item menu-item-danger" : "menu-item"}
                  onClick={() => {
                    close(true);
                    entry.onSelect();
                  }}
                >
                  {entry.icon !== undefined && (
                    <span className="menu-item-icon" aria-hidden="true">
                      {entry.icon}
                    </span>
                  )}
                  <span className="menu-item-label">{entry.label}</span>
                  {entry.detail && <span className="menu-item-detail">{entry.detail}</span>}
                  {entry.hint && <span className="menu-item-hint">{entry.hint}</span>}
                  {entry.checked && <Check size={14} className="menu-item-check" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </Popover>
      )}
    </>
  );
}
