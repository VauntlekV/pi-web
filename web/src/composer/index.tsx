/**
 * Composer — the prompt box with its toolbar (model / thinking pickers, context
 * meter) and the slash-command and @-file palettes.
 *
 * CONTRACT: the exported names and prop types below are used by the app shell.
 * Implementations may add optional props but must not change these.
 */
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from "react";
import {
  ArrowUp,
  AtSign,
  Download,
  Image as ImageIcon,
  Minimize2,
  Plus,
  RefreshCw,
  Slash,
  Square,
  X,
} from "lucide-react";
import type {
  CommandInfo,
  ContextUsage,
  ImageContent,
  ModelInfo,
  ModelRef,
  SessionStats,
  ThinkingLevel,
} from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { usePrefs } from "../app/prefs.ts";
import { Menu, type MenuEntry } from "../ui/menu.tsx";
import {
  applyCompletion,
  clearAfterSubmit,
  detectTrigger,
  filterCommands,
  formatCost,
  formatTokens,
  isWhitespace,
} from "./lib.ts";
import type { Trigger } from "./lib.ts";
import { noteSent } from "../transcript/entrance.ts";
import { useGlidingCaret } from "./caret.ts";
import { ModelPicker, ThinkingPicker } from "./pickers.tsx";
import "./composer.css";

export interface ComposerProps {
  /** Working directory used for @-file search (api.searchFiles) */
  cwd: string;
  /** The agent is running: Send queues (followUp / steer) and a Stop button shows */
  running: boolean;
  /** Disable input entirely (e.g. while a session is being created) */
  disabled?: boolean;
  placeholder?: string;

  models: ModelInfo[];
  model: ModelRef | undefined;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  onModelChange: (ref: ModelRef) => void;
  onThinkingChange: (level: ThinkingLevel) => void;

  /** Slash palette entries; empty on the home page */
  commands: CommandInfo[];
  /** Usage line and context ring; absent on the home page */
  stats?: SessionStats;
  /** Messages queued while running, shown above the box */
  queued?: { steering: string[]; followUp: string[] };
  /** Extension widget lines/status items to render around the box */
  widgets?: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  statuses?: Record<string, string>;

  /**
   * Send. `behavior` is set only while running ("followUp" for Enter,
   * "steer" for Ctrl/Cmd+Enter). Resolve to clear the box; reject to keep it.
   */
  onSubmit: (text: string, images: ImageContent[], behavior?: "steer" | "followUp") => Promise<void>;
  onAbort: () => void;
  /** Extra entries shown at the top of the composer "+" menu's 指令 group */
  actions?: { id: string; label: string; hint?: string; run: () => void }[];
  /** Extra controls rendered at the left of the row above the box (e.g. the home page's workspace chip) */
  leading?: ReactNode;
  /** Focus the textarea when this value changes */
  focusKey?: unknown;
}

const DEFAULT_PLACEHOLDER = "输入消息，/ 调用命令，@ 引用文件";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_HISTORY = 50;
const SEARCH_DEBOUNCE_MS = 120;

const SOURCE_LABELS: Record<CommandInfo["source"], string> = {
  extension: "扩展",
  prompt: "模板",
  skill: "技能",
  builtin: "内置",
};

const ICON_STROKE = 1.75;

/** Icons for the actions the conversation page passes into the "+" menu. */
const ACTION_ICONS: Record<string, ReactNode> = {
  compact: <Minimize2 size={14} strokeWidth={ICON_STROKE} />,
  export: <Download size={14} strokeWidth={ICON_STROKE} />,
  reload: <RefreshCw size={14} strokeWidth={ICON_STROKE} />,
};

type Completion =
  | { kind: "slash"; items: CommandInfo[] }
  | { kind: "mention"; items: string[] };

function tokenSignature(trigger: Trigger, text: string): string {
  return `${trigger.kind}\u0000${trigger.start}\u0000${text.slice(trigger.start, trigger.end)}`;
}

