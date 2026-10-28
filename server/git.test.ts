import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitCommit, GitDiffResponse, GitStatus } from "../shared/protocol.ts";
import { cleanCommitMessage } from "./commit-message.ts";
import { parseRefs } from "./git.ts";
import { createHarness, type Harness } from "./testing.ts";

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({ noAuth: true });
});

afterAll(async () => {
  await harness.close();
});

type Params = Record<string, string | undefined>;

interface CommitResponse {
  commit: GitCommit;
  status: GitStatus;
}

function request(path: string, params: Params): Promise<Response> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
  return harness.app.request(`${path}?${search.toString()}`);
}

async function get<T>(path: string, params: Params): Promise<T> {
  const response = await request(path, params);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function post(path: string, body: unknown): Promise<Response> {
  return harness.app.request(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await post(path, body);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function plainDir(name: string): Promise<string> {
  const dir = join(harness.cwd, name);
  return mkdir(dir, { recursive: true }).then(() => dir);
}

async function gitRepo(name: string): Promise<string> {
  const dir = await plainDir(name);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", message]);
}

describe("git status", () => {
  it("reports a plain directory as not a repository", async () => {
    const cwd = await realpath(await plainDir("status-plain"));
    expect(await get<GitStatus>("/api/git/status", { cwd })).toEqual({
      isRepo: false,
      ahead: 0,
      behind: 0,
      files: [],
    });
  });

  it("reports an empty repository without commits", async () => {
    const cwd = await realpath(await gitRepo("status-empty"));
    const status = await get<GitStatus>("/api/git/status", { cwd });
    expect(status).toMatchObject({ isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] });
    expect(status.root).toBe(cwd);
  });

  it("parses modified, staged, deleted, renamed, untracked and odd file names", async () => {
    const root = await gitRepo("status-kinds");
    await writeFile(join(root, "mod.txt"), "one");
    await writeFile(join(root, "gone.txt"), "bye");
    await writeFile(join(root, "old.txt"), "old");
    commitAll(root, "init");

    await writeFile(join(root, "mod.txt"), "two");
    await writeFile(join(root, "new.txt"), "new");
    git(root, ["add", "new.txt"]);
    await unlink(join(root, "gone.txt"));
    git(root, ["mv", "old.txt", "renamed.txt"]);
    await writeFile(join(root, "loose.txt"), "loose");
    await writeFile(join(root, "hello world.txt"), "x");
    await writeFile(join(root, "中文 文件.txt"), "x");

    const status = await get<GitStatus>("/api/git/status", { cwd: await realpath(root) });
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    const byPath = new Map(status.files.map((file) => [file.path, file]));
    expect(byPath.get("mod.txt")).toEqual({ path: "mod.txt", unstaged: "modified" });
    expect(byPath.get("new.txt")).toEqual({ path: "new.txt", staged: "added" });
    expect(byPath.get("gone.txt")).toEqual({ path: "gone.txt", unstaged: "deleted" });
    expect(byPath.get("renamed.txt")).toEqual({
      path: "renamed.txt",
      staged: "renamed",
      origPath: "old.txt",
    });
    expect(byPath.get("loose.txt")).toEqual({ path: "loose.txt", unstaged: "untracked" });
    expect(byPath.get("hello world.txt")).toEqual({ path: "hello world.txt", unstaged: "untracked" });
    expect(byPath.get("中文 文件.txt")).toEqual({ path: "中文 文件.txt", unstaged: "untracked" });
  });

  it("reports paths relative to cwd when cwd is a subdirectory", async () => {
    const root = await gitRepo("status-sub");
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "root.txt"), "r");
    await writeFile(join(root, "sub", "inner.txt"), "i");
    commitAll(root, "init");
    await writeFile(join(root, "root.txt"), "r2");
    await writeFile(join(root, "sub", "inner.txt"), "i2");
    await writeFile(join(root, "sub", "loose.txt"), "l");

    const cwd = await realpath(join(root, "sub"));
    const status = await get<GitStatus>("/api/git/status", { cwd });
    expect(status.root).toBe(await realpath(root));
    const byPath = new Map(status.files.map((file) => [file.path, file]));
    expect(byPath.get("inner.txt")).toEqual({ path: "inner.txt", unstaged: "modified" });
    expect(byPath.get("../root.txt")).toEqual({ path: "../root.txt", unstaged: "modified" });
    expect(byPath.get("loose.txt")).toEqual({ path: "loose.txt", unstaged: "untracked" });
  });

  it("tracks ahead and behind against an upstream", async () => {
    const bare = join(harness.cwd, "remote.git");
    git(harness.cwd, ["init", "--bare", "-q", "-b", "main", bare]);

    const root = await gitRepo("ahead");
    await writeFile(join(root, "a.txt"), "a");
    commitAll(root, "init");
    git(root, ["remote", "add", "origin", bare]);
    git(root, ["push", "-q", "-u", "origin", "main"]);

    await writeFile(join(root, "b.txt"), "b");
    commitAll(root, "local");

    const clone = join(harness.cwd, "clone");
    git(harness.cwd, ["clone", "-q", bare, clone]);
    await writeFile(join(clone, "remote.txt"), "r");
    git(clone, ["add", "-A"]);
    git(clone, ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "remote"]);
    git(clone, ["push", "-q", "origin", "main"]);
    git(root, ["fetch", "-q", "origin"]);

    // One request after all git work: the 2 s status cache only sees the end state.
    const status = await get<GitStatus>("/api/git/status", { cwd: await realpath(root) });
    expect(status).toMatchObject({
      isRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 1,
    });
  });
});

