/**
 * Pure helpers for the models.json editor in Settings › 模型: form drafts and
 * the edits they make to the config. No React, no DOM.
 *
 * A model of a custom provider (or one added to a built-in provider) is an
 * entry in `providers[p].models`; a built-in model is changed through
 * `providers[p].modelOverrides[id]`, which keeps only the fields that differ.
 */
import type {
  DiscoveredModel,
  ModelCost,
  ModelInfo,
  ModelsJson,
  ModelsJsonModel,
  ModelsJsonOverride,
  ModelsJsonProvider,
  ThinkingLevel,
} from "../../../shared/protocol.ts";

export const API_TYPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
export const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export const MAPPABLE_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface HeaderRow {
  name: string;
  value: string;
}

export interface ThinkingRow {
  /** provider value; "" = pi's default for the level */
  value: string;
  unsupported: boolean;
}

export interface ModelDraft {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: string;
  maxTokens: string;
  cost: Record<(typeof COST_KEYS)[number], string>;
  thinking: Record<string, ThinkingRow>;
  headers: HeaderRow[];
  /** JSON object text, "" for none */
  compat: string;
}

export interface ProviderDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  headers: HeaderRow[];
  compat: string;
}

export type ModelSource = "entry" | "override";

const provider = (config: ModelsJson, id: string): ModelsJsonProvider => config.providers?.[id] ?? {};

export function isCustomProvider(config: ModelsJson, builtins: string[], id: string): boolean {
  return !builtins.includes(id) && config.providers?.[id] !== undefined;
}

/** Where an edit of `modelId` goes: its models[] entry, or an override of a built-in. */
export function modelSource(config: ModelsJson, providerId: string, modelId: string): ModelSource {
  return provider(config, providerId).models?.some((model) => model.id === modelId) ? "entry" : "override";
}

const text = (value: number | undefined) => (value === undefined ? "" : String(value));

export function headerRows(headers: Record<string, string> | undefined): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
}

export function compatText(compat: Record<string, unknown> | undefined): string {
  return compat && Object.keys(compat).length > 0 ? JSON.stringify(compat, null, 2) : "";
}

/** Form values for a model: the stored entry/override first, then what pi reports for it. */
export function modelDraft(config: ModelsJson, providerId: string, modelId: string, info?: ModelInfo): ModelDraft {
  const stored: ModelsJsonModel | ModelsJsonOverride | undefined =
    provider(config, providerId).models?.find((model) => model.id === modelId) ??
    provider(config, providerId).modelOverrides?.[modelId];
  const cost: Partial<ModelCost> = { ...info?.cost, ...stored?.cost };
  const thinking: Record<string, ThinkingRow> = {};
  for (const level of MAPPABLE_LEVELS) {
    const mapped = stored?.thinkingLevelMap?.[level];
    thinking[level] = { value: typeof mapped === "string" ? mapped : "", unsupported: mapped === null };
  }
  return {
    id: modelId,
    name: stored?.name ?? (info && info.name !== info.id ? info.name : ""),
    reasoning: stored?.reasoning ?? info?.reasoning ?? false,
    image: stored?.input ? stored.input.includes("image") : (info?.vision ?? false),
    contextWindow: text(stored?.contextWindow ?? info?.contextWindow),
    maxTokens: text(stored?.maxTokens ?? info?.maxTokens),
    cost: {
      input: text(cost.input),
      output: text(cost.output),
      cacheRead: text(cost.cacheRead),
      cacheWrite: text(cost.cacheWrite),
    },
    thinking,
    headers: headerRows(stored?.headers),
    compat: compatText(stored?.compat),
  };
}

export function providerDraft(config: ModelsJson, id: string): ProviderDraft {
  const entry = provider(config, id);
  return {
    id,
    name: entry.name ?? "",
    baseUrl: entry.baseUrl ?? "",
    api: entry.api ?? "",
    apiKey: entry.apiKey ?? "",
    headers: headerRows(entry.headers),
    compat: compatText(entry.compat),
  };
}

// ----------------------------------------------------------------- parsing

