import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./ui.css";

export interface ModalProps {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Extra node shown on the right of the title row (e.g. a countdown) */
  headExtra?: ReactNode;
  onClose: () => void;
  /** Preferred width in px; capped to the viewport */
  width?: number;
}

const FOCUSABLE = "input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])";

/** Centred modal over a dimmed backdrop. Esc and a backdrop click call onClose. */
export function Modal({ title, children, footer, headExtra, onClose, width = 480 }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, []);

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      >
        <div className="modal-head">
          <h2 className="modal-title">{title}</h2>
          {headExtra}
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
