/**
 * Git plumbing for /api/git/* (see the "v2: workspace files & git" section of
 * shared/protocol.ts). Every command runs as `git -C <cwd>` with a timeout and
 * no optional locks, so it is safe to call while an agent session mutates files.
 */
import { execFile } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import type {
  GitChangeKind,
  GitCommit,
  GitDiffResponse,
  GitFileChange,
  GitRef,
  GitStatus,
} from "../shared/protocol.ts";
import { HttpError } from "./http-error.ts";

const GIT_TIMEOUT_MS = 10_000;
const REMOTE_TIMEOUT_MS = 120_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;
const DIFF_LIMIT = 512 * 1024;
const STATUS_TTL_MS = 2000;
const DEFAULT_LOG_LIMIT = 30;
const MAX_LOG_LIMIT = 200;

const KIND_BY_LETTER: Record<string, GitChangeKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "conflicted",
};

export interface GitRun {
  stdout: Buffer;
  stderr: string;
  code: number;
}

/** Run git for `cwd`; resolves with the exit code instead of throwing on it. */
export function runGit(cwd: string, args: string[], input?: string, timeout = GIT_TIMEOUT_MS): Promise<GitRun> {
  return new Promise((resolveRun, reject) => {
    const child = execFile(
      "git",
      ["-C", cwd, ...args],
      {
        timeout,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "buffer",
        env: {
          ...process.env,
          LC_ALL: "C",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          // No terminal to type a passphrase into: fail instead of hanging until the timeout.
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
        },
      },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
        const err = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
        if (!error) return resolveRun({ stdout: out, stderr: err, code: 0 });
        if ((error as { killed?: boolean }).killed) return resolveRun({ stdout: out, stderr: err || "git 超时", code: 124 });
        const code = (error as { code?: unknown }).code;
        // ENOENT (git missing) and timeouts: let the caller decide.
        if (typeof code === "number") return resolveRun({ stdout: out, stderr: err, code });
        reject(error);
      },
    );
    if (child.stdin) {
      // git may exit before reading stdin; the EPIPE is expected and harmless.
      child.stdin.on("error", () => {});
      child.stdin.end(input ?? "");
    }
  });
}

/** Cut a byte-truncated buffer back to the last complete UTF-8 sequence. */
export function trimIncompleteUtf8(buffer: Buffer): Buffer {
  for (let back = 1; back <= Math.min(4, buffer.length); back++) {
    const byte = buffer[buffer.length - back];
    if ((byte & 0xc0) === 0x80) continue; // continuation byte
    const needed = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
    return back < needed ? buffer.subarray(0, buffer.length - back) : buffer;
  }
  return buffer;
}

// ------------------------------------------------------------------- status

interface ParsedStatus {
  branch?: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

interface StatusCacheEntry {
  at: number;
  value: Promise<GitStatus>;
}

const statusCache = new Map<string, StatusCacheEntry>();

/** Repository status for `cwd`, cached for 2 seconds per directory. */
export function gitStatus(cwd: string): Promise<GitStatus> {
  const key = resolve(cwd);
  const cached = statusCache.get(key);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const value = loadStatus(cwd);
  statusCache.set(key, { at: Date.now(), value });
  value.catch(() => statusCache.delete(key));
  return value;
}

/** Drop the cached status after a write operation. */
export function invalidateGitStatus(cwd: string): void {
  statusCache.delete(resolve(cwd));
}

async function loadStatus(cwd: string): Promise<GitStatus> {
  let top: GitRun;
  try {
    top = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return { isRepo: false, ahead: 0, behind: 0, files: [] };
  }
  if (top.code !== 0) return { isRepo: false, ahead: 0, behind: 0, files: [] };

  const root = top.stdout.toString("utf8").replace(/\n$/, "");
  const status = await runGit(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  if (status.code !== 0) throw new HttpError(400, status.stderr.trim() || "git status 失败");

  const parsed = parseStatus(status.stdout, cwd, root);
  return {
    isRepo: true,
    root,
    ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
    ...(parsed.upstream === undefined ? {} : { upstream: parsed.upstream }),
    ahead: parsed.ahead,
    behind: parsed.behind,
    files: parsed.files,
  };
}

function parseStatus(raw: Buffer, cwd: string, root: string): ParsedStatus {
  const parsed: ParsedStatus = { ahead: 0, behind: 0, files: [] };
  // Paths can contain any byte but NUL, so -z keeps spaces, CJK and newlines intact.
  const records = raw.toString("utf8").split("\0");

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record === "") continue;

    if (record.startsWith("# ")) {
      if (record.startsWith("# branch.head ")) {
        const head = record.slice("# branch.head ".length);
        parsed.branch = head === "(detached)" ? null : head;
      } else if (record.startsWith("# branch.upstream ")) {
        parsed.upstream = record.slice("# branch.upstream ".length);
      } else if (record.startsWith("# branch.ab ")) {
        const match = /^\+(\d+) -(\d+)$/.exec(record.slice("# branch.ab ".length));
        if (match) {
          parsed.ahead = Number(match[1]);
          parsed.behind = Number(match[2]);
        }
      }
      continue;
    }

    const kind = record[0];
    if (kind === "?") {
      parsed.files.push({ path: cwdPath(cwd, root, record.slice(2)), unstaged: "untracked" });
    } else if (kind === "1") {
      const { fields, rest } = splitFields(record.slice(2), 7);
      pushChange(parsed.files, cwd, root, rest, fields[0]);
    } else if (kind === "2") {
      const { fields, rest } = splitFields(record.slice(2), 8);
      const origPath = records[index + 1] ?? "";
      index++;
      pushChange(parsed.files, cwd, root, rest, fields[0], origPath);
    } else if (kind === "u") {
      const { rest } = splitFields(record.slice(2), 10);
      parsed.files.push({ path: cwdPath(cwd, root, rest), unstaged: "conflicted" });
    }
    // "!" ignored entries are intentionally skipped.
  }

