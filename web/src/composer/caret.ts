/**
 * Gliding caret for the composer textarea (dsh-claude-style's 光标动画).
 *
 * The browser's caret has nothing animatable, so it is made transparent and a
 * 2px bar is drawn in its place; every move of the insertion point slides the
 * bar there with a short transform transition, and its blink restarts so a
 * reader who is typing never sees it dark. The textarea's caret position is
 * measured through a hidden mirror div that copies its text layout.
 *
 * Three rules keep this from ever costing the reader a caret:
 *   - the native caret is only hidden while a drawn one is showing;
 *   - an IME composition hands the caret back to the browser until it ends;
 *   - a selection (not collapsed) or a caret scrolled out of view hides the bar.
 */
import { useEffect, useRef, type RefObject } from "react";

/** Text-layout properties the mirror copies from the textarea. */
const MIRRORED = [
  "direction",
  "font-family",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "font-feature-settings",
  "font-variation-settings",
  "font-kerning",
  "letter-spacing",
  "word-spacing",
  "line-height",
  "text-align",
  "text-indent",
  "text-transform",
  "tab-size",
  "white-space",
  "word-break",
  "overflow-wrap",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const;

export interface CaretBox {
  /** offset from the textarea's padding box, scroll already applied */
  left: number;
  top: number;
  height: number;
}

/** Where the collapsed caret at `pos` sits inside the textarea, or null when it cannot be measured. */
export function measureCaret(el: HTMLTextAreaElement, pos: number): CaretBox | null {
  const style = getComputedStyle(el);
  const mirror = document.createElement("div");
  for (const name of MIRRORED) mirror.style.setProperty(name, style.getPropertyValue(name));
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  mirror.style.overflow = "hidden";
  mirror.style.boxSizing = "content-box";
  mirror.style.border = "0";
  mirror.style.margin = "0";
  mirror.style.height = "auto";
  // A textarea wraps like pre-wrap whatever white-space it computes to.
  mirror.style.whiteSpace = "pre-wrap";
  const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
  mirror.style.width = `${Math.max(0, el.clientWidth - paddingX)}px`;

  mirror.textContent = el.value.slice(0, pos);
  const marker = document.createElement("span");
  // A zero-width character keeps the marker on the caret's own line.
  marker.textContent = "​";
  mirror.appendChild(marker);
  mirror.appendChild(document.createTextNode(el.value.slice(pos) || " "));

  document.body.appendChild(mirror);
  const box = { left: marker.offsetLeft - el.scrollLeft, top: marker.offsetTop - el.scrollTop, height: marker.offsetHeight };
  mirror.remove();
  return box.height > 0 ? box : null;
}

/**
 * Draw a gliding caret for `ref`'s textarea while `enabled`. The textarea's
 * parent must be a positioning context (the composer wraps it in
 * `.composer-field`). Returns a function that re-measures on the next frame,
 * for value changes React makes without an input event (clear, history).
 */
export function useGlidingCaret(ref: RefObject<HTMLTextAreaElement | null>, enabled: boolean): () => void {
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!enabled || !el || !host) {
      scheduleRef.current = () => {};
      return;
    }

    const bar = document.createElement("div");
    bar.className = "composer-caret";
    bar.setAttribute("aria-hidden", "true");
    host.appendChild(bar);

    let frame = 0;
    let visible = false;
    let composing = false;

    const hide = () => {
      if (visible) bar.removeAttribute("data-visible");
      visible = false;
      el.removeAttribute("data-caret-drawn");
    };

    const draw = () => {
      frame = 0;
      if (composing || document.activeElement !== el || el.selectionStart !== el.selectionEnd) {
        hide();
        return;
      }
      const box = measureCaret(el, el.selectionStart ?? 0);
      if (!box || box.top < -1 || box.top + box.height > el.clientHeight + 1 || box.left > el.clientWidth) {
        hide();
        return;
      }
      const x = Math.round(el.offsetLeft + el.clientLeft + box.left);
      const y = Math.round(el.offsetTop + el.clientTop + box.top);
      const fresh = !visible;
      // The first frame lands without a transition, or the bar would slide in
      // from wherever it was last shown.
      if (fresh) bar.style.transitionProperty = "none";
      bar.style.transform = `translate(${x}px, ${y}px)`;
      bar.style.height = `${box.height}px`;
      if (fresh) {
        bar.setAttribute("data-visible", "");
        visible = true;
        el.setAttribute("data-caret-drawn", "");
        void bar.offsetWidth;
        bar.style.transitionProperty = "";
      }
      for (const animation of bar.getAnimations?.() ?? []) animation.currentTime = 0;
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;

    const onSelectionChange = () => {
      if (document.activeElement === el) schedule();
    };
    const onCompositionStart = () => {
      composing = true;
      hide();
    };
    const onCompositionEnd = () => {
      composing = false;
      schedule();
    };

    document.addEventListener("selectionchange", onSelectionChange);
    el.addEventListener("input", schedule);
    el.addEventListener("keydown", schedule);
    el.addEventListener("pointerup", schedule);
    el.addEventListener("scroll", schedule);
    el.addEventListener("focus", schedule);
    el.addEventListener("blur", hide);
    el.addEventListener("compositionstart", onCompositionStart);
    el.addEventListener("compositionend", onCompositionEnd);
    const resize = new ResizeObserver(schedule);
    resize.observe(el);
    // Web fonts arriving late change every glyph's width.
    void document.fonts?.ready.then(schedule);
    schedule();

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", onSelectionChange);
      el.removeEventListener("input", schedule);
      el.removeEventListener("keydown", schedule);
      el.removeEventListener("pointerup", schedule);
      el.removeEventListener("scroll", schedule);
      el.removeEventListener("focus", schedule);
      el.removeEventListener("blur", hide);
      el.removeEventListener("compositionstart", onCompositionStart);
      el.removeEventListener("compositionend", onCompositionEnd);
      resize.disconnect();
      el.removeAttribute("data-caret-drawn");
      bar.remove();
      scheduleRef.current = () => {};
    };
  }, [ref, enabled]);

  return () => scheduleRef.current();
}