function positiveInt(value: string, label: string): number | undefined {
  const trimmed = value.trim().replace(/[,_\s]/g, "");
  if (!trimmed) return undefined;
  const number = Number(trimmed);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`);
  return number;
}

function price(value: string, label: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value.trim());
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}必须是不小于 0 的数字`);
  return number;
}

export function parseHeaders(rows: HeaderRow[]): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) headers[name] = row.value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function parseCompat(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("兼容性设置不是有效的 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("兼容性设置必须是 JSON 对象");
  return Object.keys(parsed).length > 0 ? (parsed as Record<string, unknown>) : undefined;
}

const COST_LABELS = { input: "输入价格", output: "输出价格", cacheRead: "缓存读取价格", cacheWrite: "缓存写入价格" };

/** The draft as models.json fields (undefined = not set). Throws a readable message on bad input. */
export function parseModelDraft(draft: ModelDraft): ModelsJsonOverride {
  const cost: Partial<ModelCost> = {};
  for (const key of COST_KEYS) {
    const value = price(draft.cost[key], COST_LABELS[key]);
    if (value !== undefined) cost[key] = value;
  }
  // pi requires all four prices once any is set; blanks mean free.
  const costSet = Object.keys(cost).length > 0;
  const thinkingLevelMap: Record<string, string | null> = {};
  if (draft.reasoning) {
    for (const level of MAPPABLE_LEVELS) {
      const row = draft.thinking[level];
      if (!row) continue;
      if (row.unsupported) thinkingLevelMap[level] = null;
      else if (row.value.trim()) thinkingLevelMap[level] = row.value.trim();
    }
  }
  return {
    name: draft.name.trim() || undefined,
    reasoning: draft.reasoning,
    input: draft.image ? ["text", "image"] : ["text"],
    contextWindow: positiveInt(draft.contextWindow, "上下文窗口"),
    maxTokens: positiveInt(draft.maxTokens, "最大输出"),
    cost: costSet ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost } : undefined,
    thinkingLevelMap: Object.keys(thinkingLevelMap).length > 0 ? thinkingLevelMap : undefined,
    headers: parseHeaders(draft.headers),
    compat: parseCompat(draft.compat),
  };
}

// ------------------------------------------------------------------- edits

const EDITED_FIELDS = ["name", "reasoning", "input", "contextWindow", "maxTokens", "cost", "thinkingLevelMap", "headers", "compat"] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Set a field, or remove it for undefined (the file should not carry `"x": null` noise). */
function setField(target: Record<string, unknown>, field: string, value: unknown): void {
  if (value === undefined) delete target[field];
  else target[field] = value;
}

function withProvider(config: ModelsJson, id: string, update: (entry: ModelsJsonProvider) => ModelsJsonProvider): ModelsJson {
  const next = update({ ...provider(config, id) });
  const providers = { ...config.providers, [id]: next };
  // A built-in provider whose last override was reverted needs no entry at all.
  if (Object.keys(next).length === 0) delete providers[id];
  return { ...config, providers };
}

/**
 * Write a model draft into the config. An entry is replaced field by field
 * (fields the form does not show survive). An override keeps only what
 * differs from `initial`, the values the form opened with, plus fields the
 * override already had.
 */
export function applyModelDraft(
  config: ModelsJson,
  providerId: string,
  modelId: string,
  draft: ModelDraft,
  initial: ModelDraft,
): ModelsJson {
  const fields = parseModelDraft(draft);
  const source = modelSource(config, providerId, modelId);

  if (source === "entry") {
    const id = draft.id.trim();
    if (!id) throw new Error("模型 ID 不能为空");
    return withProvider(config, providerId, (entry) => {
      const models = entry.models ?? [];
      if (id !== modelId && models.some((model) => model.id === id)) throw new Error(`模型 ${id} 已存在`);
      return {
        ...entry,
        models: models.map((model) => {
          if (model.id !== modelId) return model;
          const next: ModelsJsonModel = { ...model, id };
          for (const field of EDITED_FIELDS) setField(next, field, fields[field]);
          // Defaults pi applies anyway stay out of the file.
          if (next.reasoning === false) delete next.reasoning;
          if (same(next.input, ["text"])) delete next.input;
          return next;
        }),
      };
    });
  }

  const before = parseModelDraft(initial);
  return withProvider(config, providerId, (entry) => {
    const existing: ModelsJsonOverride = { ...entry.modelOverrides?.[modelId] };
    for (const field of EDITED_FIELDS) {
      const changed = !same(fields[field], before[field]);
      if (changed || field in existing) setField(existing, field, fields[field]);
    }
    const overrides = { ...entry.modelOverrides };
    if (Object.keys(existing).length > 0) overrides[modelId] = existing;
    else delete overrides[modelId];
    return pruneProvider({ ...entry, modelOverrides: overrides });
  });
}

