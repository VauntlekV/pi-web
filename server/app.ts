import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { streamSSE } from "hono/streaming";
import { ModelRuntime, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ConfigResponse,
  CreateSessionRequest,
  ExtensionUiResponse,
  ImageContent,
  ModelInfo,
  ModelsResponse,
  PromptRequest,
  ThinkingLevel,
} from "../shared/protocol.ts";
import { authCookie, createAuth, safeEqual } from "./auth.ts";
import { listDirectories, listFiles } from "./fs.ts";
import { HttpError, jsonBody } from "./http-error.ts";
import type { SessionRegistry } from "./registry.ts";
import { registerFilesGitRoutes } from "./routes/files-git.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { getGlobalRuntime } from "./settings/runtime-cache.ts";

export interface AppDeps {
  registry: SessionRegistry;
  auth: { token: string; noAuth: boolean };
  defaultCwd: string;
  agentDir: string;
  version?: string;
  piVersion?: string;
  settingsManager?: SettingsManager;
  modelRuntime?: ModelRuntime;
  /** Absolute path to the built web app (`dist/web`); mounted when it exists. */
  staticDir?: string;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const auth = createAuth(deps.auth);
  const version = deps.version ?? packageVersion();
  const piVersion = deps.piVersion ?? VERSION;

  const settings = (): SettingsManager =>
    deps.settingsManager ?? SettingsManager.create(deps.defaultCwd, deps.agentDir);

  const runtime = (): Promise<ModelRuntime> => getGlobalRuntime(deps);

  // `/?token=...` sets the cookie, then redirects without the token.
  app.use("*", async (c, next) => {
    if (auth.noAuth || (c.req.method !== "GET" && c.req.method !== "HEAD")) return next();
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/api/")) return next();
    const token = url.searchParams.get("token");
    if (token === null) return next();
    if (!safeEqual(token, auth.token)) return next();
    url.searchParams.delete("token");
    c.header("Set-Cookie", authCookie(auth.token));
    return c.redirect(url.pathname + url.search, 302);
  });

  app.use("/api/*", auth.middleware);
  app.route("/", auth.routes);

  app.get("/api/health", (c) => c.json({ ok: true, version, piVersion }));

  app.get("/api/config", (c) => {
    const manager = settings();
    const provider = manager.getDefaultProvider();
    const modelId = manager.getDefaultModel();
    const response: ConfigResponse = {
      defaultCwd: deps.defaultCwd,
      home: homedir(),
      version,
      piVersion,
      defaultModel: provider && modelId ? { provider, id: modelId } : undefined,
      defaultThinkingLevel: (manager.getDefaultThinkingLevel() ?? "medium") as ThinkingLevel,
    };
    return c.json(response);
  });

  app.get("/api/workspaces", async (c) => c.json({ workspaces: await deps.registry.listWorkspaces() }));

  app.get("/api/models", async (c) => {
    const sessionId = c.req.query("sessionId");
    const live = sessionId ? deps.registry.peek(sessionId) : undefined;
    const modelRuntime = live ? live.session.modelRuntime : await runtime();
    const available = await modelRuntime.getAvailable();

    const manager = settings();
    const provider = manager.getDefaultProvider();
    const modelId = manager.getDefaultModel();
    const liveModel = live?.session.model;
    const defaultModel = provider && modelId
      ? { provider, id: modelId }
      : liveModel
        ? { provider: liveModel.provider, id: liveModel.id }
        : undefined;

    const response: ModelsResponse = { models: available.map(toModelInfo), defaultModel };
    return c.json(response);
  });

  app.get("/api/fs/list", (c) => c.json(listDirectories(c.req.query("path"))));

  app.get("/api/fs/files", async (c) => {
    const cwd = c.req.query("cwd");
    if (!cwd) throw new HttpError(400, "缺少 cwd");
    return c.json({ files: await listFiles(cwd, c.req.query("q")) });
  });

  // ------------------------------------------------------------------ sessions

  app.post("/api/sessions", async (c) => {
    const body = await jsonBody(c);
    const request: CreateSessionRequest = {
      cwd: typeof body.cwd === "string" ? body.cwd : deps.defaultCwd,
    };
    if (body.model !== undefined) {
      const model = body.model as { provider?: unknown; id?: unknown } | null;
      if (
        typeof model !== "object" ||
        model === null ||
        typeof model.provider !== "string" ||
        typeof model.id !== "string"
      ) {
        throw new HttpError(400, "model 必须是 { provider, id }");
      }
      request.model = { provider: model.provider, id: model.id };
    }
    if (body.thinkingLevel !== undefined) {
      if (typeof body.thinkingLevel !== "string") throw new HttpError(400, "thinkingLevel 必须是字符串");
      request.thinkingLevel = body.thinkingLevel as ThinkingLevel;
    }
    const live = await deps.registry.create(request);
    return c.json({ state: live.getState() });
  });