  return parsed;
}

function splitFields(record: string, count: number): { fields: string[]; rest: string } {
  const fields: string[] = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const space = record.indexOf(" ", at);
    if (space === -1) return { fields, rest: "" };
    fields.push(record.slice(at, space));
    at = space + 1;
  }
  return { fields, rest: record.slice(at) };
}

function pushChange(
  files: GitFileChange[],
  cwd: string,
  root: string,
  path: string,
  xy: string | undefined,
  origPath?: string,
): void {
  if (!path) return;
  const change: GitFileChange = { path: cwdPath(cwd, root, path) };
  if (origPath) change.origPath = cwdPath(cwd, root, origPath);
  const staged = KIND_BY_LETTER[xy?.[0] ?? ""];
  const unstaged = KIND_BY_LETTER[xy?.[1] ?? ""];
  if (staged) change.staged = staged;
  if (unstaged) change.unstaged = unstaged;
  if (change.staged || change.unstaged) files.push(change);
}

/** Porcelain paths are repository-relative; responses are cwd-relative. */
function cwdPath(cwd: string, root: string, repositoryPath: string): string {
  return relative(cwd, join(root, repositoryPath)).split(sep).join("/");
}

// --------------------------------------------------------------------- diff

export async function gitDiff(cwd: string, path: string, staged: boolean): Promise<GitDiffResponse> {
  const status = await gitStatus(cwd);
  if (!status.isRepo) throw new HttpError(400, "不是 git 仓库");

  const change = status.files.find((file) => file.path === path);
  const untracked = change?.unstaged === "untracked";
  const args = staged
    ? ["diff", "--cached", "--no-color", "--no-ext-diff", "--", path]
    : untracked
      ? ["diff", "--no-index", "--no-color", "--", "/dev/null", path]
      : ["diff", "--no-color", "--no-ext-diff", "--", path];

  const result = await runGit(cwd, args);
  // `--no-index` (and a plain diff of a change) exits 1 when there is output.
  if (result.code > 1) throw new HttpError(400, result.stderr.trim() || "git diff 失败");

  const text = result.stdout.toString("utf8");
  const binary = text.includes("Binary files ");
  const truncated = !binary && result.stdout.length > DIFF_LIMIT;
  const diff = binary
    ? ""
    : truncated
      ? trimIncompleteUtf8(result.stdout.subarray(0, DIFF_LIMIT)).toString("utf8")
      : text;

  return { path, staged, diff, binary, truncated };
}

// ---------------------------------------------------------------------- log

/** Recent commits of HEAD, or with `all` of every branch, remote and tag (graph order). */
export async function gitLog(cwd: string, limit?: string | number, all = false): Promise<GitCommit[]> {
  const count = normalizeLimit(limit);
  const result = await runGit(cwd, [
    "log",
    "-n",
    String(count),
    "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%P%x1f%D%x1e",
    // Full ref names tell a local "feature/x" from a remote "origin/x".
    "--decorate=full",
    ...(all ? ["--topo-order", "--branches", "--remotes", "--tags", "HEAD"] : []),
  ]);
  if (result.code !== 0) {
    // A repository without commits has no log yet; that is not an error.
    if (/any commits yet|unknown revision|bad default revision/i.test(result.stderr)) return [];
    throw new HttpError(400, result.stderr.trim() || "git log 失败");
  }

  return result.stdout
    .toString("utf8")
    .split("\x1e")
    .flatMap((record): GitCommit[] => {
      const fields = record.replace(/^\n+/, "").split("\x1f");
      const [hash, short, subject, author, date, parents, refs] = fields;
      if (!hash || !short || !author || !date) return [];
      return [
        {
          hash,
          short,
          subject: subject ?? "",
          author,
          date,
          parents: parents ? parents.split(" ") : [],
          refs: refs ? parseRefs(refs) : [],
        },
      ];
    });
}

