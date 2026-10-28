/**
 * Transcript — renders a session's conversation (no scrolling, no composer).
 * The parent owns the scroll container and the follow-to-bottom behaviour.
 *
 * v2 layout: one user bubble per turn, then a two-level fold around the turn's
 * process (fold row → counted summary → step list), then the answer and the
 * footer. TurnNav draws the right-edge rail next to the same scroll container.
 *
 * CONTRACT: the exported names and prop types below are used by the app shell.
 * Implementations may add optional props but must not change these.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Brain,
  ChevronDown,
  ChevronUp,
  FilePen,
  FilePlus,
  FileText,
  FolderOpen,
  FolderSearch,
  Loader2,
  MessageCircleQuestion,
  MessageSquare,
  Puzzle,
  Search,
  SquareChevronRight,
  SquareTerminal,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  TranscriptItem,
  UserMessage,
} from "../../../shared/protocol.ts";
import { firstLine } from "../app/text.ts";
import { usePrefs, type Prefs } from "../app/prefs.ts";
import { dock } from "../dock/store.ts";
import { formatClock, formatTokens, groupTurns, stripAnsi, turnText, type Turn } from "./lib.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolDetail } from "./ToolCard.tsx";
import { CopyButton, ImageThumb } from "./ui.tsx";
import { playEntrance } from "./entrance.ts";
import { StatusLine } from "./status-line.tsx";
import { foldHeadText, foldSummary, splitTurn, statusWords, type Step, type TurnSplit } from "./turns.ts";
import "./transcript.css";

/** Live state of a tool call, keyed by toolCallId; only present for calls seen live. */
export interface ToolRuntime {
  status: "running" | "done" | "error";
  /** Latest streamed partial result (e.g. bash output so far) */
  partial?: { content: (TextContent | ImageContent)[]; details?: unknown };
  durationMs?: number;
}

export interface TranscriptProps {
  items: TranscriptItem[];
  /** The assistant message being streamed, if any */
  streaming: AssistantMessage | null;
  tools: Record<string, ToolRuntime>;
  /** The agent run is active (the last turn's fold row shows its live state) */
  running: boolean;
  /** Extension-provided working text, shown in the fold row instead of the step */
  workingMessage?: string;
  /** Session cwd, used to show paths relative to it and to open files in the dock */
  cwd?: string;
  /** Open a step's path; defaults to the right dock */
  onOpenPath?: (path: string) => void;
}

/**
 * TurnNav — the right-edge turn navigator: one tick per user turn, the current
 * turn's tick longer/darker; hovering shows a list of the turns' prompts;
 * clicking scrolls to that turn.
 *
 * CONTRACT: Transcript renders each turn's root element with
 * `data-turn-index="<n>"` (0-based, in order). The shell renders <TurnNav/>
 * absolutely positioned at the right edge of the conversation column and passes
 * the scroll container element.
 */
export interface TurnNavProps {
  items: TranscriptItem[];
  /** the conversation's scroll container (null until mounted) */
  scrollRoot: HTMLElement | null;
}

const STEP_ICONS: Record<string, LucideIcon> = {
  Brain,
  MessageSquare,
  SquareTerminal,
  FileText,
  FilePen,
  FilePlus,
  Search,
  FolderSearch,
  FolderOpen,
  MessageCircleQuestion,
  Puzzle,
  Wrench,
};

export function Transcript({
  items,
  streaming,
  tools,
  running,
  workingMessage,
  cwd,
  onOpenPath,
}: TranscriptProps) {
  const prefs = usePrefs();
  // Grouping depends on the settled items only; the streaming message is handed
  // to the last turn separately, so stream updates do not rebuild earlier turns.
  const turns = useMemo(() => groupTurns(items, null), [items]);
  const shown = turns.length === 0 && streaming ? [EMPTY_TURN] : turns;
  const lastIndex = shown.length - 1;

  return (
    <div className="transcript">
      {shown.map((turn, index) => (
        <TurnView
          key={turn.key}
          index={index}
          turn={turn}
          streaming={index === lastIndex ? streaming : null}
          live={running && index === lastIndex}
          tools={tools}
          prefs={prefs}
          running={running}
          workingMessage={workingMessage}
          cwd={cwd}
          onOpenPath={onOpenPath}
          isLast={index === lastIndex}
        />
      ))}
    </div>
  );
}

