/**
 * POST /api/git/message: a commit message for the pending changes, written by
 * the session's model with thinking off (a short reply should stay fast/cheap).
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { gitLog, gitStatus, runGit, trimIncompleteUtf8 } from "./git.ts";
import { HttpError } from "./http-error.ts";

const MAX_DIFF_BYTES = 24 * 1024;
const STYLE_SAMPLES = 10;

const SYSTEM_PROMPT =
  "You write git commit messages. Reply with only the commit message: a concise subject line " +
  "(imperative mood, at most 72 characters), optionally followed by a blank line and a short body " +
  "explaining why when the change is not obvious. Match the language and conventions (prefixes, " +
  "capitalization) of the recent commits. No code fences, quotes or commentary.";

/** Model output -> a commit message: no code fences or wrapping quotes, trimmed. */
export function cleanCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n?/g, "\n").trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  if (/^(["'`“])[\s\S]*(["'`”])$/.test(text) && !text.includes("\n")) text = text.slice(1, -1).trim();
  return text.replace(/\n{3,}/g, "\n\n");
}

/** The diff the message describes: staged changes, or everything when nothing is staged. */
async function pendingDiff(cwd: string): Promise<string> {
  const status = await gitStatus(cwd);
  if (!status.isRepo) throw new HttpError(400, "不是 git 仓库");
  const staged = status.files.some((file) => file.staged);
  if (!staged && status.files.length === 0) throw new HttpError(400, "没有可提交的改动");

  const base = ["--no-color", "--no-ext-diff"];
  const stat = await runGit(cwd, ["diff", ...(staged ? ["--cached"] : []), "--stat", ...base]);
  const diff = await runGit(cwd, ["diff", ...(staged ? ["--cached"] : []), ...base]);
  let patch = diff.stdout.length > MAX_DIFF_BYTES
    ? `${trimIncompleteUtf8(diff.stdout.subarray(0, MAX_DIFF_BYTES)).toString("utf8")}\n[diff truncated]`
    : diff.stdout.toString("utf8");

  const untracked = staged ? [] : status.files.filter((file) => file.unstaged === "untracked");
  if (untracked.length > 0) patch += `\nNew untracked files:\n${untracked.map((file) => file.path).join("\n")}`;
  return `${stat.stdout.toString("utf8")}\n${patch}`.trim();
}

export async function generateCommitMessage(
  runtime: ModelRuntime,
  model: Model<Api>,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const diff = await pendingDiff(cwd);
  const recent = await gitLog(cwd, STYLE_SAMPLES).catch(() => []);
  const style = recent.length > 0 ? recent.map((commit) => `- ${commit.subject}`).join("\n") : "(none yet)";

  // `reasoning` omitted = thinking off.
  const response = await runtime.completeSimple(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Recent commits:\n${style}\n\nChanges to commit:\n<diff>\n${diff}\n</diff>`,
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens: 1024, signal },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new HttpError(502, response.errorMessage || "模型调用失败");
  }
  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("");
  const message = cleanCommitMessage(text);
  if (!message) throw new HttpError(502, "模型没有返回提交信息");
  return message;
}
