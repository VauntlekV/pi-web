import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ModelDiscoveryResult,
  ModelsConfigSaved,
  ModelsConfigView,
  ModelsJson,
  ModelsJsonModel,
  ModelTestResult,
} from "../../shared/protocol.ts";
import { createHarness, type Harness } from "../testing.ts";
import { modelsListUrl, parseDiscoveredModels } from "./models-config.ts";

let harness: Harness;
let upstream: Server;
let baseUrl: string;
const seenAuth: string[] = [];

// A minimal OpenAI-compatible endpoint: a model list and a streamed "OK".
beforeAll(async () => {
  harness = await createHarness({ noAuth: true });
  upstream = createServer((request, response) => {
    seenAuth.push(request.headers.authorization ?? "");
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-big", context_length: 131072 }, { id: "local-small" }] }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      response.setHeader("content-type", "text/event-stream");
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", created: 0, model: "local-big", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.write(chunk({ role: "assistant", content: "OK" }, null));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((done) => upstream.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  upstream.close();
  await harness.close();
});

const call = (method: string, path: string, body?: unknown) =>
  harness.app.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

const local = (models: ModelsJsonModel[] = []): ModelsJson => ({
  providers: { local: { name: "Local", baseUrl, api: "openai-completions", apiKey: "sk-local", models } },
});

describe("models.json editing", () => {
  it("reads an absent file as an empty config and lists the built-in providers", async () => {
    const view = (await (await call("GET", "/api/models-config")).json()) as ModelsConfigView;
    expect(view.config).toEqual({});
    expect(view.path).toBe(join(harness.agentDir, "models.json"));
    expect(view.builtinProviders).toContain("anthropic");
    expect(view.builtinProviders).not.toContain("local");
  });

  it("rejects drafts pi cannot load and duplicate model ids", async () => {
    const noUrl = await call("PUT", "/api/models-config", { config: { providers: { nowhere: { models: [{ id: "x" }] } } } });
    expect(noUrl.status).toBe(400);
    expect(await noUrl.text()).toContain("models.json 无效");

    const duplicate = await call("PUT", "/api/models-config", { config: local([{ id: "a" }, { id: "a" }]) });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.text()).toContain("重复");
  });

  it("discovers models from the provider's /models endpoint with its key", async () => {
    const response = await call("POST", "/api/models-config/discover", { config: local(), provider: "local" });
    expect(response.status).toBe(200);
    const result = (await response.json()) as ModelDiscoveryResult;
    expect(result.endpoint).toBe(`${baseUrl}/models`);
    expect(result.models).toEqual([{ id: "local-big", contextWindow: 131072 }, { id: "local-small" }]);
    expect(seenAuth.at(-1)).toBe("Bearer sk-local");
  });

  it("saves a custom provider, which then shows up as configured", async () => {
    const config = local([{ id: "local-big", name: "Local Big", contextWindow: 131072, maxTokens: 8192 }]);
    const response = await call("PUT", "/api/models-config", { config });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as ModelsConfigSaved;
    expect(saved.config.config).toEqual(config);
    expect(JSON.parse(await readFile(join(harness.agentDir, "models.json"), "utf8"))).toEqual(config);

    const provider = saved.providers.providers.find((item) => item.id === "local");
    expect(provider?.configured).toBe(true);
    expect(provider?.models).toEqual([
      expect.objectContaining({ id: "local-big", name: "Local Big", contextWindow: 131072, maxTokens: 8192 }),
    ]);
  });

  it("tests a model with one tiny request through the draft", async () => {
    const config = local([{ id: "local-big" }]);
    const result = (await (await call("POST", "/api/models-config/test", { config, provider: "local", model: "local-big" })).json()) as ModelTestResult;
    expect(result).toEqual(expect.objectContaining({ ok: true, text: "OK" }));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const missing = (await (await call("POST", "/api/models-config/test", { config, provider: "local", model: "nope" })).json()) as ModelTestResult;
    expect(missing).toEqual({ ok: false, error: "找不到模型 local/nope" });
  });
});

describe("model discovery helpers", () => {
  it("adds the version segment Anthropic and Google expect", () => {
    expect(modelsListUrl("https://api.example.com/v1/", "openai-completions").toString()).toBe("https://api.example.com/v1/models");
    expect(modelsListUrl("https://api.anthropic.com", "anthropic-messages").toString()).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(modelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString()).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
    );
  });

  it("parses Google, Anthropic and OpenRouter style lists", () => {
    expect(parseDiscoveredModels({ models: [{ name: "models/gemini-x", displayName: "Gemini X", inputTokenLimit: 1000000, outputTokenLimit: 65536 }] })).toEqual([
      { id: "gemini-x", name: "Gemini X", contextWindow: 1000000, maxTokens: 65536 },
    ]);
    expect(parseDiscoveredModels({ data: [{ id: "claude-y", display_name: "Claude Y" }] })).toEqual([{ id: "claude-y", name: "Claude Y" }]);
    expect(parseDiscoveredModels({ data: [{ id: "a/b", name: "A: B", context_length: 200000, top_provider: { max_completion_tokens: 32000 } }] })).toEqual([
      { id: "a/b", name: "A: B", contextWindow: 200000, maxTokens: 32000 },
    ]);
  });
});