/** Drop a models[] entry, or a built-in model's override (back to pi's values). */
export function removeModel(config: ModelsJson, providerId: string, modelId: string): ModelsJson {
  return withProvider(config, providerId, (entry) => {
    const models = entry.models?.filter((model) => model.id !== modelId);
    const overrides = { ...entry.modelOverrides };
    delete overrides[modelId];
    return pruneProvider({ ...entry, models, modelOverrides: overrides });
  });
}

/** Append discovered (or hand-typed) models that are not there yet. */
export function addModels(config: ModelsJson, providerId: string, models: DiscoveredModel[]): ModelsJson {
  return withProvider(config, providerId, (entry) => {
    const existing = entry.models ?? [];
    const added = models
      .filter((model) => !existing.some((known) => known.id === model.id))
      .map((model): ModelsJsonModel => ({
        id: model.id,
        ...(model.name ? { name: model.name } : {}),
        ...(model.reasoning ? { reasoning: true } : {}),
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      }));
    return { ...entry, models: [...existing, ...added] };
  });
}

/** Write the connection settings of provider `draft.id` (rename first with renameProvider). */
export function applyProviderDraft(config: ModelsJson, draft: ProviderDraft, custom: boolean): ModelsJson {
  const id = draft.id.trim();
  if (!id) throw new Error("提供商 ID 不能为空");
  if (!/^[\w.-]+$/.test(id)) throw new Error("提供商 ID 只能包含字母、数字、-、_ 和 .");
  if (custom && !draft.baseUrl.trim()) throw new Error("自定义提供商需要 Base URL");
  if (custom && !draft.api.trim()) throw new Error("自定义提供商需要选择 API 类型");
  const headers = parseHeaders(draft.headers);
  const compat = parseCompat(draft.compat);

  const providers = { ...config.providers };
  const entry: ModelsJsonProvider = { ...providers[id] };
  const set = (field: keyof ModelsJsonProvider, value: string | object | undefined) => {
    if (value === undefined || value === "") delete entry[field];
    else entry[field] = value;
  };
  set("name", draft.name.trim());
  set("baseUrl", draft.baseUrl.trim());
  set("api", draft.api.trim());
  set("apiKey", draft.apiKey.trim());
  set("headers", headers);
  set("compat", compat);
  providers[id] = entry;
  if (Object.keys(entry).length === 0) delete providers[id];
  return { ...config, providers };
}

/** Rename a custom provider, keeping its place in the file. */
export function renameProvider(config: ModelsJson, from: string, to: string): ModelsJson {
  const entries = Object.entries(config.providers ?? {});
  if (from === to) return config;
  if (entries.some(([id]) => id === to)) throw new Error(`提供商 ${to} 已存在`);
  return { ...config, providers: Object.fromEntries(entries.map(([id, entry]) => [id === from ? to : id, entry])) };
}

export function removeProvider(config: ModelsJson, id: string): ModelsJson {
  const providers = { ...config.providers };
  delete providers[id];
  return { ...config, providers };
}

/** Remove empty containers so a reverted override leaves no `{}` behind. */
function pruneProvider(entry: ModelsJsonProvider): ModelsJsonProvider {
  const next = { ...entry };
  if (!next.models?.length) delete next.models;
  if (!next.modelOverrides || Object.keys(next.modelOverrides).length === 0) delete next.modelOverrides;
  return next;
}

export function hasOverride(config: ModelsJson, providerId: string, modelId: string): boolean {
  return provider(config, providerId).modelOverrides?.[modelId] !== undefined;
}
