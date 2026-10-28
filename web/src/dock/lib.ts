/**
 * Pure helpers for the right dock: unified-diff parsing, git letters, path
 * splitting/truncation, file-type icons and relative times.
 *
 * Nothing here touches React or the DOM, so everything is directly testable.
 */
import type { GitChangeKind } from "../../../shared/protocol.ts";

export interface DiffLine {
  kind: "add" | "del" | "context";
  text: string;
  /** null on added lines */
  oldLine: number | null;
  /** null on removed lines */
  newLine: number | null;
}

export interface DiffHunk {
  /** the raw `@@ -a,b +c,d @@` line (including the trailing context text) */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff into hunks with per-line old/new line numbers.
 *
 * Only `@@` lines open a hunk; everything before the first one (`diff --git`,
 * `index`, `---`/`+++`) is ignored. Inside a hunk every line is body, so a
 * content line starting with `+++` or `---` stays an addition/removal, and
 * `\ No newline at end of file` markers are skipped without consuming numbers.
 */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  // A trailing newline is the file's terminator, not a line of its own.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of raw) {
    const match = HUNK_HEADER.exec(line);
    if (match) {
      const oldStart = Number(match[1]);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      hunk = { header: line, oldStart, oldCount, newStart, newCount, lines: [] };
      hunks.push(hunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (hunk === null) continue;
    if (line.startsWith("\\")) continue;

    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === "+") {
      hunk.lines.push({ kind: "add", text: content, oldLine: null, newLine });
      newLine += 1;
    } else if (prefix === "-") {
      hunk.lines.push({ kind: "del", text: content, oldLine, newLine: null });
      oldLine += 1;
    } else if (prefix === " " || line === "") {
      hunk.lines.push({ kind: "context", text: content, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return hunks;
}

/** The letter shown beside a changed file. */
export function gitLetter(kind: GitChangeKind): "M" | "A" | "D" | "R" | "U" {
  switch (kind) {
    case "modified":
    case "typechange":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
    case "copied":
      return "R";
    case "untracked":
    case "conflicted":
      return "U";
  }
}

/** Split a path into its directory part and last segment. */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index < 0) return { dir: "", name: path };
  return { dir: path.slice(0, index) || "/", name: path.slice(index + 1) };
}

/** Truncate from the left, counting code points (CJK and emoji stay whole). */
export function ellipsizeLeft(path: string, maxChars: number): string {
  const chars = Array.from(path);
  if (chars.length <= maxChars) return path;
  if (maxChars <= 1) return "…";
  return `…${chars.slice(chars.length - (maxChars - 1)).join("")}`;
}

export type FileIconKind = "code" | "markdown" | "image" | "file";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx", "mdown", "mkd", "mdwn"]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "ico",
  "svg",
  "tif",
  "tiff",
]);

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "cts",
  "json",
  "jsonc",
  "json5",
  "css",
  "scss",
  "sass",
  "less",
  "styl",
  "html",
  "htm",
  "vue",
  "svelte",
  "astro",
  "py",
  "pyi",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "cs",
  "php",
  "swift",
  "m",
  "mm",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "sql",
  "yml",
  "yaml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "xml",
  "graphql",
  "gql",
  "proto",
  "lua",
  "r",
  "scala",
  "clj",
  "ex",
  "exs",
  "erl",
  "hs",
  "dart",
  "zig",
  "make",
  "mk",
  "dockerfile",
]);

/** Which icon a file name gets in tabs and the tree. */
export function fileIcon(name: string): FileIconKind {
  const base = splitPath(name).name.toLowerCase();
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1) : "";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (CODE_EXTENSIONS.has(extension) || base === "dockerfile" || base === "makefile") return "code";
  return "file";
}

/** Relative timestamps, same rules as the sidebar (a local copy by contract). */
export function relativeTime(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";

  const diff = now - time;
  if (diff < 0) return "刚刚";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "刚刚";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天`;

  const date = new Date(time);
  const today = new Date(now);
  const month = date.getMonth() + 1;
  if (date.getFullYear() === today.getFullYear()) return `${month}月${date.getDate()}日`;
  return `${date.getFullYear()}/${month}/${date.getDate()}`;
}