describe("git diff", () => {
  it("diffs staged, unstaged, untracked, deleted and binary files", async () => {
    const root = await gitRepo("diff");
    await writeFile(join(harness.cwd, "outside.txt"), "x");
    await writeFile(join(root, "tracked.txt"), "old\n");
    await writeFile(join(root, "work.txt"), "a\n");
    await writeFile(join(root, "gone.txt"), "gone\n");
    await writeFile(join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    commitAll(root, "init");

    await writeFile(join(root, "tracked.txt"), "new\n");
    git(root, ["add", "tracked.txt"]);
    await writeFile(join(root, "work.txt"), "b\n");
    await writeFile(join(root, "fresh.txt"), "fresh\n");
    await unlink(join(root, "gone.txt"));
    await writeFile(join(root, "bin.dat"), Buffer.from([0x00, 0x09, 0x09]));

    const cwd = await realpath(root);
    const diff = (path: string, staged: boolean) =>
      get<GitDiffResponse>("/api/git/diff", { cwd, path, staged: staged ? "1" : "0" });

    const staged = await diff("tracked.txt", true);
    expect(staged).toMatchObject({ path: "tracked.txt", staged: true, binary: false, truncated: false });
    expect(staged.diff).toContain("-old");
    expect(staged.diff).toContain("+new");

    expect((await diff("tracked.txt", false)).diff).toBe("");

    const unstaged = await diff("work.txt", false);
    expect(unstaged.staged).toBe(false);
    expect(unstaged.diff).toContain("-a");
    expect(unstaged.diff).toContain("+b");

    const untracked = await diff("fresh.txt", false);
    expect(untracked.diff).toContain("+fresh");

    const deleted = await diff("gone.txt", false);
    expect(deleted.diff).toContain("deleted file mode");

    const binary = await diff("bin.dat", false);
    expect(binary).toMatchObject({ binary: true, diff: "" });

    expect((await request("/api/git/diff", { cwd, path: "../outside.txt" })).status).toBe(400);
    expect((await request("/api/git/diff", { cwd: join(cwd, "nope"), path: "a.txt" })).status).toBe(400);
  });
});

describe("git log", () => {
  it("returns an empty list for a repository without commits", async () => {
    const cwd = await realpath(await gitRepo("log-empty"));
    expect(await get<{ commits: GitCommit[] }>("/api/git/log", { cwd })).toEqual({ commits: [] });
  });

  it("honors limit and reports commit fields", async () => {
    const root = await gitRepo("log");
    for (const subject of ["one", "two", "three"]) {
      await writeFile(join(root, "file.txt"), subject);
      commitAll(root, subject);
    }
    const cwd = await realpath(root);
    const log = (limit?: string) => get<{ commits: GitCommit[] }>("/api/git/log", { cwd, limit });

    const latest = (await log("2")).commits;
    expect(latest.map((commit) => commit.subject)).toEqual(["three", "two"]);
    expect(latest[0].hash).toMatch(/^[0-9a-f]{40}$/);
    expect(latest[0].short).toBe(latest[0].hash.slice(0, 7));
    expect(latest[0].author).toBe("Test");
    expect(Number.isFinite(Date.parse(latest[0].date))).toBe(true);

    expect((await log("0")).commits).toHaveLength(3);
    expect((await log("abc")).commits).toHaveLength(3);
    expect((await log("999")).commits).toHaveLength(3);
    expect((await log()).commits).toHaveLength(3);
  });

  it("reports parents and refs, and with all=1 includes other branches", async () => {
    const root = await gitRepo("log-graph");
    await writeFile(join(root, "file.txt"), "base");
    commitAll(root, "base");
    git(root, ["checkout", "-q", "-b", "feature/x"]);
    await writeFile(join(root, "feature.txt"), "f");
    commitAll(root, "feature");
    git(root, ["checkout", "-q", "main"]);
    git(root, ["tag", "v1"]);
    const cwd = await realpath(root);

    const head = (await get<{ commits: GitCommit[] }>("/api/git/log", { cwd })).commits;
    expect(head.map((commit) => commit.subject)).toEqual(["base"]);
    expect(head[0].parents).toEqual([]);
    expect(head[0].refs).toEqual([
      { name: "main", kind: "head" },
      { name: "v1", kind: "tag" },
    ]);

    const all = (await get<{ commits: GitCommit[] }>("/api/git/log", { cwd, all: "1" })).commits;
    expect(all.map((commit) => commit.subject)).toEqual(["feature", "base"]);
    expect(all[0].parents).toEqual([all[1].hash]);
    expect(all[0].refs).toEqual([{ name: "feature/x", kind: "branch" }]);
  });

  it("parses decorations into typed refs", () => {
    expect(parseRefs("HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1")).toEqual([
      { name: "main", kind: "head" },
      { name: "origin/main", kind: "remote" },
      { name: "v1", kind: "tag" },
    ]);
    expect(parseRefs("HEAD, refs/heads/a/b")).toEqual([
      { name: "HEAD", kind: "head" },
      { name: "a/b", kind: "branch" },
    ]);
  });
});

describe("git push and pull", () => {
  it("publishes a new branch, then pulls a commit pushed from another clone", async () => {
    const bare = join(harness.cwd, "sync-remote.git");
    git(harness.cwd, ["init", "--bare", "-q", "-b", "main", bare]);
    const root = await gitRepo("sync");
    await writeFile(join(root, "a.txt"), "a");
    commitAll(root, "first");
    const cwd = await realpath(root);

    expect(await (await post("/api/git/push", { cwd })).text()).toContain("没有配置远程仓库");
    git(root, ["remote", "add", "origin", bare]);

    const pushed = await postJson<GitStatus>("/api/git/push", { cwd });
    expect(pushed.upstream).toBe("origin/main");
    expect(pushed.ahead).toBe(0);

    const clone = join(harness.cwd, "sync-clone");
    git(harness.cwd, ["clone", "-q", bare, clone]);
    await writeFile(join(clone, "b.txt"), "b");
    git(clone, ["add", "-A"]);
    git(clone, ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "remote"]);
    git(clone, ["push", "-q", "origin", "main"]);

    const pulled = await postJson<GitStatus>("/api/git/pull", { cwd });
    expect(pulled.behind).toBe(0);
    const log = await get<{ commits: GitCommit[] }>("/api/git/log", { cwd, limit: "1" });
    expect(log.commits[0].subject).toBe("remote");

    // Diverged: refuse instead of creating a merge commit.
    await writeFile(join(clone, "c.txt"), "c");
    git(clone, ["add", "-A"]);
    git(clone, ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "remote 2"]);
    git(clone, ["push", "-q", "origin", "main"]);
    await writeFile(join(root, "d.txt"), "d");
    commitAll(root, "local");
    const diverged = await post("/api/git/pull", { cwd });
    expect(diverged.status).toBe(400);
    expect(await diverged.text()).toContain("已分叉");
    expect(git(root, ["log", "-1", "--format=%s"]).trim()).toBe("local");
  });
});