function readImage(file: File): Promise<ImageContent> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      resolve({
        type: "image",
        data: comma >= 0 ? url.slice(comma + 1) : "",
        mimeType: file.type || "image/png",
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function QueuedChip({ label, text }: { label: string; text: string }) {
  const characters = Array.from(text);
  const short = characters.length > 40 ? `${characters.slice(0, 40).join("")}…` : text;
  return (
    <span className="composer-queued-chip" title={text}>
      <span className="composer-queued-label">{label}</span>
      <span className="composer-queued-text">{short}</span>
    </span>
  );
}

function WidgetBlock({
  entries,
}: {
  entries: [string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }][];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="composer-widgets">
      {entries.map(([key, widget]) => (
        <div key={key} className="composer-widget">
          {widget.lines.map((line, index) => (
            <div key={index} className="composer-widget-line">
              {line}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ContextRing({ usage }: { usage: ContextUsage }) {
  const percent = usage.percent ?? 0;
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = 6.5;
  const circumference = 2 * Math.PI * radius;
  const tone = percent >= 95 ? "var(--danger)" : percent >= 80 ? "var(--warn)" : "var(--ink-3)";
  const title = `上下文 ${formatTokens(usage.tokens ?? 0)} / ${formatTokens(usage.contextWindow)} tok`;

  return (
    <span className="composer-ring" role="img" aria-label={title} title={title} style={{ color: tone }}>
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
        <circle cx={8} cy={8} r={radius} fill="none" stroke="var(--border-2)" strokeWidth={2} />
        {clamped > 0 && (
          <circle
            cx={8}
            cy={8}
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
            transform="rotate(-90 8 8)"
          />
        )}
      </svg>
      <span>{Math.round(percent)}%</span>
    </span>
  );
}

export function Composer(props: ComposerProps) {
  const {
    cwd,
    running,
    disabled,
    placeholder,
    models,
    model,
    thinkingLevel,
    availableThinkingLevels,
    onModelChange,
    onThinkingChange,
    commands,
    stats,
    queued,
    widgets,
    statuses,
    onSubmit,
    onAbort,
    actions,
    leading,
    focusKey,
  } = props;
  const prefs = usePrefs();

  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageContent[]>([]);
  const [caret, setCaret] = useState(0);
  const [caretJump, setCaretJump] = useState<{ pos: number; seq: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [fileResults, setFileResults] = useState<{ query: string; files: string[] }>({
    query: "",
    files: [],
  });
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const completionRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef({ text, images });
  draftRef.current = { text, images };
  const submittingRef = useRef(false);
  const searchSeqRef = useRef(0);
  const jumpSeqRef = useRef(0);
  const mountedRef = useRef(false);

  const steering = queued?.steering ?? [];
  const followUp = queued?.followUp ?? [];
  const showTopRow = leading != null || steering.length > 0 || followUp.length > 0;

  const widgetEntries = Object.entries(widgets ?? {});
  const aboveWidgets = widgetEntries.filter(([, widget]) => widget.placement === "aboveEditor");
  const belowWidgets = widgetEntries.filter(([, widget]) => widget.placement === "belowEditor");

  const currentModel = models.find((m) => m.provider === model?.provider && m.id === model?.id);
  const hasContent = text.trim().length > 0 || images.length > 0;
  const visionBlocked = currentModel?.vision === false && images.length > 0;
  const canSend = !disabled && !submitting && hasContent && !visionBlocked;

  const statusText = Object.values(statuses ?? {})
    .filter(Boolean)
    .join(" · ");
  const toolbarError = error ?? (visionBlocked ? "当前模型不支持图片" : null);

  // ---- completion -------------------------------------------------------

  const trigger = detectTrigger(text, caret);
  const signature = trigger ? tokenSignature(trigger, text) : null;
  const dismissedNow = signature !== null && signature === dismissed;

  let completion: Completion | null = null;
  if (trigger && !dismissedNow) {
    if (trigger.kind === "slash") {
      if (commands.length > 0) {
        const items = filterCommands(commands, trigger.query);
        if (items.length > 0) completion = { kind: "slash", items };
      }
    } else if (fileResults.query === trigger.query && fileResults.files.length > 0) {
      completion = { kind: "mention", items: fileResults.files };
    }
  }
  const completionItems = completion?.items ?? [];
  const active = completionItems.length === 0 ? -1 : Math.min(activeIndex, completionItems.length - 1);
  const mentionQuery = trigger?.kind === "mention" && !dismissedNow ? trigger.query : null;

  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.kind, trigger?.query]);

  // Keep the highlighted row visible while ↑/↓ walk past the list's edge.
  const completionOpen = completion !== null;
  useEffect(() => {
    if (!completionOpen || active < 0) return;
    completionRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, completionOpen]);

  useEffect(() => {
    if (mentionQuery === null) return;
    const seq = ++searchSeqRef.current;
    const timer = window.setTimeout(() => {
      api.searchFiles(cwd, mentionQuery).then(
        (result) => {
          if (searchSeqRef.current === seq) setFileResults({ query: mentionQuery, files: result.files });
        },
        () => {
          if (searchSeqRef.current === seq) setFileResults({ query: mentionQuery, files: [] });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [cwd, mentionQuery]);

  const replaceToken = (replacement: string) => {
    if (!trigger) return;
    const next = applyCompletion(text, trigger, replacement);
    setText(next.text);
    setCaretJump({ pos: next.caret, seq: ++jumpSeqRef.current });
    setActiveIndex(0);
    setError(null);
    const after = detectTrigger(next.text, next.caret);
    setDismissed(after ? tokenSignature(after, next.text) : null);
  };

  /** Put text at the caret (the "+" menu never replaces the whole draft). */
  const insertText = (snippet: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    setText(text.slice(0, start) + snippet + text.slice(end));
    setCaretJump({ pos: start + snippet.length, seq: ++jumpSeqRef.current });
    setHistoryIndex(null);
    setError(null);
  };

  const insertMention = () => {
    const caretPos = textareaRef.current?.selectionStart ?? text.length;
    const needsSpace = caretPos > 0 && !isWhitespace(text[caretPos - 1] ?? "");
    insertText(`${needsSpace ? " " : ""}@`);
  };

  const applyCommand = (command: CommandInfo) => replaceToken(`/${command.name} `);
  const applyFile = (path: string) => replaceToken(`@${path} `);

  // ---- textarea growth, caret and focus ---------------------------------

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const max = Math.max(24, Math.round(window.innerHeight * 0.4));
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  };

  const redrawCaret = useGlidingCaret(textareaRef, prefs.caretMotion);

  useEffect(() => {
    resizeTextarea();
    redrawCaret();
  }, [text]);

  useEffect(() => {
    const onResize = () => resizeTextarea();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!caretJump || !el) return;
    el.focus();
    el.setSelectionRange(caretJump.pos, caretJump.pos);
    setCaret(caretJump.pos);
    setCaretJump(null);
  }, [caretJump, text]);

  useEffect(() => {
    const first = !mountedRef.current;
    mountedRef.current = true;
    if (first && window.innerWidth < 768) return;
    textareaRef.current?.focus();
  }, [focusKey]);

  const syncCaret = () => {
    const el = textareaRef.current;
    if (el) setCaret(el.selectionStart ?? 0);
  };

  // ---- history ----------------------------------------------------------

  const recallHistory = (direction: 1 | -1) => {
    if (history.length === 0) return;
    let next: number | null;
    if (direction === -1) {
      next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
    } else {
      if (historyIndex === null) return;
      next = historyIndex >= history.length - 1 ? null : historyIndex + 1;
    }
    setHistoryIndex(next);
    const value = next === null ? "" : history[next];
    setText(value);
    setError(null);
    setCaretJump({ pos: value.length, seq: ++jumpSeqRef.current });
  };

  // ---- submit -----------------------------------------------------------

  const submit = async (behavior?: "steer" | "followUp") => {
    if (disabled || submittingRef.current) return;
    if (!hasContent || visionBlocked) return;

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    const sentText = text;
    const sentImages = images;
    if (sentText.trim().length > 0) {
      setHistory((previous) => [...previous, sentText].slice(-MAX_HISTORY));
    }

    try {
      // A queued message (running) shows up much later as its own turn; only a
      // prompt sent now gets the bubble entrance.
      if (!running) noteSent(textareaRef.current?.getBoundingClientRect() ?? null);
      await onSubmit(sentText, sentImages, running ? (behavior ?? "followUp") : undefined);
      const kept = clearAfterSubmit(
        { text: sentText, images: sentImages },
        draftRef.current,
      );
      setText(kept.text);
      setImages(kept.images);
      setHistoryIndex(null);
      setDismissed(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (completion && completionItems.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex(((active < 0 ? 0 : active) + delta + completionItems.length) % completionItems.length);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault();
        if (completion.kind === "slash") {
          const command = completion.items[active];
          if (command) applyCommand(command);
        } else {
          const path = completion.items[active];
          if (path) applyFile(path);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        if (signature) setDismissed(signature);
        return;
      }
    }

    if (event.key === "Escape") {
      if (running) {
        event.preventDefault();
        onAbort();
      }
      return;
    }

    if (event.key === "Enter") {
      if (event.shiftKey) return;
      event.preventDefault();
      const other = prefs.busySend === "followUp" ? "steer" : "followUp";
      const modified = event.ctrlKey || event.metaKey;
      void submit(running ? (modified ? other : prefs.busySend) : undefined);
      return;
    }

    if (
      event.key === "ArrowUp" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (text === "" || historyIndex !== null)
    ) {
      event.preventDefault();
      recallHistory(-1);
      return;
    }
    if (event.key === "ArrowDown" && historyIndex !== null) {
      event.preventDefault();
      recallHistory(1);
    }
  };

  // ---- text changes -----------------------------------------------------

  const onTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    setCaret(event.target.selectionStart ?? event.target.value.length);
    setHistoryIndex(null);
    setError(null);
  };

  // ---- images -----------------------------------------------------------

  const addImages = async (files: File[]) => {
    const incoming = files.filter((file) => file.type.startsWith("image/"));
    if (incoming.length === 0) return;

    let message: string | null = null;
    const accepted: File[] = [];
    for (const file of incoming) {
      if (file.size > MAX_IMAGE_BYTES) {
        message = "图片不能超过 5MB";
        continue;
      }
      if (images.length + accepted.length >= MAX_IMAGES) {
        message = "最多添加 8 张图片";
        continue;
      }
      accepted.push(file);
    }

    if (accepted.length > 0) {
      try {
        const contents = await Promise.all(accepted.map(readImage));
        setImages((previous) => [...previous, ...contents].slice(0, MAX_IMAGES));
        setError(null);
      } catch {
        message = "读取图片失败";
      }
    }
    if (message) setError(message);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void addImages(files);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void addImages(files);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) void addImages(files);
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!dragging && Array.from(event.dataTransfer?.types ?? []).includes("Files")) setDragging(true);
  };

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDragging(false);
  };

  // ---- render -----------------------------------------------------------

  const busyLabels =
    prefs.busySend === "followUp"
      ? { enter: "排队发送", other: "插话" }
      : { enter: "插话", other: "排队发送" };

  const plusMenu: MenuEntry[] = [
    { kind: "label", label: "添加" },
    {
      kind: "item",
      label: "图片",
      detail: "image",
      icon: <ImageIcon size={14} strokeWidth={ICON_STROKE} />,
      onSelect: () => fileInputRef.current?.click(),
    },
    {
      kind: "item",
      label: "引用文件",
      detail: "@",
      icon: <AtSign size={14} strokeWidth={ICON_STROKE} />,
      onSelect: insertMention,
    },
    ...((actions?.length ?? 0) + commands.length > 0
      ? [{ kind: "label" as const, label: "指令" }]
      : []),
    ...(actions ?? []).map(
      (action): MenuEntry => ({
        kind: "item",
        label: action.label,
        detail: action.hint,
        icon: ACTION_ICONS[action.id] ?? <Slash size={14} strokeWidth={ICON_STROKE} />,
        onSelect: action.run,
      }),
    ),
    ...commands.map(
      (command): MenuEntry => ({
        kind: "item",
        label: `/${command.name}`,
        detail: SOURCE_LABELS[command.source],
        hint: command.description,
        icon: <Slash size={14} strokeWidth={ICON_STROKE} />,
        onSelect: () => insertText(`/${command.name} `),
      }),
    ),
  ];

  return (
    <div className="composer">
      {showTopRow && (
        <div className="composer-top">
          {leading}
          {(steering.length > 0 || followUp.length > 0) && (
            <div className="composer-queued">
              {steering.map((item, index) => (
                <QueuedChip key={`steer-${index}`} label="插话" text={item} />
              ))}
              {followUp.map((item, index) => (
                <QueuedChip key={`follow-${index}`} label="排队" text={item} />
              ))}
            </div>
          )}
        </div>
      )}

      <WidgetBlock entries={aboveWidgets} />

      <div className="composer-stack">
        <div
          className="composer-card"
          data-dragging={dragging}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
        >
          {images.length > 0 && (
            <div className="composer-images">
              {images.map((image, index) => (
                <div key={index} className="composer-thumb">
                  <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                  <button
                    type="button"
                    className="composer-thumb-remove"
                    aria-label="移除图片"
                    title="移除图片"
                    onClick={() => setImages((previous) => previous.filter((_, i) => i !== index))}
                  >
                    <X size={10} strokeWidth={2.5} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer-field">
            <textarea
              ref={textareaRef}
              className="composer-input"
              value={text}
              rows={1}
              disabled={disabled}
              placeholder={placeholder ?? DEFAULT_PLACEHOLDER}
              aria-label="消息输入"
              onChange={onTextChange}
              onKeyDown={onTextareaKeyDown}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              onSelect={syncCaret}
              onPaste={onPaste}
            />
          </div>

          <div className="composer-actions">
            {running && (
              <>
                {hasContent && (
                  <button
                    type="button"
                    className="composer-send"
                    title={`${busyLabels.enter}（Ctrl+Enter ${busyLabels.other}）`}
                    aria-label={busyLabels.enter}
                    disabled={!canSend}
                    onClick={() => void submit(prefs.busySend)}
                  >
                    <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="composer-stop"
                  aria-label="停止"
                  title="停止"
                  disabled={disabled}
                  onClick={onAbort}
                >
                  <Square size={12} strokeWidth={0} fill="currentColor" aria-hidden="true" />
                </button>
              </>
            )}
            {!running && (
              <button
                type="button"
                className="composer-send"
                aria-label="发送"
                title="发送"
                disabled={!canSend}
                onClick={() => void submit()}
              >
                <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        {completion && (
          <div ref={completionRef} className="composer-completion" role="listbox" aria-label={completion.kind === "slash" ? "命令" : "文件"}>
            {completion.kind === "slash"
              ? completion.items.map((command, index) => (
                  <div
                    key={command.name}
                    className="composer-completion-row"
                    role="option"
                    aria-selected={index === active}
                    data-active={index === active}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => applyCommand(command)}
                  >
                    <span className="composer-completion-name">/{command.name}</span>
                    {command.description && (
                      <span className="composer-completion-desc">{command.description}</span>
                    )}
                    <span className="composer-completion-source">{SOURCE_LABELS[command.source]}</span>
                  </div>
                ))
              : completion.items.map((path, index) => (
                  <div
                    key={path}
                    className="composer-completion-row"
                    role="option"
                    aria-selected={index === active}
                    data-active={index === active}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => applyFile(path)}
                  >
                    <span className="composer-completion-name">{path}</span>
                  </div>
                ))}
          </div>
        )}
      </div>

      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <Menu
            label="添加内容"
            trigger={<Plus size={16} strokeWidth={ICON_STROKE} aria-hidden="true" />}
            triggerClassName="composer-icon-button"
            side="top"
            align="start"
            listClassName="menu-list-composer"
            items={plusMenu}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={onFileChange}
          />
          {toolbarError && (
            <span className="composer-error" title={toolbarError}>
              {toolbarError}
            </span>
          )}
          {statusText && (
            <span className="composer-status" title={statusText}>
              {statusText}
            </span>
          )}
        </div>

        <div className="composer-toolbar-right">
          {stats && (
            <span className="composer-usage">
              {formatTokens(stats.tokens.total)} tok
              {stats.cost > 0 ? ` · ${formatCost(stats.cost)}` : ""}
            </span>
          )}
          <ModelPicker
            models={models}
            model={model}
            disabled={disabled}
            onSelect={onModelChange}
            onOpen={() => signature && setDismissed(signature)}
          />
          <ThinkingPicker
            level={thinkingLevel}
            levels={availableThinkingLevels}
            disabled={disabled}
            onSelect={onThinkingChange}
            onOpen={() => signature && setDismissed(signature)}
          />
          {stats?.contextUsage && stats.contextUsage.percent !== null && (
            <ContextRing usage={stats.contextUsage} />
          )}
        </div>
      </div>

      <WidgetBlock entries={belowWidgets} />
    </div>
  );
}
