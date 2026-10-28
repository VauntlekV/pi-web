import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelCatalogMatch } from "../../shared/protocol.ts";
import { createHarness, type Harness } from "../testing.ts";
import { flattenCatalog, matchCatalog } from "./model-catalog.ts";

// models.dev's shape, trimmed: a model listed by its maker and by resellers.
const CATALOG = {
  moonshot: {
    name: "Moonshot AI",
    api: "https://api.moonshot.ai/v1",
    models: {
      "kimi-k3": {
        id: "kimi-k3",
        name: "Kimi K3",
        reasoning: true,
        modalities: { input: ["text", "image"] },
        limit: { context: 262144, output: 32768 },
        cost: { input: 0.6, output: 2.5, cache_read: 0.15 },
      },
    },
  },
  ...Object.fromEntries(
    ["r1", "r2", "r3"].map((id) => [
      id,
      {
        name: `Reseller ${id}`,
        models: { "kimi-k3": { name: "Kimi K3", reasoning: true, limit: { context: 131072 }, cost: { input: 1, output: 3 } } },
      },
    ]),
  ),
  split: {
    name: "Split",
    models: {
      "open-x": { name: "Open X", cost: { input: 1, output: 2 } },
    },
  },
  other: {
    name: "Other",
    models: {
      "open-x": { name: "Open X", cost: { input: 3, output: 4 } },
    },
  },
};

const entries = flattenCatalog(CATALOG);

describe("models.dev matching", () => {
  it("flattens providers and reads limits, modalities and cache prices", () => {
    expect(entries.find((entry) => entry.providerId === "moonshot")).toEqual({
      providerId: "moonshot",
      providerName: "Moonshot AI",
      providerApi: "https://api.moonshot.ai/v1",
      id: "kimi-k3",
      name: "Kimi K3",
      reasoning: true,
      image: true,
      contextWindow: 262144,
      maxTokens: 32768,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: undefined },
    });
  });

  it("prefers the provider's own listing, matched by id or by base URL host", () => {
    const byId = matchCatalog(entries, "kimi-k3", "moonshot", "");
    expect(byId).toMatchObject({ matches: 4, matchedBy: "provider", providerName: "Moonshot AI" });
    expect(byId.preset).toEqual({
      name: "Kimi K3",
      reasoning: true,
      image: true,
      contextWindow: 262144,
      maxTokens: 32768,
      cost: { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
    });

    const byHost = matchCatalog(entries, "kimi-k3", "my-gateway", "https://api.moonshot.ai/v1");
    expect(byHost.matchedBy).toBe("base-url");
    expect(byHost.price).toMatchObject({ reliable: true, by: "base-url" });
  });

  it("falls back to what most listings agree on", () => {
    const result = matchCatalog(entries, "kimi-k3", "somewhere", "http://localhost:8000/v1");
    expect(result.matchedBy).toBe("consensus");
    // 3 of 4 listings say 131072 and $1/$3.
    expect(result.preset).toMatchObject({ name: "Kimi K3", reasoning: true, contextWindow: 131072, cost: { input: 1, output: 3 } });
    expect(result.price).toEqual({ reliable: true, by: "consensus", support: 3, total: 4 });
  });

  it("withholds a price when listings disagree or nothing matches", () => {
    const split = matchCatalog(entries, "open-x", "", "");
    expect(split.price).toEqual({ reliable: false, reason: "conflict", support: 1, total: 2 });
    expect(split.preset.cost).toBeUndefined();
    expect(split.preset.name).toBe("Open X");

    expect(matchCatalog(entries, "Moonshot/KIMI-K3", "", "").matches).toBe(1);
    expect(matchCatalog(entries, "nope", "", "")).toMatchObject({ matches: 0, matchedBy: "none", preset: {} });
  });
});

describe("GET /api/models-catalog", () => {
  let harness: Harness;
  const previous = process.env.PI_WEB_MODELS_DEV_URL;

  beforeAll(async () => {
    harness = await createHarness({ noAuth: true });
    process.env.PI_WEB_MODELS_DEV_URL = `data:application/json,${encodeURIComponent(JSON.stringify(CATALOG))}`;
  });

  afterAll(async () => {
    if (previous === undefined) delete process.env.PI_WEB_MODELS_DEV_URL;
    else process.env.PI_WEB_MODELS_DEV_URL = previous;
    await harness.close();
  });

  it("looks a model up in the fetched catalog", async () => {
    const response = await harness.app.request("/api/models-catalog?model=kimi-k3&provider=moonshot");
    expect(response.status).toBe(200);
    const result = (await response.json()) as ModelCatalogMatch;
    expect(result.source).toContain("data:application/json");
    expect(result).toMatchObject({ matchedBy: "provider", preset: { contextWindow: 262144 } });
    expect((await harness.app.request("/api/models-catalog")).status).toBe(400);
  });
});
