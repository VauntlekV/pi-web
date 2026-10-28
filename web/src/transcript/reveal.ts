/**
 * 新文字淡入 — streamed characters arrive faint and settle to full strength,
 * after dsh-claude-style's chat-reveal.
 *
 * The fade is drawn with the CSS Custom Highlight API: no element is wrapped
 * or rewritten, so React keeps owning the markdown DOM. Each container marked
 * `[data-reveal]` (the live turn's answer) is watched; when its text grows,
 * the new characters (by offset into the container's text) become a segment
 * with a birth time, and every frame the live segments are sorted into
 * REVEAL_STEPS highlights by age (styles/motion.css paints step i at a rising
 * alpha). A small stagger across a batch reads as the text sweeping in.
 *
 * Where the API is missing, or under reduced motion, nothing happens and text
 * simply appears.
 */
import { useEffect, type RefObject } from "react";
import { motionReduced } from "../app/prefs.ts";

export const REVEAL_STEPS = 12;
/** How long one character takes to reach full strength (dsh's --duration-reveal). */
export const REVEAL_MS = 120;
/** Per-character stagger inside one batch, bounded as dsh does. */
const STAGGER_MIN_MS = 1;
const STAGGER_MAX_MS = 8;
/** A container first seen with this much text or less is "the start of an answer" and fades in whole. */
const FIRST_SIGHT_LIMIT = 200;
/** Batches larger than this (a re-render, a pasted block) are shown at once. */
const BURST_LIMIT = 4000;

interface Segment {
  from: number;
  to: number;
  born: number;
  stagger: number;
}

/** Text nodes of a container that the fade paints (code blocks keep their own colours). */
function textNodes(container: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function textLength(nodes: Text[]): number {
  let total = 0;
  for (const node of nodes) total += node.data.length;
  return total;
}

/** Step of a character born at `born`, or -1 once it is fully opaque. */
export function revealStep(age: number): number {
  if (age < 0) return 0;
  if (age >= REVEAL_MS) return -1;
  return Math.min(REVEAL_STEPS - 1, Math.floor((age / REVEAL_MS) * REVEAL_STEPS));
}

/** The stagger is a share of the fade, so neither pace takes over (dsh: fade / 50, within 1–8ms). */
export const REVEAL_STAGGER_MS = Math.min(STAGGER_MAX_MS, Math.max(STAGGER_MIN_MS, REVEAL_MS / 50));

export function useReveal(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const root = rootRef.current;
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    if (!enabled || !root || !registry || typeof Highlight !== "function") return;

    const highlights = Array.from({ length: REVEAL_STEPS }, () => new Highlight());
    highlights.forEach((highlight, index) => registry.set(`pi-reveal-${index}`, highlight));
    const known = new WeakMap<Element, number>();
    const live = new Map<Element, Segment[]>();
    let frame = 0;

    const scan = () => {
      if (motionReduced()) return;
      const now = performance.now();
      for (const container of root.querySelectorAll("[data-reveal]")) {
        const length = textLength(textNodes(container));
        const before = known.get(container);
        known.set(container, length);
        const from = before === undefined ? (length <= FIRST_SIGHT_LIMIT ? 0 : length) : before;
        const added = length - from;
        if (added <= 0 || added > BURST_LIMIT) continue;
        const segments = live.get(container) ?? [];
        segments.push({ from, to: length, born: now, stagger: REVEAL_STAGGER_MS });
        live.set(container, segments);
      }
      if (live.size > 0 && frame === 0) frame = requestAnimationFrame(paint);
      if (live.size > 0) paint(now, false);
    };

    // Rebuild every step's ranges from the current text nodes: React may have
    // replaced nodes since the last frame, so ranges are never kept.
    const paint = (now: number, fromFrame = true) => {
      if (fromFrame) frame = 0;
      highlights.forEach((highlight) => highlight.clear());
      for (const [container, segments] of live) {
        const alive = segments.filter((segment) => now - segment.born - (segment.to - segment.from) * segment.stagger < REVEAL_MS);
        if (!container.isConnected || alive.length === 0) {
          live.delete(container);
          continue;
        }
        live.set(container, alive);
        const nodes = textNodes(container);
        let offset = 0;
        for (const node of nodes) {
          const start = offset;
          const end = offset + node.data.length;
          offset = end;
          for (const segment of alive) {
            const lo = Math.max(start, segment.from);
            const hi = Math.min(end, segment.to);
            if (lo >= hi) continue;
            // Consecutive characters on the same step share one range.
            let runStart = lo;
            let runStep = revealStep(now - segment.born - (lo - segment.from) * segment.stagger);
            for (let at = lo + 1; at <= hi; at += 1) {
              const step = at < hi ? revealStep(now - segment.born - (at - segment.from) * segment.stagger) : NaN;
              if (step === runStep) continue;
              if (runStep >= 0) {
                const range = new Range();
                range.setStart(node, runStart - start);
                range.setEnd(node, at - start);
                highlights[runStep]!.add(range);
              }
              runStart = at;
              runStep = step;
            }
          }
        }
      }
      if (live.size > 0 && frame === 0) frame = requestAnimationFrame((t) => paint(t));
    };

    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-reveal"] });
    // Containers already on screen count as seen: only what arrives from now fades.
    for (const container of root.querySelectorAll("[data-reveal]")) known.set(container, textLength(textNodes(container)));

    return () => {
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
      highlights.forEach((_, index) => registry.delete(`pi-reveal-${index}`));
    };
  }, [rootRef, enabled]);
}
