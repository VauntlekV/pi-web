/**
 * Workspace file access for /api/files/* (see the "v2: workspace files & git"
 * section of shared/protocol.ts). Every path is resolved through symlinks and
 * must stay inside the workspace directory.
 */
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileEntry, FileEntryType, FileReadResponse, FileTreeResponse } from "../shared/protocol.ts";
import { gitStatus, runGit, trimIncompleteUtf8 } from "./git.ts";
import { HttpError } from "./http-error.ts";

const MAX_TREE_ENTRIES = 5000;
const SNIFF_BYTES = 8 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const MIME_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  json: "application/json",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  zip: "application/zip",
};

const PLAIN_TEXT_EXTS = new Set([
  "ts", "tsx", "jsx", "yml", "yaml", "toml", "ini", "sh", "bash", "zsh", "sql", "rb", "php",
  "go", "rs", "c", "h", "cpp", "cc", "hpp", "cs", "java", "kt", "swift", "lua", "py", "vue",
  "csv", "log", "conf", "lock",
]);

const LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  go: "go",
  rs: "rust",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  scss: "scss",
  html: "xml",
  vue: "xml",
  xml: "xml",
  svg: "xml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  lua: "lua",
};

// ------------------------------------------------------------ path handling

/** The workspace directory as an absolute, symlink-free path; 400 if unusable. */
export async function resolveWorkspace(cwd: string): Promise<string> {
  if (!cwd || !isAbsolute(cwd)) throw new HttpError(400, "工作区目录不存在");
  try {
    const real = await realpath(cwd);
    if (!(await stat(real)).isDirectory()) throw new Error("not a directory");
    return real;
  } catch {
    throw new HttpError(400, "工作区目录不存在");
  }
}

/**
 * Resolve `rel` inside `cwd`. Rejects absolute paths, NUL bytes and anything
 * that escapes through `..` or a symlink; 404 when the target is missing.
 *
 * The lexical check runs first, without touching the target: otherwise a
 * missing outside path (404) and an existing one (400) would leak whether a
 * file outside the workspace exists.
 */
export async function resolveInside(cwd: string, rel: string): Promise<{ abs: string; rel: string }> {
  const realCwd = await resolveWorkspace(cwd);
  if (rel.includes("\0")) throw new HttpError(400, "路径包含非法字符");
  if (isAbsolute(rel)) throw new HttpError(400, "path 必须是相对路径");

  const prefix = realCwd.endsWith(sep) ? realCwd : realCwd + sep;
  const lexical = resolve(realCwd, rel);
  if (lexical !== realCwd && !lexical.startsWith(prefix)) throw new HttpError(400, "路径超出工作区");

  let realAbs: string;
  try {
    realAbs = await realpath(lexical);
  } catch {
    throw new HttpError(404, "文件不存在");
  }

  if (realAbs !== realCwd && !realAbs.startsWith(prefix)) throw new HttpError(400, "路径超出工作区");

  return { abs: realAbs, rel: relative(realCwd, realAbs).split(sep).join("/") };
}

/**
 * Same containment check, but a missing leaf is fine (deleted files still have
 * a diff). The parent directory is then the thing that has to be inside.
 */
export async function resolveForGit(cwd: string, rel: string): Promise<{ abs: string; rel: string }> {
  try {
    return await resolveInside(cwd, rel);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
  }

  const cut = rel.lastIndexOf("/");
  const parent = await resolveInside(cwd, cut === -1 ? "" : rel.slice(0, cut));
  const name = rel.slice(cut + 1);
  return { abs: join(parent.abs, name), rel: parent.rel ? `${parent.rel}/${name}` : name };
}

// --------------------------------------------------------------------- tree

