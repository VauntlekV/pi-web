/**
 * Pure helpers for the transcript renderer: turn grouping, tool labels, path
 * display, ANSI stripping, diff stats and token/time formatting.
 *
 * Nothing here touches React or the DOM, so everything is directly testable.
 */
import type {
  AssistantMessage,
  ToolCallContent,
  ToolResultMessage,
  TranscriptItem,
  UserMessage,
} from "../../../shared/protocol.ts";

/** One conversation turn: a user message plus everything the assistant did after it. */
export interface Turn {
  /** Stable React key (the opening user entry id, or a synthetic one). */
  key: string;
  /** The message that opened the turn; `null` when the transcript starts mid-turn. */
  user: UserMessage | null;
  /** Non-user items in transcript order (assistant, toolResult, bashExecution, custom, summaries). */
  items: TranscriptItem[];
  /** Tool results of this turn, keyed by toolCallId. */
  results: Record<string, ToolResultMessage>;
  /** Assistant messages of this turn, in order (the streaming message included). */
  assistants: AssistantMessage[];
  /** toolCallId of every tool call in this turn. */
  toolIds: string[];
  /** The live message, when this is the streaming turn. */
  streaming: AssistantMessage | null;
}

/** Split a transcript into turns. Each user message opens a new turn. */
export function groupTurns(items: TranscriptItem[], streaming: AssistantMessage | null): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;

  const open = (key: string, user: UserMessage | null): Turn => {
    const turn: Turn = { key, user, items: [], results: {}, assistants: [], toolIds: [], streaming: null };
    turns.push(turn);
    return turn;
  };

  const absorbAssistant = (turn: Turn, message: AssistantMessage) => {
    turn.assistants.push(message);
    for (const block of message.content) {
      if (block.type === "toolCall") turn.toolIds.push(block.id);
    }
  };

  items.forEach((item, index) => {
    const message = item.message;
    if (message.role === "user") {
      current = open(item.entryId ?? `user-${index}`, message);
      return;
    }
    if (!current) current = open(item.entryId ?? `turn-${index}`, null);
    current.items.push(item);
    if (message.role === "assistant") absorbAssistant(current, message);
    else if (message.role === "toolResult") current.results[message.toolCallId] = message;
  });

  if (streaming) {
    if (!current) current = open("streaming", null);
    current.streaming = streaming;
    absorbAssistant(current, streaming);
  }

  return turns;
}

/** Ids of the tool calls in one assistant message. */
export function toolCallIds(message: AssistantMessage | null | undefined): string[] {
  if (!message) return [];
  return message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}

/** First `max` code points of `s`, with an ellipsis; never splits a surrogate pair. */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
}

/** Show an absolute path relative to `cwd`; paths outside it stay absolute. */
export function relativizePath(path: string, cwd?: string): string {
  if (!cwd || !path.startsWith("/")) return path;
  const base = cwd === "/" ? "/" : cwd.replace(/\/+$/, "");
  if (base === "/") return path === "/" ? "/" : path.slice(1);
  if (path === base) return ".";
  const prefix = `${base}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

const ANSI =
  // OSC (title, hyperlinks), terminated by BEL, ST or 0x9C, then CSI sequences.
  /\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/** Remove ANSI escape sequences (colours, 256-colour, OSC titles/links). */
export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** Added/removed line counts of a unified-ish diff; file headers do not count. */
export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Compact token count: 999 → "999", 5400 → "5.4K", 1_250_000 → "1.3M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const scale = n < 1_000_000 ? 1000 : 1_000_000;
  const fixed = (n / scale).toFixed(1);
  return (fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed) + (scale === 1000 ? "K" : "M");
}

/**
 * Text of the working indicator below the transcript, or null when it should
 * not be shown. A live thinking block already says "思考中…" with the shimmer,
 * so the default line is suppressed then; extension text and running tools win.
 */
export function indicatorText(options: {
  running: boolean;
  streaming: AssistantMessage | null;
  workingMessage?: string;
  runningTool?: string;
}): string | null {
  if (!options.running) return null;
  if (options.workingMessage) return options.workingMessage;
  if (options.runningTool) return `正在运行 ${options.runningTool}…`;
  const last = options.streaming?.content.at(-1);
  return last?.type === "thinking" ? null : "思考中…";
}

/** Local wall-clock time, HH:mm. */
export function formatClock(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** All assistant text of a turn, blocks joined by a blank line (the copy target). */
export function turnText(turn: Turn): string {
  const blocks: string[] = [];
  for (const message of turn.assistants) {
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) blocks.push(block.text.trim());
    }
  }
  return blocks.join("\n\n");
}

/** One-line label for a tool call row. `icon` is a lucide-react icon name. */
export function toolSummary(
  call: ToolCallContent,
  cwd?: string,
): { icon: string; verb: string; target: string } {
  const args = call.arguments ?? {};
  const stringArg = (key: string): string | undefined =>
    typeof args[key] === "string" ? (args[key] as string) : undefined;

  switch (call.name) {
    case "bash": {
      const command = stringArg("command") ?? "";
      return { icon: "Terminal", verb: "Bash", target: truncate(command.split("\n")[0] ?? "", 80) };
    }
    case "read": {
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let range = "";
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        range = limit !== undefined ? ` L${start}-${start + limit - 1}` : ` L${start}`;
      }
      return { icon: "FileText", verb: "读取", target: relativizePath(stringArg("path") ?? "", cwd) + range };
    }
    case "edit":
      return { icon: "FilePen", verb: "编辑", target: relativizePath(stringArg("path") ?? "", cwd) };
    case "write": {
      const content = stringArg("content") ?? "";
      const lines = content ? content.split("\n").length : 0;
      return {
        icon: "FilePlus",
        verb: "写入",
        target: `${relativizePath(stringArg("path") ?? "", cwd)} ${lines} 行`,
      };
    }
    case "ls":
      return { icon: "FolderSearch", verb: "列出", target: relativizePath(stringArg("path") ?? ".", cwd) };
    case "find":
      return { icon: "Search", verb: "查找", target: truncate(stringArg("pattern") ?? "", 80) };
    case "grep":
      return { icon: "Search", verb: "搜索", target: truncate(stringArg("pattern") ?? "", 80) };
    default:
      return { icon: "Wrench", verb: call.name, target: truncate(firstString(args) ?? "", 60) };
  }
}

function firstString(args: Record<string, unknown>): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  rb: "ruby",
  php: "php",
  kt: "kotlin",
  swift: "swift",
  cs: "csharp",
  lua: "lua",
  diff: "diff",
  patch: "diff",
};

/** highlight.js language name guessed from a file path's extension. */
export function guessLanguage(path: string): string | undefined {
  const name = path.split(/[\\/]/).pop() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXT_LANGUAGE[ext];
}

/** The subset of hast the highlight guard touches (keeps lib free of hast types). */
export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Highlighting cost grows with block size; longer blocks are shown unhighlighted. */
export const MAX_HIGHLIGHT_LINES = 2000;

function hastText(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

/**
 * Rehype plugin that runs before rehype-highlight: drops the `language-*` class
 * of code blocks longer than MAX_HIGHLIGHT_LINES, which makes them render plain.
 */
export function limitHighlight() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.tagName === "pre") {
        const code = node.children?.find((child) => child.tagName === "code");
        const classes = code?.properties?.className;
        if (code && Array.isArray(classes) && hastText(code).split("\n").length > MAX_HIGHLIGHT_LINES) {
          code.properties!.className = classes.filter((name) => !String(name).startsWith("language-"));
        }
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}