const EMPTY_TURN: Turn = {
  key: "streaming",
  user: null,
  items: [],
  results: {},
  assistants: [],
  toolIds: [],
  streaming: null,
};

interface TurnViewProps {
  index: number;
  turn: Turn;
  streaming: AssistantMessage | null;
  live: boolean;
  tools: Record<string, ToolRuntime>;
  prefs: Prefs;
  running: boolean;
  workingMessage?: string;
  cwd?: string;
  onOpenPath?: (path: string) => void;
  isLast: boolean;
}

function TurnViewImpl({
  index,
  turn,
  streaming,
  live,
  tools,
  prefs,
  workingMessage,
  cwd,
  onOpenPath,
}: TurnViewProps) {
  const split = useMemo(
    () =>
      splitTurn(turn, {
        live,
        streaming,
        tools,
        cwd,
        thinking: prefs.stepDisplay === "detailed",
      }),
    [turn, live, streaming, tools, cwd, prefs.stepDisplay],
  );
  const openPath = useMemo(() => onOpenPath ?? ((path: string) => dock.openFile(path)), [onOpenPath]);
  const summaries = turn.items.filter(
    (item) => item.message.role === "compactionSummary" || item.message.role === "branchSummary",
  );
  const last = turn.assistants.at(-1) ?? streaming ?? undefined;

  return (
    <section className="turn" data-turn-index={index}>
      {turn.user ? <UserMessageView message={turn.user} /> : null}
      {summaries.map((item, position) => {
        const message = item.message;
        if (message.role === "compactionSummary") {
          return (
            <SummaryDivider
              key={item.entryId ?? position}
              label={`已压缩上下文 · 压缩前 ${formatTokens(message.tokensBefore)} tok`}
              text={message.summary}
            />
          );
        }
        if (message.role === "branchSummary") {
          return <SummaryDivider key={item.entryId ?? position} label="分支摘要" text={message.summary} />;
        }
        return null;
      })}
      <Fold
        split={split}
        live={live}
        workingMessage={workingMessage}
        cwd={cwd}
        onOpenPath={openPath}
        mode={prefs.stepCollapse}
        status={prefs.statusLine ? { precise: prefs.statusDetail, startedAt: turn.user?.timestamp ?? null } : null}
      />
      {split.answer ? (
        <div className="answer" data-reveal={live ? "" : undefined}>
          <Markdown text={split.answer.map((block) => block.text).join("\n\n")} />
        </div>
      ) : null}
      {split.status === "error" ? (
        <div className="msg-error" role="alert">
          <AlertCircle size={14} strokeWidth={1.75} aria-hidden />
          <span>{last?.errorMessage || "请求失败"}</span>
        </div>
      ) : null}
      {split.status === "aborted" ? <div className="msg-aborted">已中断</div> : null}
      {!live && turn.assistants.length > 0 ? <TurnFooter split={split} turn={turn} /> : null}
    </section>
  );
}

function sameTurnProps(prev: TurnViewProps, next: TurnViewProps): boolean {
  if (
    prev.turn !== next.turn ||
    prev.cwd !== next.cwd ||
    prev.running !== next.running ||
    prev.isLast !== next.isLast ||
    prev.streaming !== next.streaming ||
    prev.workingMessage !== next.workingMessage ||
    prev.prefs !== next.prefs ||
    prev.onOpenPath !== next.onOpenPath ||
    prev.index !== next.index
  ) {
    return false;
  }
  if (prev.tools === next.tools) return true;
  // Only tool state this turn actually shows may keep it from re-rendering.
  const ids = prev.turn.toolIds.concat(toolIdsOf(prev.streaming));
  return ids.every((id) => prev.tools[id] === next.tools[id]);
}

