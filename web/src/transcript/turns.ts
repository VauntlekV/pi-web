/**
 * Pure turn analysis for the fold: what a turn's "process" steps are, where the
 * answer starts, how long the turn took and how the two fold rows are worded.
 * No React, no DOM — everything here is directly testable.
 */
import type {
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  ThinkingContent,
} from "../../../shared/protocol.ts";
import { firstLine } from "../app/text.ts";
import { relativizePath, truncate, type Turn } from "./lib.ts";
import type { ToolRuntime } from "./index.tsx";

export type StepKind = "thinking" | "text" | "tool" | "command" | "custom";
export type StepStatus = "running" | "done" | "error" | "none";

/** One row of the step list under a turn's second fold line. */
export interface Step {
  key: string;
  kind: StepKind;
  /** lucide-react icon name */
  icon: string;
  verb: string;
  target: string;
  /** Path inside cwd: the target opens the dock when clicked. */
  path?: string;
  /** Text after the path, e.g. an edit's diff stat. */
  suffix?: string;
  status: StepStatus;
  /** Tool steps */
  call?: ToolCallContent;
  result?: ToolResultMessage;
  runtime?: ToolRuntime;
  /** thinking / 说明 / custom body */
  text?: string;
  customType?: string;
  /** `!cmd` steps */
  command?: string;
  output?: string;
  exitCode?: number | undefined;
  cancelled?: boolean;
}

export interface TurnSplit {
  steps: Step[];
  /** Text blocks after the last tool call of the turn's last assistant message. */
  answer: TextContent[] | null;
  thinkingCount: number;
  toolCount: number;
  status: "running" | "done" | "error" | "aborted";
  durationMs: number | null;
}

export interface SplitTurnOptions {
  /** the agent run is active and this is the transcript's last turn */
  live?: boolean;
  /** the message being streamed, when the caller keeps it out of `turn.assistants` */
  streaming?: AssistantMessage | null;
  tools?: Record<string, ToolRuntime>;
  /** stepDisplay === "compact": thinking rows are dropped and not counted */
  thinking?: boolean;
  cwd?: string;
}

/** Split one turn into process steps, the answer and the fold's numbers. */
export function splitTurn(turn: Turn, options: SplitTurnOptions = {}): TurnSplit {
  const { live = false, tools = {}, thinking: showThinking = true, cwd } = options;
  const streaming = options.streaming ?? turn.streaming;
  const assistants =
    streaming && turn.assistants.at(-1) !== streaming ? [...turn.assistants, streaming] : turn.assistants;
  const last = assistants.at(-1);

  // The answer is what the last assistant message says after its last tool call.
  const answerBlocks = new Set<TextContent>();
  if (last) {
    const lastTool = last.content.findLastIndex((block) => block.type === "toolCall");
    last.content.forEach((block, index) => {
      if (block.type === "text" && index > lastTool && block.text.trim()) answerBlocks.add(block);
    });
  }
  const answer = answerBlocks.size > 0 ? [...answerBlocks] : null;

  const steps: Step[] = [];
  const entries = turn.items.map((item, index) => ({ key: item.entryId ?? `item-${index}`, message: item.message }));
  if (streaming && !entries.some((entry) => entry.message === streaming)) {
    entries.push({ key: "streaming", message: streaming });
  }
  entries.forEach(({ key, message }) => {
    if (message.role === "assistant") {
      message.content.forEach((block, blockIndex) => {
        const stepKey = `${key}:${blockIndex}`;
        if (block.type === "thinking") {
          if (!showThinking) return;
          const { target, text } = thinkingText(block);
          if (!text) return;
          steps.push({ key: stepKey, kind: "thinking", icon: "Brain", verb: "思考", target, status: "done", text });
        } else if (block.type === "text") {
          if (answerBlocks.has(block) || !block.text.trim()) return;
          steps.push({
            key: stepKey,
            kind: "text",
            icon: "MessageSquare",
            verb: "说明",
            target: firstLine(block.text, 60),
            status: "done",
            text: block.text,
          });
        } else {
          const runtime = tools[block.id];
          const result = turn.results[block.id];
          const status: StepStatus =
            runtime?.status ?? (result ? (result.isError ? "error" : "done") : live && message === last ? "running" : "none");
          steps.push({
            key: stepKey,
            kind: "tool",
            status,
            call: block,
            result,
            runtime,
            ...stepOf(block, cwd, result),
          });
        }
      });
      return;
    }

    if (message.role === "bashExecution") {
      steps.push(commandStep(key, message));
      return;
    }

    if (message.role === "custom" && message.display) {
      const text = customText(message);
      if (!text.trim()) return;
      steps.push({
        key,
        kind: "custom",
        icon: "Puzzle",
        verb: message.customType,
        target: firstLine(text, 60),
        status: "done",
        text,
        customType: message.customType,
      });
    }
  });

  const stamps = turn.items.map((item) => item.message.timestamp);
  if (streaming) stamps.push(streaming.timestamp);
  const end = stamps.length > 0 ? Math.max(...stamps) : null;
  const durationMs =
    turn.user && end !== null && Number.isFinite(end) ? Math.max(0, end - turn.user.timestamp) : null;

  let status: TurnSplit["status"] = "done";
  if (last?.stopReason === "error") status = "error";
  else if (last?.stopReason === "aborted") status = "aborted";
  else if (live) status = "running";

  return {
    steps,
    answer,
    thinkingCount: steps.filter((step) => step.kind === "thinking").length,
    toolCount: steps.filter((step) => step.kind === "tool").length,
    status,
    durationMs,
  };
}

