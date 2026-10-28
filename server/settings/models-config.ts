/**
 * models.json editing for Settings › 模型 (/api/models-config*). Every draft is
 * loaded by a throwaway ModelRuntime first, so pi itself validates it and
 * resolves auth, baseUrl and api the same way a session would.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type {
  DiscoveredModel,
  ModelDiscoveryResult,
  ModelsConfigSaved,
  ModelsConfigView,
  ModelsJson,
  ModelTestResult,
} from "../../shared/protocol.ts";
import type { AppDeps } from "../app.ts";
import { HttpError } from "../http-error.ts";
import { writeFileAtomic } from "./atomic.ts";
import { readProvidersView } from "./providers.ts";
import { invalidateGlobalRuntime } from "./runtime-cache.ts";

const REQUEST_TIMEOUT_MS = 20_000;
/** Placeholder model that lets a provider without models resolve its auth. */
const PROBE_MODEL = "__pi_web_probe__";

const modelsPath = (deps: AppDeps) => join(deps.agentDir, "models.json");

let builtinProviders: Promise<string[]> | undefined;

/** Provider ids pi ships with (no models.json), plus the ones registered in code. */
async function listBuiltinProviders(deps: AppDeps): Promise<string[]> {
  const natives = deps.nativeProviders?.map((provider) => provider.id) ?? [];
  return [...new Set([...(await shippedProviders(deps)), ...natives])];
}

function shippedProviders(deps: AppDeps): Promise<string[]> {
  builtinProviders ??= ModelRuntime.create({
    authPath: join(deps.agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  })
    .then((runtime) => runtime.getProviders().map((provider) => provider.id))
    .catch((error: unknown) => {
      builtinProviders = undefined;
      throw error;
    });
  return builtinProviders;
}

export async function readModelsConfig(deps: AppDeps): Promise<ModelsConfigView> {
  const path = modelsPath(deps);
  const builtins = await listBuiltinProviders(deps);
  if (!existsSync(path)) return { path, config: {}, builtinProviders: builtins };
  const text = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error("顶层必须是对象");
    return { path, config: parsed as ModelsJson, builtinProviders: builtins };
  } catch (error) {
    return { path, config: {}, error: `models.json 无法解析：${message(error)}`, text, builtinProviders: builtins };
  }
}

export async function saveModelsConfig(deps: AppDeps, body: Record<string, unknown>): Promise<ModelsConfigSaved> {
  const config = draftConfig(body);
  await withDraftRuntime(deps, config, async () => undefined);
  writeFileAtomic(modelsPath(deps), `${JSON.stringify(config, null, 2)}\n`);

  // New sessions get a fresh runtime; live ones re-read models.json in place.
  if (deps.modelRuntime) await deps.modelRuntime.refresh().catch(() => undefined);
  else invalidateGlobalRuntime();
  await Promise.all(deps.registry.liveSessions().map((live) => live.session.modelRuntime.refresh().catch(() => undefined)));

  return { config: await readModelsConfig(deps), providers: await readProvidersView(deps) };
}

export async function discoverModels(deps: AppDeps, body: Record<string, unknown>): Promise<ModelDiscoveryResult> {
  const config = draftConfig(body);
  const providerId = requiredString(body.provider, "provider");
  // A placeholder model lets a provider that has none yet resolve auth and its endpoint.
  const probe = structuredClone(config);
  const entry = (probe.providers ??= {})[providerId] ?? {};
  probe.providers[providerId] = { ...entry, models: [...(entry.models ?? []), { id: PROBE_MODEL }] };

  return withDraftRuntime(deps, probe, async (runtime) => {
    const model = runtime.getModel(providerId, PROBE_MODEL);
    if (!model) throw new HttpError(400, `找不到提供商 ${providerId}`);
    if (!model.baseUrl) throw new HttpError(400, "需要先填写 Base URL");

    let endpoint: URL;
    try {
      endpoint = modelsListUrl(model.baseUrl, model.api);
    } catch {
      throw new HttpError(400, "Base URL 不是有效的地址");
    }
    const auth = await runtime.getAuth(model).catch(() => undefined);
    const response = await fetch(endpoint, {
      headers: listHeaders(model.api, auth?.auth.apiKey, { ...model.headers, ...auth?.auth.headers }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw new HttpError(502, `请求 ${endpoint.toString()} 失败：${message(error)}`);
    });
    const text = await response.text();
    if (!response.ok) throw new HttpError(502, `${response.status} ${text.slice(0, 300) || response.statusText}`);

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new HttpError(502, "模型列表不是有效的 JSON");
    }
    const models = parseDiscoveredModels(payload);
    if (models.length === 0) throw new HttpError(502, "接口没有返回任何模型");
    return { endpoint: endpoint.toString(), models };
  });
}