/** Ids of the tool calls in one assistant message. */
function toolIdsOf(message: AssistantMessage | null): string[] {
  if (!message) return [];
  return message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
}

const TurnView = memo(TurnViewImpl, sameTurnProps);

function UserMessageView({ message }: { message: UserMessage }) {
  const parts: (TextContent | ImageContent)[] =
    typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  const text = parts
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const images = parts.filter((part): part is ImageContent => part.type === "image");
  const bubbleRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (bubbleRef.current) playEntrance(bubbleRef.current);
  }, []);

  return (
    <div className="user-row">
      <div className="user-bubble" ref={bubbleRef}>
        {text ? <div className="user-text">{text}</div> : null}
        {images.length > 0 ? (
          <div className="user-images">
            {images.map((image, index) => (
              <ImageThumb key={index} image={image} alt={`消息图片 ${index + 1}`} />
            ))}
          </div>
        ) : null}
      </div>
      <div className="user-meta">
        <span>{formatClock(message.timestamp)}</span>
        <CopyButton text={text} label="复制消息" />
      </div>
    </div>
  );
}

/** The two fold levels around a turn's process, and the step list under them. */
function Fold({
  split,
  live,
  workingMessage,
  cwd,
  onOpenPath,
  mode,
  status,
}: {
  split: TurnSplit;
  live: boolean;
  workingMessage?: string;
  cwd?: string;
  onOpenPath: (path: string) => void;
  mode: Prefs["stepCollapse"];
  /** The animated status line while live (null = the plain running label). */
  status: { precise: boolean; startedAt: number | null } | null;
}) {
  // null = follow the collapse rule; true/false = the reader has decided.
  const [outerManual, setOuterManual] = useState<boolean | null>(null);
  const [innerManual, setInnerManual] = useState<boolean | null>(null);

  const auto = mode === "never" ? true : mode === "always" ? false : live && !split.answer;
  const outerOpen = outerManual ?? auto;
  const innerOpen = innerManual ?? auto;
  const showHead = split.steps.length > 0 || (live && !split.answer);

  if (!showHead) return null;

  return (
    <div className="fold">
      <button
        type="button"
        className="fold-head"
        aria-expanded={outerOpen}
        onClick={() => setOuterManual(!outerOpen)}
      >
        {live && status ? (
          <StatusLine
            words={statusWords(split.steps, status.precise, workingMessage, Boolean(split.answer))}
            startedAt={status.startedAt}
          />
        ) : (
          <span>{foldHeadText(split, { live, workingMessage })}</span>
        )}
        {outerOpen ? (
          <ChevronUp size={13} strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
        )}
      </button>
      <div className="fold-rule" aria-hidden />
      {outerOpen && split.steps.length > 0 ? (
        <>
          <button
            type="button"
            className="fold-steps"
            aria-expanded={innerOpen}
            onClick={() => setInnerManual(!innerOpen)}
          >
            {innerOpen ? (
              <Terminal size={14} strokeWidth={1.75} aria-hidden />
            ) : (
              <SquareChevronRight size={14} strokeWidth={1.75} aria-hidden />
            )}
            <span>{foldSummary(split.thinkingCount, split.toolCount, split.steps.length)}</span>
          </button>
          {innerOpen ? (
            <ul className="step-list">
              {split.steps.map((step) => (
                <StepRow key={step.key} step={step} cwd={cwd} onOpenPath={onOpenPath} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function StepRow({ step, cwd, onOpenPath }: { step: Step; cwd?: string; onOpenPath: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICONS[step.icon] ?? Wrench;

  return (
    <li className={`step${open ? " is-open" : ""}`}>
      <div
        className="step-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={step.target}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        <Icon size={14} strokeWidth={1.75} className="step-icon" aria-hidden />
        <span className="step-verb">{step.verb}</span>
        <span className="step-sep" aria-hidden>
          ·
        </span>
        {step.path ? (
          <button
            type="button"
            className="step-path"
            title={`在右侧打开 ${step.path}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenPath(step.path!);
            }}
          >
            {step.target}
          </button>
        ) : (
          <span className="step-target">{step.target}</span>
        )}
        {step.suffix ? <span className="step-suffix">{step.suffix}</span> : null}
        <span className="step-status">
          {step.status === "running" ? (
            <Loader2 size={14} strokeWidth={1.75} className="spin" aria-label="运行中" />
          ) : null}
          {step.status === "error" ? <X size={14} strokeWidth={1.75} className="step-error" aria-label="失败" /> : null}
        </span>
      </div>
      {open ? <StepDetail step={step} cwd={cwd} onOpenPath={onOpenPath} /> : null}
    </li>
  );
}

function StepDetail({ step, cwd, onOpenPath }: { step: Step; cwd?: string; onOpenPath: (path: string) => void }) {
  if (step.kind === "thinking") {
    return <div className="step-detail step-thought">{step.text}</div>;
  }
  if (step.kind === "command") {
    return (
      <div className="step-detail step-card">
        <TerminalCard command={step.command ?? ""} output={step.output} cwd={cwd} failed={step.status === "error"} />
      </div>
    );
  }
  if (step.kind === "text" || step.kind === "custom") {
    return (
      <div className="step-detail step-card step-prose">
        {step.customType ? <div className="custom-type">{step.customType}</div> : null}
        <Markdown text={step.text ?? ""} />
      </div>
    );
  }

  const args = step.call?.arguments ?? {};
  const output = contentText(step.result?.content) || contentText(step.runtime?.partial?.content);
  if (step.call?.name === "bash") {
    // The terminal card brings its own frame: no card around a card.
    return (
      <div className="step-detail">
        <TerminalCard
          command={typeof args.command === "string" ? args.command : ""}
          output={output}
          cwd={cwd}
          failed={step.status === "error"}
        />
      </div>
    );
  }
  return (
    <div className="step-detail step-card">
      {step.call ? (
        <ToolDetail call={step.call} result={step.result} runtime={step.runtime} diff={diffOf(step.result)} />
      ) : null}
      {step.call?.name === "edit" && step.path ? (
        <button type="button" className="step-open" onClick={() => onOpenPath(step.path!)}>
          在右侧打开
        </button>
      ) : null}
    </div>
  );
}

/** The terminal card of a bash step: dot, cwd name, command, copy — then output. */
function TerminalCard({
  command,
  output,
  cwd,
  failed,
}: {
  command: string;
  output?: string;
  cwd?: string;
  failed?: boolean;
}) {
  const name = cwd ? (cwd.split("/").filter(Boolean).pop() ?? cwd) : "";
  return (
    <div className="term-card">
      <div className="term-head">
        <span className="term-dot" aria-hidden />
        {name ? <span className="term-cwd">{name}</span> : null}
        <span className="term-command">{stripAnsi(command)}</span>
        <CopyButton text={command} label="复制命令" />
      </div>
      {output ? (
        <pre className={`term-output tool-scroll${failed ? " tool-error-text" : ""}`}>{stripAnsi(output)}</pre>
      ) : null}
    </div>
  );
}

function SummaryDivider({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="summary">
      <div className="summary-head">
        <span className="summary-line" aria-hidden />
        <button
          type="button"
          className="summary-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          <span>{label}</span>
          <ChevronDown size={12} strokeWidth={1.75} className={open ? "is-open" : undefined} aria-hidden />
        </button>
        <span className="summary-line" aria-hidden />
      </div>
      {open ? (
        <div className="summary-body">
          <Markdown text={text} />
        </div>
      ) : null}
    </div>
  );
}

function TurnFooter({ split, turn }: { split: TurnSplit; turn: Turn }) {
  const last = turn.assistants[turn.assistants.length - 1];
  if (!last) return null;
  const tokens = turn.assistants.reduce((sum, message) => sum + (message.usage?.totalTokens ?? 0), 0);
  const answer = split.answer?.map((block) => block.text).join("\n\n") || turnText(turn);

  return (
    <div className="turn-footer">
      <CopyButton text={answer} label="复制答案" />
      <span>用量 {formatTokens(tokens)} tok</span>
      <span>{formatClock(last.timestamp)}</span>
    </div>
  );
}

function contentText(content: (TextContent | ImageContent)[] | undefined): string {
  if (!content) return "";
  return content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function diffOf(result: ToolResultMessage | undefined): string | null {
  const details = result?.details;
  if (!details || typeof details !== "object") return null;
  const diff = (details as { diff?: unknown }).diff;
  return typeof diff === "string" ? diff : null;
}

function promptOf(message: UserMessage | null): string {
  if (!message) return "";
  const text =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((part): part is TextContent => part.type === "text")
          .map((part) => part.text)
          .join(" ");
  return firstLine(text, 80);
}

/** The right-edge conversation navigator: one tick per turn, a hover card of prompts. */
export function TurnNav({ items, scrollRoot }: TurnNavProps) {
  const prefs = usePrefs();
  const prompts = useMemo(() => groupTurns(items, null).map((turn) => promptOf(turn.user)), [items]);
  const [current, setCurrent] = useState(0);
  const [open, setOpen] = useState(false);
  const [detected, setDetected] = useState<HTMLElement | null>(null);
  const root = scrollRoot ?? detected;
  const visible = prefs.turnNav && prompts.length >= 2;

  // The shell owns the scroll container; without it, use the first turn's
  // scrollable ancestor so the rail still follows and jumps.
  useEffect(() => {
    if (scrollRoot) return;
    let node = document.querySelector<HTMLElement>("[data-turn-index]")?.parentElement ?? null;
    while (node && node !== document.body) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) break;
      node = node.parentElement;
    }
    const found = node && node !== document.body ? node : null;
    if (found !== detected) setDetected(found);
  }, [scrollRoot, items, detected]);

  useEffect(() => {
    if (!visible || !root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const sections = root.querySelectorAll<HTMLElement>("[data-turn-index]");
      if (sections.length === 0) return;
      const line = root.getBoundingClientRect().top + root.clientHeight / 3;
      let next = 0;
      for (const section of sections) {
        if (section.getBoundingClientRect().top > line) break;
        next = Number(section.dataset.turnIndex) || 0;
      }
      setCurrent(next);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    root.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      root.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [root, visible, items]);

  if (!visible) return null;

  const jump = (index: number) => {
    const section = root?.querySelector<HTMLElement>(`[data-turn-index="${index}"]`);
    if (!root || !section) return;
    const top = root.scrollTop + section.getBoundingClientRect().top - root.getBoundingClientRect().top - 16;
    root.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  };

  return (
    <div
      className="turn-nav"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <nav className="turn-nav-rail" role="navigation" aria-label="对话导航">
        {prompts.map((prompt, index) => (
          <button
            key={index}
            type="button"
            className="turn-nav-tick"
            data-current={index === current ? "" : undefined}
            aria-current={index === current ? "true" : undefined}
            aria-label={prompt || `第 ${index + 1} 轮`}
            onClick={() => jump(index)}
          />
        ))}
      </nav>
      {open ? (
        <div className="turn-nav-card">
          {prompts.map((prompt, index) => (
            <button
              key={index}
              type="button"
              className="turn-nav-row"
              data-current={index === current ? "" : undefined}
              onClick={() => jump(index)}
            >
              <span className="turn-nav-text">{prompt || `第 ${index + 1} 轮`}</span>
              <span className="turn-nav-dash" aria-hidden />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
