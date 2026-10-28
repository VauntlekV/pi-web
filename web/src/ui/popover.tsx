/**
 * A popover anchored to a trigger element, rendered into <body> so no scrolling
 * or transformed ancestor can clip it. It opens upward by default (the composer
 * sits at the bottom of the page), clamps itself into the viewport, closes on
 * outside mousedown or Escape and moves focus into its first control.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

export interface PopoverProps {
  anchor: HTMLElement | null;
  /** Called on Escape / outside mousedown; true asks the trigger to take focus. */
  onClose: (restoreFocus: boolean) => void;
  className?: string;
  /** Preferred side; "auto" picks the roomier one. */
  side?: "auto" | "top" | "bottom";
  /** Horizontal alignment against the anchor. "stretch" is at least as wide as it. */
  align?: "end" | "start" | "stretch";
  children: ReactNode;
}

export function Popover({ anchor, onClose, className, side = "auto", align = "end", children }: PopoverProps) {
  const boxRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !anchor) return;

    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      box.style.minWidth = align === "stretch" ? `${rect.width}px` : "";
      box.style.maxWidth = `${Math.max(0, vw - 16)}px`;
      const width = box.offsetWidth;
      const spaceAbove = Math.max(0, rect.top - 8);
      const spaceBelow = Math.max(0, vh - rect.bottom - 8);
      const up =
        side === "top" ||
        (side === "auto" && (spaceAbove >= Math.min(box.offsetHeight, 160) || spaceAbove >= spaceBelow));
      const left = align === "start" || align === "stretch" ? rect.left : rect.right - width;
      box.style.left = `${Math.min(Math.max(8, left), Math.max(8, vw - width - 8))}px`;
      if (up) {
        box.style.top = "auto";
        box.style.bottom = `${vh - rect.top + 6}px`;
        box.style.maxHeight = `${spaceAbove}px`;
        box.style.transformOrigin = "bottom right";
      } else {
        box.style.bottom = "auto";
        box.style.top = `${rect.bottom + 6}px`;
        box.style.maxHeight = `${spaceBelow}px`;
        box.style.transformOrigin = "top right";
      }
      box.style.visibility = "visible";
    };

    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor, side, align]);

  useEffect(() => {
    const box = boxRef.current;
    const target =
      box?.querySelector<HTMLElement>("[data-autofocus]") ??
      box?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]");
    target?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      const box = boxRef.current;
      if (!box || !target) return;
      if (box.contains(target) || anchor?.contains(target)) return;
      const element = target instanceof Element ? target : null;
      const focusable = element?.closest(
        "input, textarea, button, select, a[href], [contenteditable='true'], [tabindex]",
      );
      // Restore focus to the trigger; a clicked focusable element (input,
      // textarea, another button) still takes focus afterwards.
      onClose(true);
      if (!focusable && anchor) {
        window.setTimeout(() => {
          if (!document.activeElement || document.activeElement === document.body) anchor.focus();
        }, 0);
      }
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={boxRef}
      className={className}
      style={{ visibility: "hidden" }}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
