import { describe, expect, it } from "vitest";
import type { ModelInfo, ModelsJson } from "../../../shared/protocol.ts";
import {
  addModels,
  applyModelDraft,
  applyProviderDraft,
  modelDraft,
  parseModelDraft,
  providerDraft,
  removeModel,
  renameProvider,
} from "./model-config-lib.ts";

const builtin: ModelInfo = {
  provider: "anthropic",
  id: "claude-x",
  name: "Claude X",
  reasoning: true,
  contextWindow: 200000,
  maxTokens: 64000,
  vision: true,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

const custom: ModelsJson = {
  providers: {
    local: {
      baseUrl: "http://localhost:1234/v1",
      api: "openai-completions",
      models: [{ id: "qwen", contextWindow: 32768, samplingParams: { top_k: 20 } }],
    },
  },
};

describe("model drafts", () => {
  it("opens a built-in model with pi's values and an override on top", () => {
    const config: ModelsJson = { providers: { anthropic: { modelOverrides: { "claude-x": { contextWindow: 1000000 } } } } };
    const draft = modelDraft(config, "anthropic", "claude-x", builtin);
    expect(draft).toMatchObject({ name: "Claude X", reasoning: true, image: true, contextWindow: "1000000", maxTokens: "64000" });
    expect(draft.cost).toEqual({ input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" });
  });

  it("overrides only what changed on a built-in model", () => {
    const initial = modelDraft({}, "anthropic", "claude-x", builtin);
    const next = applyModelDraft({}, "anthropic", "claude-x", { ...initial, maxTokens: "128000" }, initial);
    expect(next).toEqual({ providers: { anthropic: { modelOverrides: { "claude-x": { maxTokens: 128000 } } } } });

    // Saving the untouched form again keeps the override and adds nothing.
    const reopened = modelDraft(next, "anthropic", "claude-x", { ...builtin, maxTokens: 128000 });
    expect(applyModelDraft(next, "anthropic", "claude-x", reopened, reopened)).toEqual(next);
  });

  it("reverting the last override removes the provider entry", () => {
    const config: ModelsJson = { providers: { anthropic: { modelOverrides: { "claude-x": { maxTokens: 1 } } } } };
    expect(removeModel(config, "anthropic", "claude-x")).toEqual({ providers: {} });
  });

  it("edits a models[] entry in place and keeps fields the form does not show", () => {
    const initial = modelDraft(custom, "local", "qwen");
    const draft = {
      ...initial,
      id: "qwen3",
      name: "Qwen 3",
      reasoning: true,
      cost: { input: "0.5", output: "", cacheRead: "", cacheWrite: "" },
    };
    draft.thinking = { ...draft.thinking, xhigh: { value: "", unsupported: true }, high: { value: "max", unsupported: false } };
    const next = applyModelDraft(custom, "local", "qwen", draft, initial);
    expect(next.providers?.local.models).toEqual([
      {
        id: "qwen3",
        name: "Qwen 3",
        reasoning: true,
        contextWindow: 32768,
        samplingParams: { top_k: 20 },
        cost: { input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: { high: "max", xhigh: null },
      },
    ]);
  });

  it("explains bad numbers and bad compat JSON", () => {
    const draft = modelDraft(custom, "local", "qwen");
    expect(() => parseModelDraft({ ...draft, contextWindow: "12k" })).toThrow("上下文窗口必须是正整数");
    expect(() => parseModelDraft({ ...draft, cost: { ...draft.cost, input: "-1" } })).toThrow("输入价格");
    expect(() => parseModelDraft({ ...draft, compat: "{" })).toThrow("不是有效的 JSON");
    expect(parseModelDraft({ ...draft, contextWindow: "131,072" }).contextWindow).toBe(131072);
  });
});

describe("providers", () => {
  it("writes connection settings and drops cleared fields", () => {
    const draft = { ...providerDraft(custom, "local"), apiKey: "$LOCAL_KEY", headers: [{ name: "X-Team", value: "a" }, { name: " ", value: "" }] };
    const next = applyProviderDraft(custom, draft, true);
    expect(next.providers?.local).toMatchObject({ apiKey: "$LOCAL_KEY", headers: { "X-Team": "a" } });
    expect(() => applyProviderDraft(custom, { ...draft, baseUrl: "" }, true)).toThrow("Base URL");
    expect(applyProviderDraft({}, { ...providerDraft({}, "openai"), baseUrl: "https://proxy/v1" }, false)).toEqual({
      providers: { openai: { baseUrl: "https://proxy/v1" } },
    });
  });

  it("renames in place and refuses a taken id", () => {
    const two: ModelsJson = { providers: { a: { baseUrl: "x" }, b: { baseUrl: "y" } } };
    expect(Object.keys(renameProvider(two, "a", "c").providers ?? {})).toEqual(["c", "b"]);
    expect(() => renameProvider(two, "a", "b")).toThrow("已存在");
  });

  it("adds discovered models once, with the limits the list reported", () => {
    const next = addModels(custom, "local", [{ id: "qwen" }, { id: "llama", contextWindow: 8192, reasoning: true }]);
    expect(next.providers?.local.models?.map((model) => model.id)).toEqual(["qwen", "llama"]);
    expect(next.providers?.local.models?.[1]).toEqual({ id: "llama", reasoning: true, contextWindow: 8192 });
  });
});
