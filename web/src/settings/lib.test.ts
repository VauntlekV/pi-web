import { describe, expect, it } from "vitest";
import type {
  PackageView,
  ProviderView,
  ResourceItem,
  ResourcesView,
} from "../../../shared/protocol.ts";
import {
  authSourceLabel,
  filterResources,
  formatContextWindow,
  groupProviders,
  thinkingLabel,
  toggleEnabledModel,
} from "./lib.ts";

const ALL = ["pi/pi-code", "pi/pi-mini", "openrouter/qwen3"];

describe("toggleEnabledModel", () => {
  it("expands null into an explicit list when one model is turned off", () => {
    expect(toggleEnabledModel(null, ALL, "pi/pi-mini", false)).toEqual(["pi/pi-code", "openrouter/qwen3"]);
  });

  it("removes a model from an explicit list", () => {
    expect(toggleEnabledModel(["pi/pi-code", "pi/pi-mini"], ALL, "pi/pi-code", false)).toEqual(["pi/pi-mini"]);
  });

  it("adds a model back to an explicit list", () => {
    expect(toggleEnabledModel(["pi/pi-code"], ALL, "pi/pi-mini", true)).toEqual(["pi/pi-code", "pi/pi-mini"]);
  });

  it("collapses back to null when every model is enabled again", () => {
    expect(toggleEnabledModel(["pi/pi-code", "openrouter/qwen3"], ALL, "pi/pi-mini", true)).toBeNull();
  });

  it("leaves an all-enabled state null when a model is turned on again", () => {
    expect(toggleEnabledModel(null, ALL, "pi/pi-code", true)).toBeNull();
  });

  it("ignores keys that are not part of the available set", () => {
    expect(toggleEnabledModel(null, ALL, "ghost/model", true)).toBeNull();
    expect(toggleEnabledModel(["pi/pi-code"], ALL, "ghost/model", false)).toEqual(["pi/pi-code"]);
  });

  it("de-duplicates the explicit list", () => {
    expect(toggleEnabledModel(["pi/pi-code", "pi/pi-code"], ALL, "openrouter/qwen3", false)).toEqual([
      "pi/pi-code",
    ]);
  });
});

describe("thinkingLabel", () => {
  it("uses the Chinese labels", () => {
    expect(thinkingLabel("off")).toBe("关闭");
    expect(thinkingLabel("minimal")).toBe("极简");
    expect(thinkingLabel("medium")).toBe("中");
    expect(thinkingLabel("xhigh")).toBe("超高");
    expect(thinkingLabel("max")).toBe("最大");
  });
});

describe("authSourceLabel", () => {
  it("labels every auth source", () => {
    expect(authSourceLabel("stored")).toBe("已保存密钥");
    expect(authSourceLabel("env")).toBe("环境变量");
    expect(authSourceLabel("config")).toBe("配置文件");
    expect(authSourceLabel("oauth")).toBe("OAuth");
    expect(authSourceLabel("none")).toBe("未配置");
    expect(authSourceLabel(undefined)).toBe("未配置");
  });
});

describe("formatContextWindow", () => {
  it("formats thousands, millions and nothing", () => {
    expect(formatContextWindow(200_000)).toBe("200K");
    expect(formatContextWindow(128_000)).toBe("128K");
    expect(formatContextWindow(1_048_576)).toBe("1M");
    expect(formatContextWindow(400_000)).toBe("400K");
    expect(formatContextWindow(0)).toBe("—");
    expect(formatContextWindow(-5)).toBe("—");
    expect(formatContextWindow(Number.NaN)).toBe("—");
  });
});

function provider(id: string, configured: boolean): ProviderView {
  return {
    id,
    name: id,
    configured,
    supportsApiKey: true,
    supportsOAuth: false,
    envVars: [],
    models: [],
  };
}

describe("groupProviders", () => {
  it("puts configured providers first and keeps the relative order", () => {
    const providers = [provider("a", false), provider("b", true), provider("c", false), provider("d", true)];
    expect(groupProviders(providers).map((item) => item.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("does not mutate the input", () => {
    const providers = [provider("a", false), provider("b", true)];
    groupProviders(providers);
    expect(providers.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

function resource(overrides: Partial<ResourceItem> = {}): ResourceItem {
  return {
    type: "extension",
    id: "builtin:codemode",
    name: "codemode",
    origin: "builtin",
    enabled: true,
    ...overrides,
  };
}

function resources(): ResourcesView {
  return {
    cwd: "/work",
    packages: [
      { source: "npm:@scope/tools", scope: "user", counts: { extension: 2 }, filtered: false },
      { source: "git:github.com/user/repo", scope: "project", counts: {}, filtered: false },
    ],
    items: [
      resource(),
      resource({ type: "skill", id: "/home/u/.pi/skills/pdf", name: "pdf", description: "读取 PDF", origin: "user", path: "/home/u/.pi/skills/pdf" }),
      resource({ type: "prompt", id: "/work/.pi/prompts/review.md", name: "review", origin: "project", path: "/work/.pi/prompts/review.md" }),
      resource({ type: "extension", id: "pkg:tools/fmt", name: "fmt", origin: "package", packageSource: "npm:@scope/tools" }),
    ],
    diagnostics: ["skill x failed"],
  };
}

describe("filterResources", () => {
  it("returns the view untouched for an empty query", () => {
    const view = resources();
    expect(filterResources(view, "  ")).toBe(view);
  });

  it("matches names case-insensitively", () => {
    expect(filterResources(resources(), "PDF").items.map((item) => item.name)).toEqual(["pdf"]);
  });

  it("matches descriptions", () => {
    expect(filterResources(resources(), "读取").items.map((item) => item.name)).toEqual(["pdf"]);
  });

  it("matches package sources and origins", () => {
    expect(filterResources(resources(), "@scope").items.map((item) => item.name)).toEqual(["fmt"]);
    expect(filterResources(resources(), "项目").items.map((item) => item.name)).toEqual(["review"]);
  });

  it("filters packages by source", () => {
    const filtered = filterResources(resources(), "github.com");
    expect(filtered.packages.map((pkg: PackageView) => pkg.source)).toEqual(["git:github.com/user/repo"]);
  });

  it("keeps cwd and diagnostics", () => {
    const filtered = filterResources(resources(), "pdf");
    expect(filtered.cwd).toBe("/work");
    expect(filtered.diagnostics).toEqual(["skill x failed"]);
  });
});
