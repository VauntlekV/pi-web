import type { Model, Provider } from "@earendil-works/pi-ai";
import type { ProviderView, ProvidersView, ThinkingLevel } from "../../shared/protocol.ts";
import type { ModelRuntime as Runtime } from "@earendil-works/pi-coding-agent";
import { toModelInfo } from "../app.ts";
import type { AppDeps } from "../app.ts";
import { HttpError } from "../http-error.ts";
import { getGlobalRuntime, invalidateGlobalRuntime } from "./runtime-cache.ts";
import { settingsManagerFor } from "./settings.ts";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ENV_PROBE_TIMEOUT_MS = 300;
/** Ambient credential chains may reach the network (IMDS/metadata); their env hints are not worth it. */
const NETWORK_PROVIDERS = new Set(["amazon-bedrock", "google-vertex"]);

// Probes run a provider's credential resolver, so cache the result (or in-flight probe) by id.
const envVarsCache = new Map<string, Promise<string[]>>();
const warnedProviders = new Set<string>();
const CREDENTIAL_SOURCES: Record<string, NonNullable<ProviderView["authSource"]>> = {
  stored: "stored",
  runtime: "stored",
  environment: "env",
  models_json_key: "config",
  models_json_command: "config",
  fallback: "none",
};

export async function readProvidersView(deps: AppDeps): Promise<ProvidersView> {
  const runtime = await getGlobalRuntime(deps);
  const manager = settingsManagerFor(deps);

  let credentialTypes = new Map<string, "api_key" | "oauth">();
  try {
    const credentials = await runtime.listCredentials();
    credentialTypes = new Map(credentials.map((entry) => [entry.providerId, entry.type]));
  } catch {
    // A damaged auth.json must not empty the provider list; per-provider status still works.
  }

  const providers = await Promise.all(
    runtime.getProviders().map((provider) => buildProviderView(runtime, provider, credentialTypes)),
  );
  providers.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));

  const provider = manager.getDefaultProvider();
  const modelId = manager.getDefaultModel();
  return {
    providers,
    ...(provider && modelId ? { defaultModel: { provider, id: modelId } } : {}),
    defaultThinkingLevel: (manager.getDefaultThinkingLevel() ?? "medium") as ThinkingLevel,
    enabledModels: manager.getEnabledModels() ?? null,
  };
}

async function buildProviderView(
  runtime: Runtime,
  provider: Provider,
  credentialTypes: Map<string, "api_key" | "oauth">,
): Promise<ProviderView> {
  const status = runtime.getProviderAuthStatus(provider.id);
  const credentialType = credentialTypes.get(provider.id);
  const authSource: NonNullable<ProviderView["authSource"]> = credentialType
    ? (credentialType === "oauth" ? "oauth" : "stored")
    : status.configured
      ? (CREDENTIAL_SOURCES[status.source ?? ""] ?? "none")
      : "none";

  const models = runtime
    .getAllModels(provider.id)
    .filter((model) => (model.type ?? "chat") === "chat")
    .map((model) => toModelInfo(model as Model<string>));

  return {
    id: provider.id,
    name: provider.name,
    configured: runtime.hasConfiguredAuth(provider.id),
    authSource,
    supportsApiKey: Boolean(provider.auth.apiKey?.login),
    supportsOAuth: Boolean(provider.auth.oauth),
    envVars: await envVarsFor(provider),
    models,
  };
}

/**
 * The provider auth definition has no declared env list, so ask `resolve()` which env names it
 * reads. With no credential and an env that always returns undefined, resolve only inspects names.
 */
function envVarsFor(provider: Provider): Promise<string[]> {
  const cached = envVarsCache.get(provider.id);
  if (cached) return cached;
  const probe = NETWORK_PROVIDERS.has(provider.id) ? Promise.resolve<string[]>([]) : probeEnvVars(provider);
  envVarsCache.set(provider.id, probe);
  return probe;
}