describe("commit message cleanup", () => {
  it("strips code fences and wrapping quotes", () => {
    expect(cleanCommitMessage("```\nfix: a\n\nbody\n```")).toBe("fix: a\n\nbody");
    expect(cleanCommitMessage('"Add graph view"')).toBe("Add graph view");
    expect(cleanCommitMessage("  subject\r\n\r\n\r\n\r\nbody  ")).toBe("subject\n\nbody");
  });
});

describe("git stage, unstage and commit", () => {
  it("round-trips stage and unstage, then commits a clean tree", async () => {
    const root = await gitRepo("write");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const cwd = await realpath(root);

    const staged = await postJson<GitStatus>("/api/git/stage", { cwd, paths: ["a.txt"] });
    expect(staged.files).toEqual([
      { path: "a.txt", staged: "added" },
      { path: "b.txt", unstaged: "untracked" },
    ]);

    const unstaged = await postJson<GitStatus>("/api/git/unstage", { cwd, paths: ["a.txt"] });
    expect(unstaged.files).toEqual([
      { path: "a.txt", unstaged: "untracked" },
      { path: "b.txt", unstaged: "untracked" },
    ]);

    await postJson<GitStatus>("/api/git/stage", { cwd, paths: ["a.txt", "b.txt"] });
    const committed = await postJson<CommitResponse>("/api/git/commit", { cwd, message: "first" });
    expect(committed.commit.subject).toBe("first");
    expect(committed.commit.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(committed.status.files).toEqual([]);

    const log = await get<{ commits: GitCommit[] }>("/api/git/log", { cwd, limit: "1" });
    expect(log.commits[0].hash).toBe(committed.commit.hash);

    expect((await post("/api/git/commit", { cwd, message: "   " })).status).toBe(400);
    const nothing = await post("/api/git/commit", { cwd, message: "again" });
    expect(nothing.status).toBe(400);
    expect(await nothing.text()).toContain("没有暂存的改动");

    expect((await post("/api/git/stage", { cwd, paths: [] })).status).toBe(400);
    expect((await post("/api/git/stage", { cwd, paths: ["../outside.txt"] })).status).toBe(400);
  });

  it("unstages in a repository without HEAD", async () => {
    const root = await gitRepo("write-empty");
    await writeFile(join(root, "a.txt"), "a");
    const cwd = await realpath(root);

    const staged = await postJson<GitStatus>("/api/git/stage", { cwd, paths: ["a.txt"] });
    expect(staged.files).toEqual([{ path: "a.txt", staged: "added" }]);

    const unstaged = await postJson<GitStatus>("/api/git/unstage", { cwd, paths: ["a.txt"] });
    expect(unstaged.files).toEqual([{ path: "a.txt", unstaged: "untracked" }]);
  });
});
