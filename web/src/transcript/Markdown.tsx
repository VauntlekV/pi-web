/**
 * Markdown rendering for assistant text, custom messages and summaries.
 *
 * react-markdown + remark-gfm + rehype-highlight, no raw HTML (rehype-raw is
 * deliberately absent). Memoised on the text so streaming elsewhere in the turn
 * does not re-parse finished blocks.
 */
import { memo, isValidElement, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { limitHighlight } from "./lib.ts";
import { CopyButton } from "./ui.tsx";

function reactText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(reactText).join("");
  if (isValidElement(node)) return reactText((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ children }: ComponentProps<"pre">) {
  const code = Array.isArray(children) ? children[0] : children;
  const className = isValidElement(code) ? ((code.props as { className?: string }).className ?? "") : "";
  const language = /language-([\w+#.-]+)/.exec(className)?.[1] ?? "";
  return (
    <div className="code-card">
      <div className="code-head">
        <span className="code-lang">{language}</span>
        <CopyButton text={reactText(children)} label="复制代码" />
      </div>
      <pre className="code-pre">{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
  table: ({ node: _node, ...props }) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
  input: ({ node: _node, ...props }) => <input {...props} disabled />,
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [limitHighlight, rehypeHighlight];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
