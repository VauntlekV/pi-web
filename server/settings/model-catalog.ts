/**
 * models.dev lookup for the model editor (GET /api/models-catalog): what the
 * community catalog knows about a model id — name, capabilities, limits and
 * price. Matching follows agegr/pi-web: exact model id only; metadata from the
 * same provider (by id, then by base URL host), else the value most entries
 * agree on; a price only when one provider or a clear majority states it.
 */
import type { CatalogPrice, CatalogPreset, ModelCatalogMatch, ModelCost } from "../../shared/protocol.ts";
import { HttpError } from "../http-error.ts";

const DEFAULT_URL = "https://models.dev/api.json";
const TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
/** Share of entries that must agree before a consensus value is used. */
const CONSENSUS_SHARE = 0.6;
/** …or this many entries agreeing on a price, whatever the share. */
const CONSENSUS_SUPPORT = 5;
const KNOWN_HOSTS: Record<string, string[]> = {
  anthropic: ["api.anthropic.com"],
  google: ["generativelanguage.googleapis.com"],
  openai: ["api.openai.com"],
  openrouter: ["openrouter.ai"],
};

export interface CatalogEntry {
  providerId: string;
  providerName: string;
  /** the provider's API base URL as models.dev lists it */
  providerApi?: string;
  id: string;
  name: string;
  reasoning?: boolean;
  image?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  cost: Partial<ModelCost>;
}

const sourceUrl = () => process.env.PI_WEB_MODELS_DEV_URL ?? DEFAULT_URL;

let cache: { url: string; entries: CatalogEntry[]; expires: number } | undefined;
let inFlight: Promise<CatalogEntry[]> | undefined;