export async function readTree(cwd: string, rel: string): Promise<FileTreeResponse> {
  const realCwd = await resolveWorkspace(cwd);
  const target = await resolveInside(realCwd, rel);
  if (!(await stat(target.abs)).isDirectory()) throw new HttpError(400, "不是目录");

  const dirents = await readdir(target.abs, { withFileTypes: true });
  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    const entryPath = target.rel ? `${target.rel}/${dirent.name}` : dirent.name;
    const type: FileEntryType = dirent.isSymbolicLink()
      ? "symlink"
      : dirent.isDirectory()
        ? "dir"
        : "file";
    const entry: FileEntry = { name: dirent.name, path: entryPath, type, ignored: false };
    if (type === "file") {
      const info = await lstat(join(target.abs, dirent.name)).catch(() => undefined);
      if (info?.isFile()) entry.size = info.size;
    }
    entries.push(entry);
  }

  entries.sort((a, b) => {
    const groupA = a.type === "dir" ? 0 : 1;
    const groupB = b.type === "dir" ? 0 : 1;
    if (groupA !== groupB) return groupA - groupB;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
  // Truncate before the per-entry git work, not after.
  const limited = entries.slice(0, MAX_TREE_ENTRIES);

  const status = await gitStatus(realCwd);
  const ignored = await ignoredPaths(realCwd, limited, status.isRepo);

  const changed = new Map<string, FileEntry["git"]>();
  const dirtyDirs = new Set<string>();
  if (status.isRepo) {
    for (const file of status.files) {
      const kind = file.unstaged ?? file.staged;
      if (kind) changed.set(file.path, kind);
      const segments = file.path.split("/");
      for (let i = 1; i < segments.length; i++) dirtyDirs.add(segments.slice(0, i).join("/"));
    }
  }

  for (const entry of limited) {
    entry.ignored = entry.name === ".git" || ignored.has(entry.path);
    const kind = entry.type === "dir" ? (dirtyDirs.has(entry.path) ? "modified" : undefined) : changed.get(entry.path);
    if (kind) entry.git = kind;
  }

  return { cwd: realCwd, path: target.rel, entries: limited };
}

/** One `git check-ignore` call for the whole directory level. */
async function ignoredPaths(cwd: string, entries: FileEntry[], isRepo: boolean): Promise<Set<string>> {
  const candidates = entries.filter((entry) => entry.name !== ".git").map((entry) => entry.path);
  const ignored = new Set<string>();
  if (!isRepo || candidates.length === 0) return ignored;

  const result = await runGit(cwd, ["check-ignore", "-z", "--stdin"], `${candidates.join("\0")}\0`).catch(
    () => undefined,
  );
  if (!result || result.code !== 0) return ignored; // exit 1 = nothing ignored
  for (const path of result.stdout.toString("utf8").split("\0")) {
    if (path) ignored.add(path);
  }
  return ignored;
}

// --------------------------------------------------------------------- read

export async function readFileContent(cwd: string, rel: string): Promise<FileReadResponse> {
  const target = await resolveInside(cwd, rel);
  const info = await stat(target.abs);
  if (info.isDirectory()) throw new HttpError(400, "是目录");

  const name = basename(target.abs);
  const base = { path: target.rel, size: info.size, modified: info.mtime.toISOString() };
  const image = IMAGE_TYPES[extname(name).slice(1).toLowerCase()];
  if (image) return { ...base, kind: "image", mimeType: image };

  const handle = await open(target.abs, "r");
  try {
    const sniff = Buffer.alloc(SNIFF_BYTES);
    const head = await handle.read(sniff, 0, SNIFF_BYTES, 0);
    if (sniff.subarray(0, head.bytesRead).includes(0)) return { ...base, kind: "binary" };

    const length = Math.min(info.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    const body = await handle.read(buffer, 0, length, 0);
    const text = trimIncompleteUtf8(buffer.subarray(0, body.bytesRead)).toString("utf8");
    return {
      ...base,
      kind: "text",
      text,
      ...(info.size > MAX_TEXT_BYTES ? { truncated: true } : {}),
      ...languageOf(name),
    };
  } finally {
    await handle.close();
  }
}

function languageOf(name: string): { language?: string } {
  const lower = name.toLowerCase();
  if (lower === "dockerfile") return { language: "dockerfile" };
  if (lower === "makefile") return { language: "makefile" };
  const language = LANGUAGES[extname(lower).slice(1)];
  return language ? { language } : {};
}

// ---------------------------------------------------------------------- raw

export interface RawFile {
  abs: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

export async function openRawFile(cwd: string, rel: string): Promise<RawFile> {
  const target = await resolveInside(cwd, rel);
  const info = await stat(target.abs);
  if (info.isDirectory()) throw new HttpError(400, "是目录");

  const name = basename(target.abs);
  const ext = extname(name).slice(1).toLowerCase();
  const mimeType =
    MIME_TYPES[ext] ?? (PLAIN_TEXT_EXTS.has(ext) ? "text/plain; charset=utf-8" : "application/octet-stream");
  return { abs: target.abs, path: target.rel, name, size: info.size, mimeType };
}
