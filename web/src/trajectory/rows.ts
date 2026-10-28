/**
 * Pure row model of the 轨迹 (trajectory) view: every transcript entry as one
 * flat record, plus the three-lane timeline bands computed from the records'
 * timestamps. No React, no DOM.
 */
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  TranscriptItem,
} from "../../../shared/protocol.ts";
import { firstLine } from "../app/text.ts";
import { stripAnsi } from "../transcript/lib.ts";

export type RowRole = "user" | "assistant" | "tool" | "thinking" | "command" | "summary";
export type RowFilter = "all" | "message" | "tool";

export interface Row {
  key: string;
  /** 0-based turn this record belongs to */
  turn: number;
  role: RowRole;
  /** badge text: 用户 / 助手 / 工具 / 思考 / 命令 / 摘要 */
  badge: string;
  /** one-line content shown in the row (searchable) */
  text: string;
  /** full content, shown when the row is expanded (capped) */
  detail: string;
  timestamp: number;
  /** which segment of the view a row belongs to */
  kind: "message" | "tool";
  /** tool rows: call name, compact arguments, first line of the result */
  tool?: { name: string; args: string; result: string };
  isError?: boolean;
}

/** Detail bodies are capped: a trajectory row is a record, not a viewer. */
export const MAX_DETAIL = 20_000;

const BADGES: Record<RowRole, string> = {
  user: "用户",
  assistant: "助手",
  tool: "工具",
  thinking: "思考",
  command: "命令",
  summary: "摘要",
};

/** One row per record: user/assistant/thinking/command/summary messages and tool calls. */
export function buildRows(items: TranscriptItem[], streaming: AssistantMessage | null): Row[] {
  const results = new Map<string, ToolResultMessage>();
  for (const item of items) {
    if (item.message.role === "toolResult") results.set(item.message.toolCallId, item.message);
  }

  const rows: Row[] = [];
  let turn = 0;
  let seenUser = false;

  const row = (row: Omit<Row, "badge">): void => {
    rows.push({ ...row, badge: BADGES[row.role], text: row.text, detail: clip(row.detail) });
  };

  const addAssistant = (message: AssistantMessage, keyPrefix: string): void => {
    message.content.forEach((block, index) => {
      const key = `${keyPrefix}:${index}`;
      const timestamp = message.timestamp;
      if (block.type === "thinking") {
        const text = block.thinking ?? "";
        if (!text.trim() && !block.redacted) return;
        row({
          key,
          turn,
          role: "thinking",
          text: firstLine(text, 200) || "（思考内容已加密）",
          detail: text.trim() ? text : "（思考内容已加密）",
          timestamp,
          kind: "message",
        });
        return;
      }
      if (block.type === "text") {
        if (!block.text.trim()) return;
        row({ key, turn, role: "assistant", text: firstLine(block.text, 200), detail: block.text, timestamp, kind: "message" });
        return;
      }
      const result = results.get(block.id);
      const args = compactArgs(block.arguments);
      const output = result ? contentText(result.content) : "";
      const resultLine = firstLine(stripAnsi(output), 200);
      row({
        key,
        turn,
        role: "tool",
        text: `${block.name} ${args}${resultLine ? ` → ${resultLine}` : ""}`,
        detail: `${block.name} ${JSON.stringify(block.arguments ?? {}, null, 2)}${output ? `\n\n${stripAnsi(output)}` : ""}`,
        timestamp,
        kind: "tool",
        tool: { name: block.name, args, result: resultLine },
        isError: result?.isError,
      });
    });
  };

  items.forEach((item, index) => {
    const message = item.message;
    const key = item.entryId ?? `row-${index}`;
    switch (message.role) {
      case "user": {
        if (seenUser) turn++;
        seenUser = true;
        const text = messageText(message.content);
        row({ key, turn, role: "user", text: firstLine(text, 200), detail: text, timestamp: message.timestamp, kind: "message" });
        return;
      }
      case "assistant":
        addAssistant(message, key);
        return;
      case "bashExecution": {
        const command = stripAnsi(message.command);
        row({
          key,
          turn,
          role: "command",
          text: firstLine(command, 200),
          detail: `$ ${command}${message.output ? `\n\n${stripAnsi(message.output)}` : ""}`,
          timestamp: message.timestamp,
          kind: "tool",
        });
        return;
      }
      case "custom": {
        if (!message.display) return;
        const text = messageText(message.content);
        row({
          key,
          turn,
          role: "summary",
          text: `${message.customType} ${firstLine(text, 160)}`.trim(),
          detail: text,
          timestamp: message.timestamp,
          kind: "message",
        });
        return;
      }
      case "compactionSummary": {
        row({
          key,
          turn,
          role: "summary",
          text: `已压缩上下文 · 压缩前 ${message.tokensBefore} tok`,
          detail: message.summary,
          timestamp: message.timestamp,
          kind: "message",
        });
        return;
      }
      case "branchSummary": {
        row({ key, turn, role: "summary", text: "分支摘要", detail: message.summary, timestamp: message.timestamp, kind: "message" });
        return;
      }
      default:
        // Tool results live on their tool's row.
        return;
    }
  });

  if (streaming) addAssistant(streaming, "streaming");

  return rows;
}

/** Apply the segment filter and the case-insensitive substring search. */
export function filterRows(rows: Row[], filter: RowFilter, query: string): Row[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter !== "all" && row.kind !== filter) return false;
    if (!needle) return true;
    return row.text.toLowerCase().includes(needle);
  });
}

/** One segment of the timeline strip: percentages along the session's time span. */
export interface Band {
  id: string;
  /** 输入 / 模型 / 工具 */
  lane: 0 | 1 | 2;
  left: number;
  width: number;
}

/** Width of the narrowest band, in percent of the strip (about 2px on a 744px column). */
const MIN_BAND = 0.3;

/** Lay every record on its lane; each segment runs until the next record in time. */
export function buildBands(rows: Row[]): Band[] {
  if (rows.length === 0) return [];
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.timestamp - b.row.timestamp || a.index - b.index);
  const start = ordered[0]!.row.timestamp;
  const end = ordered[ordered.length - 1]!.row.timestamp;
  const span = end - start;

  return ordered.map((entry, position) => {
    const lane = laneOf(entry.row);
    if (span <= 0) {
      const width = 100 / ordered.length;
      return { id: entry.row.key, lane, left: position * width, width };
    }
    const next = ordered[position + 1]?.row.timestamp ?? end;
    const width = Math.max(MIN_BAND, ((next - entry.row.timestamp) / span) * 100);
    // The last record ends level with the strip: keep its minimum width inside the track.
    return {
      id: entry.row.key,
      lane,
      left: Math.min(((entry.row.timestamp - start) / span) * 100, 100 - width),
      width,
    };
  });
}

function laneOf(row: Row): 0 | 1 | 2 {
  if (row.role === "assistant" || row.role === "thinking") return 1;
  if (row.role === "tool" || row.role === "command") return 2;
  return 0;
}

/** Compact one-line arguments: JSON without spaces, cut for the row. */
export function compactArgs(args: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(args ?? {});
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

function messageText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

function contentText(content: (TextContent | ImageContent)[] | undefined): string {
  if (!content) return "";
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function clip(text: string): string {
  return text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) : text;
}
