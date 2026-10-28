/** File preview tab: code with line numbers, markdown preview, images, downloads. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, RefreshCw, WrapText } from "lucide-react";
import hljs from "highlight.js/lib/common";
import type { FileReadResponse } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText } from "../app/errors.ts";
import { Markdown } from "../transcript/Markdown.tsx";
import { fileIcon, splitPath } from "./lib.ts";
import { CopyButton, ErrorLine, IconButton, Loading, PathBar } from "./ui.tsx";
import "../transcript/transcript.css";

type View = "code" | "preview";

export function FileTab({ cwd, path, line }: { cwd: string; path: string; line?: number }) {
  const [data, setData] = useState<FileReadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [view, setView] = useState<View | null>(null);
  const [wrap, setWrap] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .readFile(cwd, path)
      .then((response) => {
        if (!alive) return;
        setData(response);
      })
      .catch((caught: unknown) => {
        if (!alive) return;
        setData(null);
        setError(errorText(caught));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [cwd, path, nonce]);

  useEffect(() => {
    setView(null);
  }, [path]);

  const markdown = fileIcon(path) === "markdown" || data?.language === "markdown";
  const canPreview = data?.kind === "image" || (data?.kind === "text" && markdown);
  const defaultView: View = data?.kind === "image" || markdown ? "preview" : "code";
  const mode = view ?? defaultView;
  const fullPath = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
  const name = splitPath(path).name || path;
  const rawUrl = api.rawFileUrl(cwd, path);

  return (
    <div className="dock-preview">
      <div className="dock-bar">
        <PathBar path={fullPath} />
        {canPreview ? (
          <div className="dock-seg" role="group" aria-label="视图">
            <button type="button" data-active={mode === "code" ? "" : undefined} onClick={() => setView("code")}>
              代码
            </button>
            <button type="button" data-active={mode === "preview" ? "" : undefined} onClick={() => setView("preview")}>
              预览
            </button>
          </div>
        ) : null}
        {data?.kind === "text" ? (
          <IconButton label={wrap ? "取消自动换行" : "自动换行"} active={wrap} onClick={() => setWrap(!wrap)}>
            <WrapText size={14} strokeWidth={1.75} aria-hidden />
          </IconButton>
        ) : null}
        <IconButton label="刷新" onClick={() => setNonce((value) => value + 1)}>
          <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
        </IconButton>
        {data?.text !== undefined ? <CopyButton text={data.text} label="复制内容" /> : null}
        <a className="dock-icon-btn" href={rawUrl} download={name} title="下载" aria-label="下载">
          <Download size={14} strokeWidth={1.75} aria-hidden />
        </a>
      </div>

      <div className="dock-content">
        {loading ? <Loading /> : null}
        {!loading && error ? <ErrorLine message={error} onRetry={() => setNonce((value) => value + 1)} /> : null}
        {!loading && !error && data ? (
          data.kind === "image" ? (
            mode === "preview" ? (
              <div className="dock-image">
                <img src={rawUrl} alt={name} />
              </div>
            ) : (
              <div className="dock-empty">图片文件请在预览中查看</div>
            )
          ) : data.kind === "binary" ? (
            <div className="dock-binary">
              <p>无法预览二进制文件</p>
              <a className="dock-button" href={rawUrl} download={name}>
                <Download size={14} strokeWidth={1.75} aria-hidden />
                下载文件
              </a>
            </div>
          ) : data.text !== undefined ? (
            mode === "preview" && markdown ? (
              <div className="dock-markdown">
                <Markdown text={data.text} />
              </div>
            ) : (
              <CodeView text={data.text} language={data.language} truncated={data.truncated} wrap={wrap} line={line} />
            )
          ) : null
        ) : null}
      </div>
    </div>
  );
}

function CodeView({
  text,
  language,
  truncated,
  wrap,
  line,
}: {
  text: string;
  language?: string;
  truncated?: boolean;
  wrap: boolean;
  line?: number;
}) {
  const container = useRef<HTMLDivElement>(null);

  const code = useMemo(() => {
    // The terminal newline is not a line of its own; drop it for counting.
    const source = text.endsWith("\n") ? text.slice(0, -1) : text;
    const lines = source.split("\n");
    const highlightLanguage = language && hljs.getLanguage(language) ? language : undefined;
    const highlighted = highlightLanguage !== undefined && lines.length <= 5000;
    const html = highlighted
      ? splitHighlightedLines(hljs.highlight(source, { language: highlightLanguage }).value)
      : lines.map(escapeHtml);
    return { language, html, highlighted };
  }, [text, language]);

  useEffect(() => {
    if (!line || !container.current) return;
    const target = container.current.querySelector<HTMLElement>(`[data-line="${line}"]`);
    target?.scrollIntoView({ block: "center" });
  }, [line, code, wrap]);

  return (
    <div className="dock-code">
      <div className="dock-code-head">
        <span className="dock-code-lang">{code.language ?? "text"}</span>
        <CopyButton text={text} label="复制代码" />
      </div>
      <div ref={container} className={wrap ? "dock-code-lines is-wrap" : "dock-code-lines"}>
        {code.html.map((html, index) => (
          <div key={index} className={line === index + 1 ? "dock-code-row is-target" : "dock-code-row"} data-line={index + 1}>
            <span className="dock-code-ln" aria-hidden>
              {index + 1}
            </span>
            <code className="dock-code-line" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        ))}
      </div>
      {truncated ? <div className="dock-note">文件过大，只显示前 1 MiB</div> : null}
    </div>
  );
}

/** Split highlight.js HTML into lines, closing and reopening spans per line. */
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = "";
  const tokens = html.match(/<[^>]+>|\n|[^<\n]+/g) ?? [];
  for (const token of tokens) {
    if (token === "\n") {
      current += open.map(() => "</span>").join("");
      lines.push(current);
      current = open.join("");
    } else if (token.startsWith("</")) {
      current += token;
      open.pop();
    } else if (token.startsWith("<")) {
      current += token;
      if (!/^<(br|hr|img|input|wbr)\b/i.test(token) && !token.endsWith("/>")) open.push(token);
    } else {
      current += token;
    }
  }
  lines.push(current);
  return lines;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