  app.get("/api/sessions/:id", async (c) => {
    const live = await deps.registry.get(c.req.param("id"));
    return c.json({ state: live.getState(), transcript: live.getTranscript() });
  });

  app.patch("/api/sessions/:id", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.name !== "string") throw new HttpError(400, "name 必须是字符串");
    const live = await deps.registry.get(c.req.param("id"));
    return c.json({ state: live.rename(body.name) });
  });

  app.delete("/api/sessions/:id", async (c) => {
    await deps.registry.delete(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/sessions/:id/commands", async (c) => {
    const live = await deps.registry.get(c.req.param("id"));
    return c.json({ commands: live.getCommands() });
  });

  app.get("/api/sessions/:id/events", async (c) => {
    const live = await deps.registry.get(c.req.param("id"));
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      let finished = false;
      let finish: () => void = () => {};
      const done = new Promise<void>((resolveDone) => {
        finish = () => {
          if (finished) return;
          finished = true;
          resolveDone();
        };
      });

      let removeClient = () => {};
      removeClient = live.addClient((event) => {
        stream
          .writeSSE({ data: JSON.stringify(event) })
          .then(() => {
            if (event.type === "closed") finish();
          })
          .catch(() => {
            removeClient();
            finish();
          });
      });

      const heartbeat = setInterval(() => {
        stream.write(": ping\n\n").catch(() => {
          removeClient();
          finish();
        });
      }, 15_000);
      heartbeat.unref?.();

      stream.onAbort(() => finish());
      await done;
      clearInterval(heartbeat);
      removeClient();
    });
  });

  app.post("/api/sessions/:id/prompt", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.text !== "string") throw new HttpError(400, "text 必须是字符串");
    if (body.behavior !== undefined && body.behavior !== "steer" && body.behavior !== "followUp") {
      throw new HttpError(400, "behavior 必须是 steer 或 followUp");
    }
    const request: PromptRequest = {
      text: body.text,
      ...(body.images === undefined ? {} : { images: parseImages(body.images) }),
      ...(body.behavior === undefined ? {} : { behavior: body.behavior }),
    };
    const live = await deps.registry.get(c.req.param("id"));
    await live.prompt(request);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/abort", async (c) => {
    const live = await deps.registry.get(c.req.param("id"));
    await live.abort();
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/model", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.provider !== "string" || typeof body.id !== "string") {
      throw new HttpError(400, "需要 provider 和 id");
    }
    const live = await deps.registry.get(c.req.param("id"));
    return c.json({ state: await live.setModel({ provider: body.provider, id: body.id }) });
  });

  app.post("/api/sessions/:id/thinking", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.level !== "string") throw new HttpError(400, "level 必须是字符串");
    const live = await deps.registry.get(c.req.param("id"));
    return c.json({ state: live.setThinking(body.level as ThinkingLevel) });
  });

  app.post("/api/sessions/:id/compact", async (c) => {
    const body = await jsonBody(c);
    if (body.instructions !== undefined && typeof body.instructions !== "string") {
      throw new HttpError(400, "instructions 必须是字符串");
    }
    const live = await deps.registry.get(c.req.param("id"));
    live.compact(body.instructions as string | undefined);
    return c.json({ ok: true });
  });

  app.post("/api/sessions/:id/ui-response", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.id !== "string") throw new HttpError(400, "缺少请求 id");
    const live = await deps.registry.get(c.req.param("id"));
    live.respondExtensionUi(body as unknown as ExtensionUiResponse);
    return c.json({ ok: true });
  });

  registerFilesGitRoutes(app, deps);
  registerSettingsRoutes(app, deps);

  // ------------------------------------------------------------------- static

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      return c.json({ error: error.message }, error.status as ContentfulStatusCode);
    }
    console.error("[pi-web] 未处理的错误:", error);
    return c.json({ error: "internal error" }, 500);
  });

  if (deps.staticDir) {
    const staticDir = deps.staticDir;
    const indexFile = join(staticDir, "index.html");
    if (existsSync(indexFile)) {
      app.use("*", serveStatic({ root: staticDir }));
      app.get("*", (c) => {
        if (c.req.path.startsWith("/api/")) return c.json({ error: "not found" }, 404);
        return c.html(readFileSync(indexFile, "utf8"));
      });
    }
  }

  app.notFound((c) => c.json({ error: "not found" }, 404));

  return app;
}

// -------------------------------------------------------------------- helpers

function parseImages(value: unknown): ImageContent[] {
  if (!Array.isArray(value)) throw new HttpError(400, "images 必须是数组");
  return value as ImageContent[];
}

export function toModelInfo(model: Model<string>): ModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    vision: model.input.includes("image"),
  };
}

function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of ["../package.json", "../../../package.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(here, candidate), "utf8")) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // Try the next layout (source vs dist/server/server).
    }
  }
  return "0.0.0";
}