async function probeEnvVars(provider: Provider): Promise<string[]> {
  const resolve = provider.auth.apiKey?.resolve;
  if (!resolve) return [];

  const seen: string[] = [];
  const ctx = {
    env: async (name: string) => {
      if (!seen.includes(name)) seen.push(name);
      return undefined;
    },
    fileExists: async () => false,
  };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((done) => {
    timer = setTimeout(() => {
      controller.abort();
      done("timeout");
    }, ENV_PROBE_TIMEOUT_MS);
  });
  const attempt = Promise.resolve()
    .then(() => resolve({ ctx, signal: controller.signal }))
    .then(() => "done" as const, () => "done" as const);

  try {
    if ((await Promise.race([attempt, timeout])) === "timeout") {
      if (!warnedProviders.has(provider.id)) {
        warnedProviders.add(provider.id);
        console.warn(`[pi-web] ${provider.id} 的环境变量探测超过 ${ENV_PROBE_TIMEOUT_MS}ms，已跳过`);
      }
      return [];
    }
    return seen;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------- writes

export async function setProviderKey(
  deps: AppDeps,
  providerId: string,
  body: Record<string, unknown>,
): Promise<ProvidersView> {
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length < 1 || apiKey.length > 4096) throw new HttpError(400, "apiKey 长度必须在 1 到 4096 之间");

  const runtime = await getGlobalRuntime(deps);
  const provider = runtime.getProviders().find((entry) => entry.id === providerId);
  if (!provider) throw new HttpError(404, `未知 provider: ${providerId}`);
  if (!provider.auth.apiKey?.login) throw new HttpError(400, `${provider.name} 不支持 API key 登录`);

  try {
    // Same flow as `pi` /login: the SDK's api-key login stores the credential in auth.json.
    await runtime.login(providerId, "api_key", {
      prompt: async () => apiKey,
      notify: () => {},
    });
  } catch (error) {
    throw new HttpError(400, redact(error, apiKey, `保存 ${provider.name} 的 API key 失败`));
  }
  invalidateGlobalRuntime();
  return readProvidersView(deps);
}

export async function clearProviderKey(deps: AppDeps, providerId: string): Promise<ProvidersView> {
  const runtime = await getGlobalRuntime(deps);
  const provider = runtime.getProviders().find((entry) => entry.id === providerId);
  if (!provider) throw new HttpError(404, `未知 provider: ${providerId}`);

  try {
    await runtime.logout(providerId);
  } catch (error) {
    throw new HttpError(400, redact(error, undefined, `清除 ${provider.name} 的凭据失败`));
  }
  invalidateGlobalRuntime();
  return readProvidersView(deps);
}

export async function setDefaultModel(deps: AppDeps, body: Record<string, unknown>): Promise<ProvidersView> {
  const provider = body.provider;
  const id = body.id;
  if (typeof provider !== "string" || provider.trim() === "") throw new HttpError(400, "provider 必须是非空字符串");
  if (typeof id !== "string" || id.trim() === "") throw new HttpError(400, "id 必须是非空字符串");

  const runtime = await getGlobalRuntime(deps);
  if (!runtime.getModel(provider, id)) throw new HttpError(400, `未知模型 ${provider}/${id}`);

  let thinkingLevel: ThinkingLevel | undefined;
  if (body.thinkingLevel !== undefined) {
    if (typeof body.thinkingLevel !== "string" || !THINKING_LEVELS.includes(body.thinkingLevel as ThinkingLevel)) {
      throw new HttpError(400, `未知 thinking level: ${String(body.thinkingLevel)}`);
    }
    thinkingLevel = body.thinkingLevel as ThinkingLevel;
  }

  const manager = settingsManagerFor(deps);
  manager.setDefaultModelAndProvider(provider, id);
  if (thinkingLevel) manager.setDefaultThinkingLevel(thinkingLevel);
  await manager.flush();
  return readProvidersView(deps);
}

export async function setEnabledModels(deps: AppDeps, body: Record<string, unknown>): Promise<ProvidersView> {
  const patterns = body.patterns;
  const manager = settingsManagerFor(deps);

  if (patterns === null) {
    manager.setEnabledModels(undefined);
  } else if (Array.isArray(patterns)) {
    if (patterns.length > 500) throw new HttpError(400, "patterns 最多 500 项");
    const cleaned: string[] = [];
    for (const pattern of patterns) {
      if (typeof pattern !== "string") throw new HttpError(400, "patterns 必须全部是字符串");
      const trimmed = pattern.trim();
      if (trimmed === "") throw new HttpError(400, "patterns 不能包含空字符串");
      if (trimmed.length > 200) throw new HttpError(400, "patterns 每项最多 200 个字符");
      if (!cleaned.includes(trimmed)) cleaned.push(trimmed);
    }
    manager.setEnabledModels(cleaned);
  } else {
    throw new HttpError(400, "patterns 必须是字符串数组或 null");
  }

  await manager.flush();
  return readProvidersView(deps);
}

/** Never echo a credential: drop the message when it could contain the key. */
function redact(error: unknown, secret: string | undefined, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (secret && message.includes(secret)) return fallback;
  return message || fallback;
}
