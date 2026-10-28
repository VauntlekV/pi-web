/**
 * The live turn's status line (设置 › 动效 › 状态行动画), after
 * dsh-claude-style's chat-wait: a three-dot loader, the wording of what the
 * turn is doing now, and a quiet elapsed clock. A change of wording swaps:
 * the old words leave upward through a blur while the new ones rise in. The
 * words wear the paint picked in settings — a highlight band sweeping across
 * them, or a colour wash — which <html data-status-paint> selects in CSS.
 */
import { useEffect, useRef, useState } from "react";
import { formatDuration } from "./turns.ts";

export function StatusLine({ words, startedAt }: { words: string; startedAt: number | null }) {
  return (
    <span className="status-line is-live">
      <StatusLoader />
      <SwapWords text={words} />
      <StatusClock startedAt={startedAt} />
    </span>
  );
}

export function StatusLoader() {
  return (
    <span className="status-loader" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

/** Words that swap with the leave/rise motion whenever `text` changes. */
export function SwapWords({ text, className }: { text: string; className?: string }) {
  const [shown, setShown] = useState({ text, leaving: null as string | null, turn: 0 });
  const timer = useRef(0);

  useEffect(() => {
    if (text === shown.text) return;
    setShown((prev) => ({ text, leaving: prev.text, turn: prev.turn + 1 }));
    window.clearTimeout(timer.current);
    // The leaving copy is dropped once its half of the swap has run.
    timer.current = window.setTimeout(() => setShown((prev) => ({ ...prev, leaving: null })), 260);
  }, [text, shown.text]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <span className={className ? `swap-words ${className}` : "swap-words"} aria-live="polite">
      {shown.leaving !== null && (
        <span key={`out-${shown.turn}`} className="swap-leave" aria-hidden="true">
          {shown.leaving}
        </span>
      )}
      <span key={`in-${shown.turn}`} className={shown.turn > 0 ? "swap-current swap-enter" : "swap-current"}>
        <span className="status-paint" data-text={shown.text}>
          {shown.text}
        </span>
      </span>
    </span>
  );
}

function StatusClock({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  const [mounted] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsed = now - (startedAt ?? mounted);
  if (elapsed < 1000) return null;
  return <span className="status-clock">{formatDuration(elapsed)}</span>;
}
