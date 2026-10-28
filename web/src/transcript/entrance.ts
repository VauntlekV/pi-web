/**
 * 消息气泡动画 — the entrance of a message the reader just sent.
 *
 * The composer notes the send (and where its text box was) right before the
 * prompt goes out; the next user bubble the transcript mounts within a short
 * window takes that note and plays the chosen entrance: `grow` scales the
 * bubble up from its bottom-right corner in place, `flight` flies it from the
 * composer up into its row. Bubbles mounted for any other reason (opening a
 * session, history) find no note and simply appear.
 */
import { motionReduced, prefsStore } from "../app/prefs.ts";

/** How long a noted send waits for its bubble (the echo usually lands in well under a second). */
const NOTE_TTL_MS = 15_000;
const FLIGHT_MS = 400;

let pending: { at: number; from: DOMRect | null } | null = null;

export function noteSent(from: DOMRect | null): void {
  pending = { at: Date.now(), from };
}

/** Play the entrance on a freshly mounted bubble if a send is waiting for one. */
export function playEntrance(bubble: HTMLElement): void {
  const note = pending;
  if (!note || Date.now() - note.at > NOTE_TTL_MS) return;
  pending = null;
  const prefs = prefsStore.get();
  if (!prefs.messageEnter || motionReduced()) return;

  if (prefs.messageEnterStyle === "flight" && note.from && typeof bubble.animate === "function") {
    const from = note.from;
    // Measure after the conversation has scrolled the new row into place.
    bubble.style.opacity = "0";
    requestAnimationFrame(() => {
      bubble.style.opacity = "";
      const to = bubble.getBoundingClientRect();
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      bubble.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.5 },
          { transform: "none", opacity: 1 },
        ],
        { duration: FLIGHT_MS, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)" },
      );
    });
    return;
  }

  bubble.classList.add("enter-grow");
  bubble.addEventListener("animationend", () => bubble.classList.remove("enter-grow"), { once: true });
}
