/**
 * Settings, providers, resources, packages, stats, ui-state, and the
 * session reload/export routes. See the "v2: settings, models, resources"
 * section of shared/protocol.ts.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Hono } from "hono";
import type { AppDeps } from "../app.ts";
import { HttpError, jsonBody } from "../http-error.ts";
import { runPackageCommand } from "../settings/packages.ts";
import { clearProviderKey, readProvidersView, setDefaultModel, setEnabledModels, setProviderKey } from "../settings/providers.ts";
import { readResources, toggleResource } from "../settings/resources.ts";
import { patchSettings, readSettingsFile, readSettingsView } from "../settings/settings.ts";
import { readUsageStats } from "../settings/stats.ts";
import { parseUiState, readUiState, saveUiState } from "../settings/ui-state.ts";

export function registerSettingsRoutes(app: Hono, deps: AppDeps): void {
  // ---------------------------------------------------------------- settings
  app.get("/api/settings", (c) => c.json(readSettingsView(deps)));
  app.patch("/api/settings", async (c) => c.json(await patchSettings(deps, await jsonBody(c))));
  app.get("/api/settings/file", (c) => c.json(readSettingsFile(deps)));

  // --------------------------------------------------------------- providers
  app.get("/api/providers", async (c) => c.json(await readProvidersView(deps)));
  app.put("/api/providers/:id/key", async (c) => c.json(await setProviderKey(deps, c.req.param("id"), await jsonBody(c))));
  app.delete("/api/providers/:id/key", async (c) => c.json(await clearProviderKey(deps, c.req.param("id"))));
  app.put("/api/default-model", async (c) => c.json(await setDefaultModel(deps, await jsonBody(c))));
  app.put("/api/enabled-models", async (c) => c.json(await setEnabledModels(deps, await jsonBody(c))));

  // --------------------------------------------------------------- resources
  app.get("/api/resources", async (c) => c.json(await readResources(deps, c.req.query("cwd"))));
  app.post("/api/resources/toggle", async (c) => c.json(await toggleResource(deps, await jsonBody(c))));

  // ---------------------------------------------------------------- packages
  app.post("/api/packages/install", async (c) => c.json(await runPackageCommand(deps, "install", await jsonBody(c))));
  app.post("/api/packages/remove", async (c) => c.json(await runPackageCommand(deps, "remove", await jsonBody(c))));
  app.post("/api/packages/update", async (c) => c.json(await runPackageCommand(deps, "update", await jsonBody(c))));

  // ---------------------------------------------------------------- sessions
  app.post("/api/sessions/:id/reload", async (c) => {
    const live = await deps.registry.get(c.req.param("id"));
    return c.json({ state: await live.reload() });
  });

  app.get("/api/sessions/:id/export", async (c) => {
    const id = c.req.param("id");
    const live = await deps.registry.get(id);
    const path = live.session.sessionFile;
    if (!path || !existsSync(path)) throw new HttpError(404, "会话尚未保存到磁盘");
    const text = await readFile(path, "utf8");
    return c.body(text, 200, {
      "Content-Type": "application/x-ndjson",
      "Content-Disposition": `attachment; filename="${id}.jsonl"`,
    });
  });

  // ------------------------------------------------------------------- stats
  app.get("/api/stats", async (c) => c.json(await readUsageStats(deps, c.req.query("range"))));

  // ---------------------------------------------------------------- ui state
  app.get("/api/ui-state", async (c) => c.json(await readUiState(deps.agentDir)));
  app.put("/api/ui-state", async (c) => c.json(await saveUiState(deps.agentDir, parseUiState(await jsonBody(c)))));
}
