/**
 * A vertical drag handle that resizes the panel on one side of it. The pointer
 * is captured on the handle, so the drag keeps tracking over iframes, popovers
 * and the edge of the window; the width follows the pointer through `onDrag`
 * and is committed once on release (`onCommit`). Arrow keys nudge by 16px and
 * a double click resets.
 */
import { useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

export interface SplitterProps {
  label: string;
  /** Which side of the handle the resized panel sits on. */
  panel: "left" | "right";
  width: number;
  min: number;
  /** Upper bound, read when a drag starts (it usually depends on the window). */
  max: () => number;
  /** Live width while dragging (null once the drag ends). */
  onDrag: (width: number | null) => void;
  onCommit: (width: number) => void;
  onReset: () => void;
  className?: string;
}

export function Splitter({ label, panel, width, min, max, onDrag, onCommit, onReset, className }: SplitterProps) {
  const dragRef = useRef<{ startX: number; startWidth: number; width: number; max: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clamp = (value: number, upper: number) => Math.min(upper, Math.max(min, Math.round(value)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width, width, max: max() };
    setDragging(true);
    document.body.classList.add("is-resizing");
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    drag.width = clamp(drag.startWidth + (panel === "left" ? delta : -delta), drag.max);
    onDrag(drag.width);
  };

  const finish = () => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragging(false);
    document.body.classList.remove("is-resizing");
    onDrag(null);
    if (drag.width !== drag.startWidth) onCommit(drag.width);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const grow = (event.key === "ArrowRight") === (panel === "left");
    onCommit(clamp(width + (grow ? 16 : -16), max()));
  };

  return (
    <div
      className={["splitter", dragging ? "is-dragging" : "", className ?? ""].filter(Boolean).join(" ")}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