async function loadCatalog(): Promise<CatalogEntry[]> {
  const url = sourceUrl();
  if (cache && cache.url === url && cache.expires > Date.now()) return cache.entries;
  inFlight ??= (async () => {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const entries = flattenCatalog(await response.json());
    if (entries.length === 0) throw new Error("目录是空的");
    cache = { url, entries, expires: Date.now() + TTL_MS };
    return entries;
  })().finally(() => {
    inFlight = undefined;
  });
  try {
    return await inFlight;
  } catch (error) {
    // A stale catalog beats none when models.dev is unreachable.
    if (cache?.url === url) return cache.entries;
    throw new HttpError(502, `无法获取 models.dev：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function lookupModelCatalog(query: { model?: string; provider?: string; baseUrl?: string }): Promise<ModelCatalogMatch> {
  const model = (query.model ?? "").trim().slice(0, 200);
  if (!model) throw new HttpError(400, "缺少 model");
  return { source: sourceUrl(), ...matchCatalog(await loadCatalog(), model, query.provider ?? "", query.baseUrl ?? "") };
}

// ------------------------------------------------------------------ parsing

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
const price = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);

/** models.dev's `{ provider: { name, api, models: { id: {…} } } }` as flat entries. */
export function flattenCatalog(json: unknown): CatalogEntry[] {
  if (!isRecord(json)) return [];
  const entries: CatalogEntry[] = [];
  for (const [providerId, provider] of Object.entries(json)) {
    if (!isRecord(provider) || !isRecord(provider.models)) continue;
    for (const [key, raw] of Object.entries(provider.models)) {
      if (!isRecord(raw)) continue;
      const id = text(raw.id) ?? key;
      const cost = isRecord(raw.cost) ? raw.cost : {};
      const limit = isRecord(raw.limit) ? raw.limit : {};
      const input = isRecord(raw.modalities) && Array.isArray(raw.modalities.input) ? raw.modalities.input : undefined;
      entries.push({
        providerId,
        providerName: text(provider.name) ?? providerId,
        providerApi: text(provider.api),
        id,
        name: text(raw.name) ?? id,
        reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
        image: input ? input.includes("image") : undefined,
        contextWindow: positive(limit.context),
        maxTokens: positive(limit.output),
        cost: {
          input: price(cost.input),
          output: price(cost.output),
          cacheRead: price(cost.cache_read),
          cacheWrite: price(cost.cache_write),
        },
      });
    }
  }
  return entries;
}

// ----------------------------------------------------------------- matching

const normalizeId = (value: string) => value.trim().toLowerCase().replace(/^models\//, "");
const normalizeProvider = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

function host(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function sameHost(entry: CatalogEntry, baseUrl: string): boolean {
  const actual = host(baseUrl);
  if (!actual) return false;
  const expected = [...(KNOWN_HOSTS[normalizeProvider(entry.providerId)] ?? []), host(entry.providerApi)];
  return expected.some((candidate) => candidate && (actual === candidate || actual.endsWith(`.${candidate}`)));
}

/** The value at least CONSENSUS_SHARE of `total` entries agree on, with no tie. */
function consensus<T>(values: T[], total: number): T | undefined {
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = JSON.stringify(value);
    const slot = counts.get(key) ?? { value, count: 0 };
    slot.count += 1;
    counts.set(key, slot);
  }
  const [first, second] = [...counts.values()].sort((a, b) => b.count - a.count);
  if (!first || first.count / total < CONSENSUS_SHARE || second?.count === first.count) return undefined;
  return first.value;
}

const defined = <T>(values: (T | undefined)[]) => values.filter((value): value is T => value !== undefined);

function presetOf(entry: CatalogEntry): CatalogPreset {
  return { name: entry.name, reasoning: entry.reasoning, image: entry.image, contextWindow: entry.contextWindow, maxTokens: entry.maxTokens };
}

function fullCost(entry: CatalogEntry): ModelCost | undefined {
  const { input, output, cacheRead, cacheWrite } = entry.cost;
  if (input === undefined || output === undefined) return undefined;
  return { input, output, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };
}

export function matchCatalog(entries: CatalogEntry[], model: string, provider: string, baseUrl: string): Omit<ModelCatalogMatch, "source"> {
  const query = normalizeId(model);
  const exact = entries.filter((entry) => {
    const id = normalizeId(entry.id);
    return id === query || `${entry.providerId.toLowerCase()}/${id}` === query;
  });
  if (exact.length === 0) {
    return { matches: 0, matchedBy: "none", preset: {}, price: { reliable: false, reason: "no-match", support: 0, total: 0 } };
  }

  const hint = normalizeProvider(provider);
  const byProvider = exact.filter((entry) => hint && (normalizeProvider(entry.providerId) === hint || normalizeProvider(entry.providerName) === hint));
  const byHost = exact.filter((entry) => sameHost(entry, baseUrl));
  const own = byProvider[0] ?? byHost[0];
  const matchedBy = byProvider.length > 0 ? "provider" : byHost.length > 0 ? "base-url" : "consensus";

  const total = exact.length;
  const preset: CatalogPreset = own
    ? presetOf(own)
    : {
        name: consensus(exact.map((entry) => entry.name), total),
        reasoning: consensus(defined(exact.map((entry) => entry.reasoning)), total),
        image: consensus(defined(exact.map((entry) => entry.image)), total),
        contextWindow: consensus(defined(exact.map((entry) => entry.contextWindow)), total),
        maxTokens: consensus(defined(exact.map((entry) => entry.maxTokens)), total),
      };

  let priceInfo: CatalogPrice;
  const ownPriced = [...byProvider, ...byHost].find((entry) => fullCost(entry));
  if (ownPriced) {
    priceInfo = { reliable: true, by: byProvider.includes(ownPriced) ? "provider" : "base-url", providerName: ownPriced.providerName, support: 1, total: 1 };
    preset.cost = fullCost(ownPriced);
  } else {
    const priced = exact.filter((entry) => fullCost(entry));
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of priced) {
      const key = `${entry.cost.input}/${entry.cost.output}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    const [winner, runnerUp] = [...groups.values()].sort((a, b) => b.length - a.length);
    if (!winner) {
      priceInfo = { reliable: false, reason: "no-price", support: 0, total: 0 };
    } else if (priced.length === 1) {
      priceInfo = { reliable: false, reason: "single", support: 1, total: 1 };
    } else if (runnerUp?.length === winner.length || (winner.length / priced.length < CONSENSUS_SHARE && winner.length < CONSENSUS_SUPPORT)) {
      priceInfo = { reliable: false, reason: "conflict", support: winner.length, total: priced.length };
    } else {
      const base = fullCost(winner[0])!;
      preset.cost = {
        ...base,
        cacheRead: consensus(winner.map((entry) => entry.cost.cacheRead ?? 0), winner.length) ?? base.cacheRead,
        cacheWrite: consensus(winner.map((entry) => entry.cost.cacheWrite ?? 0), winner.length) ?? base.cacheWrite,
      };
      priceInfo = { reliable: true, by: "consensus", support: winner.length, total: priced.length };
    }
  }

  // Undefined fields stay out of the JSON.
  for (const key of Object.keys(preset) as (keyof CatalogPreset)[]) if (preset[key] === undefined) delete preset[key];
  return { matches: total, matchedBy, ...(own ? { providerName: own.providerName } : {}), preset, price: priceInfo };
}
