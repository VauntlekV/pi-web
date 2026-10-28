/**
 * Workspace routes (/api/workspaces): the folders pi-web lists. Adding or
 * archiving only touches pi-web's own list; deleting also removes the
 * folder's session files, which the pi CLI shares.
 */
import { stat } from "node:fs/promises";
import type { Context, Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { HttpError, jsonBody } from "../http-error.ts";
import { workspaceStore } from "../workspaces.ts";

export function registerWorkspaceRoutes(app: Hono, deps: AppDeps): void {
  const store = workspaceStore(deps.agentDir);
  const list = async () => ({ workspaces: await deps.registry.listWorkspaces(await store.list()) });

  app.get("/api/workspaces", async (c) => c.json(await list()));

  app.post("/api/workspaces", async (c) => {
    const cwd = await directoryBody(c);
    await store.add(cwd);
    return c.json(await list());
  });

  app.patch("/api/workspaces", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.cwd !== "string") throw new HttpError(400, "缺少 cwd");
    if (typeof body.archived !== "boolean") throw new HttpError(400, "archived 必须是布尔值");
    if (!(await store.has(body.cwd))) throw new HttpError(404, "没有这个工作区");
    await store.setArchived(body.cwd, body.archived);
    return c.json(await list());
  });

  app.delete("/api/workspaces", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) throw new HttpError(400, "缺少 cwd");
    if (!(await store.has(cwd))) throw new HttpError(404, "没有这个工作区");
    const deleted = await deps.registry.deleteWorkspaceSessions(cwd);
    await store.remove(cwd);
    return c.json({ ...(await list()), deleted });
  });
}

async function directoryBody(c: Context): Promise<string> {
  const body = await jsonBody(c);
  if (typeof body.cwd !== "string" || !body.cwd.trim()) throw new HttpError(400, "缺少 cwd");
  const cwd = body.cwd.trim();
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new HttpError(400, `不是目录：${cwd}`);
  return cwd;
}
