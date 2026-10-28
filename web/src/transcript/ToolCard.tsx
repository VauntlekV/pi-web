/** Tool call cards: one collapsed summary line, expandable details. */
import { useMemo, useState, type ReactNode } from "react";
import {
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Loader2,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import hljs from "highlight.js/lib/common";
import type {
  BashExecutionMessage,
  ImageContent,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
} from "../../../shared/protocol.ts";
import type { ToolRuntime } from "./index.tsx";
import { diffStats, guessLanguage, stripAnsi, toolSummary, truncate } from "./lib.ts";
import { ImageThumb } from "./ui.tsx";

type Status = "running" | "done" | "error" | "none";

const ICONS: Record<string, typeof Terminal> = {
  Terminal,
  FileText,
  FilePen,
  FilePlus,
  FolderSearch,
  Search,
  Wrench,
};

interface CardProps {
  icon: string;
  verb: string;
  target: string;
  mono?: boolean;
  status: Status;
  durationMs?: number;
  /** Right-hand text when status is "none" (e.g. "已取消") */
  note?: string;
  badge?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

function Card({ icon, verb, target, mono, status, durationMs, note, badge, open, onToggle, children }: CardProps) {
  const Icon = ICONS[icon] ?? Wrench;
  return (
    <div className={`tool-card${open ? " is-open" : ""}`}>
      <button type="button" className="tool-head" onClick={onToggle} aria-expanded={open} title={target}>
        <Icon size={16} strokeWidth={1.75} className="tool-icon" aria-hidden />
        <span className="tool-verb">{verb}</span>
        {target ? <span className={`tool-target${mono ? " mono" : ""}`}>{target}</span> : null}
        {badge}
        <span className="tool-status">
          <StatusView status={status} durationMs={durationMs} note={note} />
        </span>
      </button>
      {open ? <div className="tool-detail">{children}</div> : null}
    </div>
  );
}

function StatusView({ status, durationMs, note }: { status: Status; durationMs?: number; note?: string }) {
  if (status === "running") {
    return <Loader2 size={14} strokeWidth={1.75} className="spin" aria-label="运行中" />;
  }
  if (status === "error") {
    return (
      <span className="tool-status-error">
        <X size={14} strokeWidth={1.75} aria-hidden />
        失败
      </span>
    );
  }
  if (status === "done") {
    if (durationMs === undefined) return null;
    return <span>{durationMs < 100 ? "<0.1s" : `${(durationMs / 1000).toFixed(1)}s`}</span>;
  }
  return <span>{note ?? "无结果"}</span>;
}

export interface ToolCardProps {
  call: ToolCallContent;
  result?: ToolResultMessage;
  runtime?: ToolRuntime;
  /** The agent run is active, so a call without any result may still be running */
  running: boolean;
  cwd?: string;
}

export function ToolCard({ call, result, runtime, running, cwd }: ToolCardProps) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(call, cwd);
  const status: Status = runtime ? runtime.status : result ? (result.isError ? "error" : "done") : running ? "running" : "none";
  const diff = detailsDiff(result?.details);
  const stats = diff === null ? null : diffStats(diff);

  return (
    <Card
      icon={summary.icon}
      verb={summary.verb}
      target={summary.target}
      mono={call.name === "bash"}
      status={status}
      durationMs={runtime?.durationMs}
      badge={
        stats && (stats.added > 0 || stats.removed > 0) ? (
          <span className="tool-diffstat">
            <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>
          </span>
        ) : null
      }
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      {open ? <ToolDetail call={call} result={result} runtime={runtime} diff={diff} /> : null}
    </Card>
  );
}

/** `!command` runs typed by the user; same card look, labelled "! 命令". */
export function BashExecutionCard({ message }: { message: BashExecutionMessage }) {
  const [open, setOpen] = useState(false);
  const failed = !message.cancelled && message.exitCode !== undefined && message.exitCode !== 0;
  const status: Status = message.cancelled ? "none" : failed ? "error" : "done";

  return (
    <Card
      icon="Terminal"
      verb="! 命令"
      target={truncate(message.command.split("\n")[0] ?? "", 80)}
      mono
      status={status}
      note={message.cancelled ? "已取消" : undefined}
      open={open}
      onToggle={() => setOpen((value) => !value)}
    >
      {open ? (
        <>
          <pre className="tool-pre tool-scroll tool-command">
            <span className="tool-dollar">$ </span>
            {stripAnsi(message.command)}
          </pre>
          {message.output ? (
            <pre className={`tool-pre tool-scroll tool-output${failed ? " tool-error-text" : ""}`}>
              {stripAnsi(message.output)}
            </pre>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

/** The expanded body of a tool card; also used by a step's detail card. */
export function ToolDetail({
  call,
  result,
  runtime,
  diff,
}: {
  call: ToolCallContent;
  result?: ToolResultMessage;
  runtime?: ToolRuntime;
  diff: string | null;
}) {
  const args = call.arguments ?? {};
  const path = typeof args.path === "string" ? args.path : "";
  const output = contentText(result?.content) || contentText(runtime?.partial?.content);
  const images = imageBlocks(result?.content);
  const errorClass = result?.isError ? " tool-error-text" : "";

  switch (call.name) {
    case "bash":
      return (
        <>
          <pre className="tool-pre tool-scroll tool-command">
            <span className="tool-dollar">$ </span>
            {stripAnsi(typeof args.command === "string" ? args.command : "")}
          </pre>
          {output ? (
            <pre className={`tool-pre tool-scroll tool-output${errorClass}`}>{stripAnsi(output)}</pre>
          ) : null}
          <Images images={images} />
        </>
      );

    case "read":
      return (
        <>
          {output ? <CodeView code={output} lang={guessLanguage(path)} max={30} error={Boolean(result?.isError)} /> : null}
          <Images images={images} />
        </>
      );

    case "edit": {
      if (diff !== null) return <DiffView diff={diff} />;
      const pairs = editPairs(args.edits);
      if (pairs.length > 0) {
        const synthetic = pairs
          .map(({ oldText, newText }) =>
            [
              ...oldText.split("\n").filter((line) => line !== "").map((line) => `-${line}`),
              ...newText.split("\n").filter((line) => line !== "").map((line) => `+${line}`),
            ].join("\n"),
          )
          .filter(Boolean)
          .join("\n");
        return <DiffView diff={synthetic} />;
      }
      return output ? <pre className={`tool-pre${errorClass}`}>{stripAnsi(output)}</pre> : null;
    }

    case "write": {
      const content = typeof args.content === "string" ? args.content : "";
      return content ? <CodeView code={content} lang={guessLanguage(path)} max={40} /> : null;
    }

    case "ls":
    case "find":
    case "grep":
      return (
        <>
          {output ? <pre className={`tool-pre${errorClass}`}>{stripAnsi(output)}</pre> : null}
          <Images images={images} />
        </>
      );

    default:
      return (
        <>
          <pre className="tool-pre">{truncate(JSON.stringify(args, null, 2), 4000)}</pre>
          {output ? <pre className={`tool-pre${errorClass}`}>{stripAnsi(output)}</pre> : null}
          <Images images={images} />
        </>
      );
  }
}

function CodeView({ code, lang, max, error }: { code: string; lang?: string; max?: number; error?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => code.split("\n"), [code]);
  const limited = max !== undefined && !expanded && lines.length > max;
  const shown = limited ? lines.slice(0, max).join("\n") : code;
  const html = useMemo(() => highlightCode(shown, lang), [shown, lang]);

  return (
    <>
      <pre
        className={`tool-pre tool-code${error ? " tool-error-text" : ""}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {limited ? (
        <button type="button" className="tool-more" onClick={() => setExpanded(true)}>
          展开全部（共 {lines.length} 行）
        </button>
      ) : null}
    </>
  );
}

function DiffView({ diff }: { diff: string }) {
  return (
    <div className="tool-pre tool-diff">
      {diff.split("\n").map((line, index) => {
        const kind =
          line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
            ? "meta"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : "ctx";
        return (
          <div key={index} className={`diff-line diff-${kind}`}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

function Images({ images }: { images: ImageContent[] }) {
  if (images.length === 0) return null;
  return (
    <div className="tool-images">
      {images.map((image, index) => (
        <ImageThumb key={index} image={image} alt={`工具结果图片 ${index + 1}`} />
      ))}
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

function imageBlocks(content: (TextContent | ImageContent)[] | undefined): ImageContent[] {
  if (!content) return [];
  return content.filter((block): block is ImageContent => block.type === "image");
}

function detailsDiff(details: unknown): string | null {
  if (details && typeof details === "object" && typeof (details as { diff?: unknown }).diff === "string") {
    return (details as { diff: string }).diff;
  }
  return null;
}

function editPairs(value: unknown): { oldText: string; newText: string }[] {
  if (!Array.isArray(value)) return [];
  const pairs: { oldText: string; newText: string }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { oldText, newText } = entry as { oldText?: unknown; newText?: unknown };
    if (typeof oldText === "string" || typeof newText === "string") {
      pairs.push({
        oldText: typeof oldText === "string" ? oldText : "",
        newText: typeof newText === "string" ? newText : "",
      });
    }
  }
  return pairs;
}

function highlightCode(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang }).value;
    } catch {
      // Fall through to plain escaped text.
    }
  }
  return code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