function thinkingText(content: ThinkingContent): { target: string; text: string } {
  const text = content.thinking ?? "";
  if (text.trim()) return { target: firstLine(text, 60), text };
  // A redacted thought still earns a row; it has no readable text.
  return content.redacted ? { target: "思考内容已加密", text: "（思考内容已加密）" } : { target: "", text: "" };
}

function commandStep(key: string, message: BashExecutionMessage): Step {
  const failed = !message.cancelled && message.exitCode !== undefined && message.exitCode !== 0;
  return {
    key,
    kind: "command",
    icon: "SquareTerminal",
    verb: "用户命令",
    target: truncate(message.command.split("\n")[0] ?? "", 80),
    status: message.cancelled ? "none" : failed ? "error" : "done",
    command: message.command,
    output: message.output,
    exitCode: message.exitCode,
    cancelled: message.cancelled,
  };
}

/** Text of a custom message (string or text blocks). */
export function customText(message: CustomMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}

/** The relative path a step's target opens in the dock, or null when it is outside cwd. */
export function dockPath(path: string | undefined, cwd?: string): string | null {
  if (!path || path.startsWith("~")) return null;
  if (!path.startsWith("/")) return path.replace(/^\.\//, "");
  if (!cwd) return null;
  const relative = relativizePath(path, cwd);
  return relative.startsWith("/") ? null : relative;
}

/** Step icon, verb and target for one tool call (the v2 step table). */
export function stepOf(
  call: ToolCallContent,
  cwd?: string,
  result?: ToolResultMessage,
): Pick<Step, "icon" | "verb" | "target" | "path" | "suffix"> {
  const args = call.arguments ?? {};
  const string = (key: string): string | undefined =>
    typeof args[key] === "string" ? (args[key] as string) : undefined;

  switch (call.name) {
    case "bash": {
      const command = string("command") ?? "";
      return { icon: "SquareTerminal", verb: "运行命令", target: truncate(command.split("\n")[0] ?? "", 80) };
    }
    case "read": {
      const path = string("path") ?? "";
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let range = "";
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        range = limit !== undefined ? ` L${start}-${start + limit - 1}` : ` L${start}`;
      }
      const dock = dockPath(path, cwd);
      return {
        icon: "FileText",
        verb: "读取",
        target: relativizePath(path, cwd) + range,
        path: dock ?? undefined,
      };
    }
    case "edit": {
      const path = string("path") ?? "";
      const diff = diffOf(result);
      return {
        icon: "FilePen",
        verb: "编辑",
        target: relativizePath(path, cwd),
        path: dockPath(path, cwd) ?? undefined,
        suffix: diff ? `+${diff.added} −${diff.removed}` : undefined,
      };
    }
    case "write": {
      const path = string("path") ?? "";
      return {
        icon: "FilePlus",
        verb: "写入",
        target: relativizePath(path, cwd),
        path: dockPath(path, cwd) ?? undefined,
      };
    }
    case "grep":
      return { icon: "Search", verb: "搜索", target: truncate(string("pattern") ?? "", 80) };
    case "find":
    case "glob":
      return { icon: "FolderSearch", verb: "查找文件", target: truncate(string("pattern") ?? "", 80) };
    case "ls": {
      const path = string("path") ?? ".";
      return {
        icon: "FolderOpen",
        verb: "列出",
        target: relativizePath(path, cwd),
        path: dockPath(path, cwd) ?? undefined,
      };
    }
    case "ask_user_question":
      return { icon: "MessageCircleQuestion", verb: "提问", target: truncate(firstQuestion(args), 60) };
    default:
      return { icon: "Wrench", verb: call.name, target: truncate(firstString(args) ?? "", 60) };
  }
}

