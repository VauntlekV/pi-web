/**
 * Workspace file browsing and git routes (/api/files/*, /api/git/*).
 * See the "v2: workspace files & git" section of shared/protocol.ts.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AppDeps } from "../app.ts";
import { generateCommitMessage } from "../commit-message.ts";
import { openRawFile, readFileContent, readTree, resolveForGit, resolveWorkspace } from "../files.ts";
import { gitCommit, gitDiff, gitLog, gitPull, gitPush, gitStage, gitStatus, gitUnstage } from "../git.ts";
import { HttpError, jsonBody } from "../http-error.ts";
import { getGlobalRuntime } from "../settings/runtime-cache.ts";

export function registerFilesGitRoutes(app: Hono, deps: AppDeps): void {
  // ------------------------------------------------------------------ files

  app.get("/api/files/tree", async (c) => c.json(await readTree(query(c, "cwd"), c.req.query("path") ?? "")));

  app.get("/api/files/read", async (c) =>
    c.json(await readFileContent(query(c, "cwd"), c.req.query("path") ?? "")),
  );

  app.get("/api/files/raw", async (c) => {
    const file = await openRawFile(query(c, "cwd"), c.req.query("path") ?? "");
    c.header("Content-Type", file.mimeType);
    c.header("Content-Length", String(file.size));
    c.header("X-Content-Type-Options", "nosniff");
    // A sandboxed document cannot run scripts even for svg/html.
    c.header("Content-Security-Policy", "sandbox");
    c.header("Content-Disposition", `inline; filename*=UTF-8''${encodeFilename(file.name)}`);
    return c.body(Readable.toWeb(createReadStream(file.abs)) as ReadableStream<Uint8Array>, 200);
  });

  // -------------------------------------------------------------------- git

  app.get("/api/git/status", async (c) => c.json(await gitStatus(await resolveWorkspace(query(c, "cwd")))));

  app.get("/api/git/diff", async (c) => {
    const cwd = await resolveWorkspace(query(c, "cwd"));
    const { rel } = await resolveForGit(cwd, c.req.query("path") ?? "");
    return c.json(await gitDiff(cwd, rel, c.req.query("staged") === "1"));
  });

  app.get("/api/git/log", async (c) => {
    const cwd = await resolveWorkspace(query(c, "cwd"));
    return c.json({ commits: await gitLog(cwd, c.req.query("limit"), c.req.query("all") === "1") });
  });

  app.post("/api/git/stage", async (c) => {
    const { cwd, paths } = await pathsBody(c);
    return c.json(await gitStage(cwd, paths));
  });

  app.post("/api/git/unstage", async (c) => {
    const { cwd, paths } = await pathsBody(c);
    return c.json(await gitUnstage(cwd, paths));
  });

  app.post("/api/git/commit", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.cwd !== "string") throw new HttpError(400, "缺少 cwd");
    const cwd = await resolveWorkspace(body.cwd);
    if (typeof body.message !== "string" || body.message.trim() === "") {
      throw new HttpError(400, "提交信息不能为空");
    }
    return c.json(await gitCommit(cwd, body.message));
  });

  app.post("/api/git/pull", async (c) => c.json(await gitPull(await cwdBody(c))));

  app.post("/api/git/push", async (c) => c.json(await gitPush(await cwdBody(c))));

  app.post("/api/git/message", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.cwd !== "string") throw new HttpError(400, "缺少 cwd");
    const cwd = await resolveWorkspace(body.cwd);

    // The conversation's own model; on the home page, the default one.
    let runtime;
    let model;
    if (typeof body.sessionId === "string" && body.sessionId) {
      const live = await deps.registry.get(body.sessionId);
      runtime = live.session.modelRuntime;
      model = live.session.model;
    } else {
      runtime = await getGlobalRuntime(deps);
      const manager = deps.settingsManager ?? SettingsManager.create(deps.defaultCwd, deps.agentDir);
      const provider = manager.getDefaultProvider();
      const id = manager.getDefaultModel();
      model = provider && id ? runtime.getModel(provider, id) : undefined;
    }
    if (!model) throw new HttpError(400, "没有可用的模型");

    return c.json({ message: await generateCommitMessage(runtime, model, cwd, c.req.raw.signal) });
  });
}

// ------------------------------------------------------------------ helpers

function query(c: Context, name: string): string {
  const value = c.req.query(name);
  if (value === undefined) throw new HttpError(400, `缺少 ${name}`);
  return value;
}

async function cwdBody(c: Context): Promise<string> {
  const body = await jsonBody(c);
  if (typeof body.cwd !== "string") throw new HttpError(400, "缺少 cwd");
  return resolveWorkspace(body.cwd);
}

async function pathsBody(c: Context): Promise<{ cwd: string; paths: string[] }> {
  const body = await jsonBody(c);
  if (typeof body.cwd !== "string") throw new HttpError(400, "缺少 cwd");
  const cwd = await resolveWorkspace(body.cwd);

  const input = body.paths;
  if (!Array.isArray(input) || input.length === 0) throw new HttpError(400, "paths 必须是非空数组");
  if (input.length > 1000) throw new HttpError(400, "paths 最多 1000 项");

  const paths: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") throw new HttpError(400, "paths 必须是字符串数组");
    paths.push((await resolveForGit(cwd, item)).rel);
  }
  return { cwd, paths };
}

/** RFC 5987 value for `Content-Disposition`. */
function encodeFilename(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