/** `%D` with --decorate=full: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". */
export function parseRefs(decoration: string): GitRef[] {
  return decoration.split(", ").flatMap((item): GitRef[] => {
    if (item === "HEAD") return [{ name: "HEAD", kind: "head" }];
    if (item.startsWith("HEAD -> refs/heads/")) return [{ name: item.slice(19), kind: "head" }];
    if (item.startsWith("tag: refs/tags/")) return [{ name: item.slice(15), kind: "tag" }];
    if (item.startsWith("refs/heads/")) return [{ name: item.slice(11), kind: "branch" }];
    // refs/remotes/origin/HEAD only repeats the remote's default branch.
    if (item.startsWith("refs/remotes/") && !item.endsWith("/HEAD")) return [{ name: item.slice(13), kind: "remote" }];
    return [];
  });
}

function normalizeLimit(limit?: string | number): number {
  const value = typeof limit === "number" ? limit : Number(limit ?? "");
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LOG_LIMIT;
  return Math.min(Math.floor(value), MAX_LOG_LIMIT);
}

// -------------------------------------------------------------- write side

export async function gitStage(cwd: string, paths: string[]): Promise<GitStatus> {
  const result = await runGit(cwd, ["add", "--", ...paths]);
  if (result.code !== 0) throw new HttpError(400, result.stderr.trim() || "git add 失败");
  invalidateGitStatus(cwd);
  return gitStatus(cwd);
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<GitStatus> {
  const head = await runGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  const args =
    head.code === 0
      ? ["restore", "--staged", "--", ...paths]
      : ["rm", "--cached", "-r", "-q", "--", ...paths];
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new HttpError(400, result.stderr.trim() || "git unstage 失败");
  invalidateGitStatus(cwd);
  return gitStatus(cwd);
}

export async function gitCommit(
  cwd: string,
  message: string,
): Promise<{ commit: GitCommit; status: GitStatus }> {
  const text = message.trim();
  if (!text) throw new HttpError(400, "提交信息不能为空");

  const staged = await runGit(cwd, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) throw new HttpError(400, "没有暂存的改动");

  const result = await runGit(cwd, ["commit", "-m", text]);
  // Hooks are not skipped on purpose: their stderr is the useful message.
  if (result.code !== 0) throw new HttpError(400, result.stderr.trim() || "git commit 失败");

  invalidateGitStatus(cwd);
  const [commit] = await gitLog(cwd, 1);
  if (!commit) throw new HttpError(400, "git commit 失败");
  return { commit, status: await gitStatus(cwd) };
}

export async function gitPull(cwd: string): Promise<GitStatus> {
  // Fast-forward only: a diverged branch fails instead of growing a merge commit nobody asked for.
  const result = await runGit(cwd, ["pull", "--ff-only"], undefined, REMOTE_TIMEOUT_MS);
  invalidateGitStatus(cwd);
  if (result.code !== 0) {
    if (/not possible to fast-forward|diverg/i.test(result.stderr)) {
      throw new HttpError(400, "本地和远程已分叉，无法快进拉取；请在终端里合并或变基");
    }
    throw new HttpError(400, remoteError(result, "git pull 失败"));
  }
  return gitStatus(cwd);
}

export async function gitPush(cwd: string): Promise<GitStatus> {
  const status = await gitStatus(cwd);
  if (!status.isRepo) throw new HttpError(400, "不是 git 仓库");
  if (!status.branch) throw new HttpError(400, "分离头指针无法推送");

  let args = ["push"];
  if (!status.upstream) {
    // First push of a branch: publish it to origin (or the only remote) and track it.
    const remotes = (await runGit(cwd, ["remote"])).stdout.toString("utf8").split("\n").filter(Boolean);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) throw new HttpError(400, "没有配置远程仓库");
    args = ["push", "-u", remote, status.branch];
  }
  const result = await runGit(cwd, args, undefined, REMOTE_TIMEOUT_MS);
  invalidateGitStatus(cwd);
  if (result.code !== 0) throw new HttpError(400, remoteError(result, "git push 失败"));
  return gitStatus(cwd);
}

function remoteError(result: GitRun, fallback: string): string {
  return result.stderr.trim() || result.stdout.toString("utf8").trim() || fallback;
}