function firstQuestion(args: Record<string, unknown>): string {
  const questions = args.questions;
  if (Array.isArray(questions)) {
    for (const entry of questions) {
      if (entry && typeof entry === "object") {
        const question = (entry as { question?: unknown }).question;
        if (typeof question === "string") return question;
      }
    }
  }
  return typeof args.question === "string" ? args.question : "";
}

function firstString(args: Record<string, unknown>): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function diffOf(result: ToolResultMessage | undefined): { added: number; removed: number } | null {
  const details = result?.details;
  if (!details || typeof details !== "object") return null;
  const diff = (details as { diff?: unknown }).diff;
  if (typeof diff !== "string") return null;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** "已完成，用时 2秒" / "用时 2分5秒"; 0 and rubbish read as "<1秒". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return "<1秒";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}秒`;
  return `${Math.floor(total / 60)}分${total % 60}秒`;
}

/** The second fold line: "执行 X 次思考，调用 Y 次工具" (each part dropped at 0). */
export function foldSummary(thinking: number, tools: number, steps: number): string {
  const parts: string[] = [];
  if (thinking > 0) parts.push(`执行 ${thinking} 次思考`);
  if (tools > 0) parts.push(`调用 ${tools} 次工具`);
  if (parts.length === 0) return `${steps} 个步骤`;
  return parts.join("，");
}

/** The outer fold line's wording for the current state of a turn. */
export function foldHeadText(split: TurnSplit, options: { live: boolean; workingMessage?: string }): string {
  if (split.status === "error") return durationSentence("出错了", split.durationMs);
  if (split.status === "aborted") return durationSentence("已中断", split.durationMs);
  if (options.live) return runningLabel(split.steps, options.workingMessage);
  return durationSentence("已完成", split.durationMs);
}

function durationSentence(lead: string, durationMs: number | null): string {
  return durationMs === null ? lead : `${lead}，用时 ${formatDuration(durationMs)}`;
}

/**
 * The status line's wording (设置 › 动效 › 状态行动画). Precise names the
 * step in flight — 「正在读取 turns.ts」 — while bare keeps to the state alone:
 * 正在思考 / 正在写回答 / 正在调用工具. An extension's working message wins.
 */
export function statusWords(steps: Step[], precise: boolean, workingMessage?: string, answering = false): string {
  if (workingMessage) return workingMessage;
  if (answering) return "正在写回答";
  const last = steps.at(-1);
  if (!last || last.kind === "thinking") return "正在思考";
  if (last.kind === "text") return "正在写回答";
  if (!precise) return last.status === "running" ? "正在调用工具" : "正在思考";
  if (last.status !== "running") return "正在思考";
  const target = last.path ? (last.path.split("/").filter(Boolean).at(-1) ?? last.path) : firstLine(last.target).trim();
  return target ? `正在${last.verb} ${truncate(target, 48)}` : `正在${last.verb}`;
}

/** "正在运行命令 · npm test" for the step in flight, "正在思考…" when there is none. */
export function runningLabel(steps: Step[], workingMessage?: string): string {
  if (workingMessage) return workingMessage;
  const last = steps.at(-1);
  if (!last || last.kind === "thinking") return "正在思考…";
  if (last.kind === "text") return "正在输出…";
  const target = last.target.trim();
  return target ? `正在${last.verb} · ${target}` : `正在${last.verb}…`;
}
