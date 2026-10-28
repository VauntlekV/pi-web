/**
 * Pure helpers for the composer: trigger detection, completion application,
 * command filtering and the labels/formatters shown in the toolbar.
 */
import type { CommandInfo, ImageContent, ThinkingLevel } from "../../../shared/protocol.ts";

export interface Trigger {
  kind: "slash" | "mention";
  /** The token text without its leading "/" or "@" */
  query: string;
  /** Index of the leading "/" or "@" */
  start: number;
  /** Index just past the token (the first whitespace or the end of the text) */
  end: number;
}

/** Whitespace as far as token boundaries are concerned, incl. the full-width space. */
export function isWhitespace(ch: string): boolean {
  return ch !== "" && /\s/u.test(ch);
}

function tokenEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && !isWhitespace(text[i])) i++;
  return i;
}

/**
 * Detect a slash-command or @-file trigger at the caret.
 *
 * Slash: the text starts with "/" and the caret sits inside the first token
 * (before its first whitespace). Mention: the caret sits inside a whitespace
 * delimited token whose first character is "@".
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const pos = Math.max(0, Math.min(caret, text.length));

  if (text.startsWith("/") && pos >= 1) {
    const firstWhitespace = tokenEnd(text, 0);
    if (pos <= firstWhitespace) {
      return { kind: "slash", query: text.slice(1, pos), start: 0, end: firstWhitespace };
    }
  }

  if (pos <= 0) return null;
  let start = pos;
  while (start > 0 && !isWhitespace(text[start - 1])) start--;
  if (text[start] !== "@" || start >= pos) return null;
  if (start > 0 && !isWhitespace(text[start - 1])) return null;

  return { kind: "mention", query: text.slice(start + 1, pos), start, end: tokenEnd(text, pos) };
}

/** Replace the trigger token, returning the new text and caret position. */
export function applyCompletion(
  text: string,
  trigger: Trigger,
  replacement: string,
): { text: string; caret: number } {
  return {
    text: text.slice(0, trigger.start) + replacement + text.slice(trigger.end),
    caret: trigger.start + replacement.length,
  };
}

/** What the box holds: the text plus the attached images. */
export interface Draft {
  text: string;
  images: ImageContent[];
}

/**
 * After onSubmit resolves, clear only the parts of the draft the user did not
 * change while the request was in flight. Images are compared by identity: a
 * new array means the user added, removed or reordered something.
 */
export function clearAfterSubmit(sent: Draft, current: Draft): Draft {
  return {
    text: current.text === sent.text ? "" : current.text,
    images: current.images === sent.images ? [] : current.images,
  };
}

/** Prefix matches first, then substring matches; case-insensitive, input order kept. */
export function filterCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase();
  const prefix: CommandInfo[] = [];
  const substring: CommandInfo[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(command);
    else if (name.includes(q)) substring.push(command);
  }
  return [...prefix, ...substring];
}

/** Thinking levels are shown by their English names, as pi itself and the providers call them. */
export function thinkingLabel(level: ThinkingLevel): string {
  return level;
}

/** 999 → "999", 5400 → "5.4K", 1_250_000 → "1.3M"; junk → "0". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  const rounded = Math.round(n);
  if (rounded < 1000) return String(rounded);
  const k = Math.round((rounded / 1000) * 10) / 10;
  if (k < 1000) return `${k}K`;
  const m = Math.round((rounded / 1_000_000) * 10) / 10;
  return `${m}M`;
}

/** "$0.12"; a positive amount that rounds to zero shows "<$0.01". */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  const rounded = usd.toFixed(2);
  return rounded === "0.00" ? "<$0.01" : `$${rounded}`;
}
