/**
 * Workspace file browsing and git routes (/api/files/*, /api/git/*).
 * See the "v2: workspace files & git" section of shared/protocol.ts.
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { Context, Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { openRawFile, readFileContent, readTree, resolveForGit, resolveWorkspace } from "../files.ts";
import { gitCommit, gitDiff, gitLog, gitStage, gitStatus, gitUnstage } from "../git.ts";
import { HttpError, jsonBody } from "../http-error.ts";

export function registerFilesGitRoutes(app: Hono, _deps: AppDeps): void {
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
    return c.json({ commits: await gitLog(cwd, c.req.query("limit")) });
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
}

// ------------------------------------------------------------------ helpers

function query(c: Context, name: string): string {
  const value = c.req.query(name);
  if (value === undefined) throw new HttpError(400, `缺少 ${name}`);
  return value;
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