export async function testModel(deps: AppDeps, body: Record<string, unknown>): Promise<ModelTestResult> {
  const config = draftConfig(body);
  const providerId = requiredString(body.provider, "provider");
  const modelId = requiredString(body.model, "model");

  try {
    return await withDraftRuntime(deps, config, async (runtime) => {
      const model = runtime.getModel(providerId, modelId);
      if (!model) return { ok: false, error: `找不到模型 ${providerId}/${modelId}` };
      const started = Date.now();
      const reply = await runtime.completeSimple(
        model as Model<Api>,
        { messages: [{ role: "user", content: "Reply with OK only.", timestamp: Date.now() }] },
        { maxTokens: 16, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      const latencyMs = Date.now() - started;
      if (reply.stopReason === "error" || reply.stopReason === "aborted") {
        return { ok: false, latencyMs, error: reply.errorMessage ?? "模型返回了错误" };
      }
      const text = reply.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("")
        .slice(0, 300);
      return { ok: true, latencyMs, text };
    });
  } catch (error) {
    if (error instanceof HttpError) return { ok: false, error: error.message };
    return { ok: false, error: message(error) };
  }
}

// ------------------------------------------------------------------ helpers

/** Load `config` into a throwaway runtime (stored keys still apply); 400 when pi rejects it. */
async function withDraftRuntime<T>(deps: AppDeps, config: ModelsJson, use: (runtime: ModelRuntime) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-models-"));
  try {
    const path = join(dir, "models.json");
    writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
    const runtime = await ModelRuntime.create({
      authPath: join(deps.agentDir, "auth.json"),
      modelsPath: path,
      refreshOnCreate: false,
    });
    // Providers registered in code (tests, the demo) must exist for the draft's
    // entries about them to compose; re-read the draft once they are in.
    const natives = deps.nativeProviders ?? [];
    for (const provider of natives) runtime.registerNativeProvider(provider);
    if (natives.length > 0) await runtime.refresh();
    const error = runtime.getError();
    if (error) throw new HttpError(400, `models.json 无效：${error}`);
    return await use(runtime);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function draftConfig(body: Record<string, unknown>): ModelsJson {
  const config = body.config;
  if (!isRecord(config)) throw new HttpError(400, "config 必须是对象");
  if (config.providers !== undefined && !isRecord(config.providers)) throw new HttpError(400, "providers 必须是对象");
  for (const [id, provider] of Object.entries((config.providers ?? {}) as Record<string, unknown>)) {
    if (!id.trim()) throw new HttpError(400, "提供商 ID 不能为空");
    if (!isRecord(provider)) throw new HttpError(400, `提供商 ${id} 必须是对象`);
    if (provider.models !== undefined) {
      if (!Array.isArray(provider.models)) throw new HttpError(400, `${id}.models 必须是数组`);
      const ids = new Set<string>();
      for (const model of provider.models) {
        if (!isRecord(model) || typeof model.id !== "string" || !model.id.trim()) {
          throw new HttpError(400, `${id} 有模型缺少 id`);
        }
        if (ids.has(model.id)) throw new HttpError(400, `${id} 里的模型 ${model.id} 重复了`);
        ids.add(model.id);
      }
    }
  }
  return config as ModelsJson;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `缺少 ${name}`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `<baseUrl>/models`, with the version segment Anthropic and Google expect. */
export function modelsListUrl(baseUrl: string, api: string): URL {
  const url = new URL(baseUrl.trim());
  let path = url.pathname.replace(/\/+$/, "");
  if (!/\/models$/i.test(path)) {
    if (api === "anthropic-messages" && !/\/v\d+(beta)?$/i.test(path)) path += "/v1";
    if (api === "google-generative-ai" && !/\/v\d+(beta)?$/i.test(path)) path += "/v1beta";
    url.pathname = `${path}/models`.replace(/\/{2,}/g, "/");
  }
  if (api === "anthropic-messages" && !url.searchParams.has("limit")) url.searchParams.set("limit", "1000");
  if (api === "google-generative-ai" && !url.searchParams.has("pageSize")) url.searchParams.set("pageSize", "1000");
  return url;
}

function listHeaders(api: string, apiKey: string | undefined, configured: Record<string, string | null>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(configured)) if (value !== null) headers.set(name, value);
  if (!headers.has("accept")) headers.set("Accept", "application/json");
  if (!apiKey) return headers;
  if (api === "anthropic-messages") {
    if (!headers.has("x-api-key")) headers.set("x-api-key", apiKey);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else if (api === "google-generative-ai") {
    if (!headers.has("x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
  } else if (!headers.has("authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

const CONTEXT_FIELDS = ["context_length", "contextLength", "context_window", "contextWindow", "max_model_len", "max_input_tokens", "inputTokenLimit"];
const OUTPUT_FIELDS = ["max_output_tokens", "maxOutputTokens", "max_completion_tokens", "outputTokenLimit"];
const REASONING_FIELDS = ["supports_reasoning", "supportsReasoning", "reasoning", "thinking"];

/** Model ids (and limits, when listed) from OpenAI, Anthropic, Google or OpenRouter style lists. */
export function parseDiscoveredModels(payload: unknown): DiscoveredModel[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? ((["data", "models", "results", "items"].map((key) => payload[key]).find(Array.isArray) as unknown[] | undefined) ?? [])
      : [];
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];
  for (const item of list) {
    const model = discoveredModel(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: "base" }));
}

function discoveredModel(item: unknown): DiscoveredModel | null {
  if (typeof item === "string") return item.trim() ? { id: item.trim() } : null;
  if (!isRecord(item)) return null;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const raw = text(item.id) ?? text(item.model) ?? text(item.name);
  if (!raw) return null;
  const id = raw.startsWith("models/") ? raw.slice(7) : raw;
  const name = text(item.display_name) ?? text(item.displayName) ?? (text(item.id) ? text(item.name) : undefined);
  const top = isRecord(item.top_provider) ? item.top_provider : {};
  const contextWindow = positive(item, CONTEXT_FIELDS) ?? positive(top, CONTEXT_FIELDS);
  const maxTokens = positive(item, OUTPUT_FIELDS) ?? positive(top, OUTPUT_FIELDS);
  const reasoning = REASONING_FIELDS.some((field) => item[field] === true);
  return {
    id,
    ...(name && name !== id ? { name } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

function positive(record: Record<string, unknown>, fields: string[]): number | undefined {
  for (const field of fields) {
    const raw = record[field];
    const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}
