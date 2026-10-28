import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { ProviderView, ProvidersView } from "../../shared/protocol.ts";
import { createSettingsHarness } from "./testing.ts";

const findProvider = (view: ProvidersView, id: string): ProviderView => {
  const provider = view.providers.find((entry) => entry.id === id);
  if (!provider) throw new Error(`provider ${id} missing`);
  return provider;
};

describe("providers", () => {
  it("lists providers with auth metadata, models, and settings defaults", async () => {
    const h = await createSettingsHarness();
    try {
      const response = await h.json<ProvidersView>("/api/providers");
      expect(response.status).toBe(200);
      expect(response.body.defaultThinkingLevel).toBe("medium");
      expect(response.body.enabledModels).toBeNull();
      expect(response.body.defaultModel).toBeUndefined();

      const faux = findProvider(response.body, "faux");
      expect(faux.configured).toBe(true);
      expect(faux.supportsApiKey).toBe(false);
      expect(faux.models.map((model) => model.id)).toEqual(["faux-1", "faux-2"]);

      const anthropic = findProvider(response.body, "anthropic");
      expect(anthropic.supportsApiKey).toBe(true);
      expect(anthropic.supportsOAuth).toBe(true);
      expect(anthropic.envVars).toContain("ANTHROPIC_API_KEY");
      expect(anthropic.configured).toBe(false);
      expect(anthropic.authSource).toBe("none");

      // Configured providers sort first.
      const lastConfigured = response.body.providers.map((entry) => entry.configured).lastIndexOf(true);
      const firstUnconfigured = response.body.providers.map((entry) => entry.configured).indexOf(false);
      expect(lastConfigured).toBeLessThan(firstUnconfigured);
    } finally {
      await h.close();
    }
  });

  it("answers within a second when a provider resolver never returns", async () => {
    const h = await createSettingsHarness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const slow: Provider = {
        id: "slow-provider",
        name: "Slow provider",
        auth: { apiKey: { name: "Slow API key", resolve: () => new Promise(() => {}) } },
        getModels: () => [],
      };
      h.modelRuntime.registerNativeProvider(slow);

      const startedAt = Date.now();
      const response = await h.json<ProvidersView>("/api/providers");
      expect(response.status).toBe(200);
      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(findProvider(response.body, "slow-provider").envVars).toEqual([]);

      await h.json<ProvidersView>("/api/providers");
      expect(warn.mock.calls.filter(([message]) => String(message).includes("slow-provider"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      await h.close();
    }
  });

  it("stores and clears an API key without echoing it", async () => {
    const h = await createSettingsHarness();
    try {
      const secret = "sk-ant-unit-test-secret-123";
      const stored = await h.json<ProvidersView>("/api/providers/anthropic/key", {
        method: "PUT",
        body: JSON.stringify({ apiKey: `  ${secret}  ` }),
      });
      expect(stored.status).toBe(200);
      expect(JSON.stringify(stored.body)).not.toContain(secret);
      const configured = findProvider(stored.body, "anthropic");
      expect(configured.configured).toBe(true);
      expect(configured.authSource).toBe("stored");

      const authFile = JSON.parse(await readFile(join(h.agentDir, "auth.json"), "utf8")) as Record<string, unknown>;
      expect(authFile.anthropic).toEqual({ type: "api_key", key: secret });

      const listed = await h.json<ProvidersView>("/api/providers");
      expect(findProvider(listed.body, "anthropic").configured).toBe(true);

      const cleared = await h.json<ProvidersView>("/api/providers/anthropic/key", { method: "DELETE" });
      expect(cleared.status).toBe(200);
      const unconfigured = findProvider(cleared.body, "anthropic");
      expect(unconfigured.configured).toBe(false);
      expect(unconfigured.authSource).toBe("none");
    } finally {
      await h.close();
    }
  });

  it("rejects unknown providers and invalid keys", async () => {
    const h = await createSettingsHarness();
    try {
      const unknown = await h.json("/api/providers/ghost/key", {
        method: "PUT",
        body: JSON.stringify({ apiKey: "abc" }),
      });
      expect(unknown.status).toBe(404);

      const unknownDelete = await h.json("/api/providers/ghost/key", { method: "DELETE" });
      expect(unknownDelete.status).toBe(404);

      const unsupported = await h.json("/api/providers/faux/key", {
        method: "PUT",
        body: JSON.stringify({ apiKey: "abc" }),
      });
      expect(unsupported.status).toBe(400);

      for (const apiKey of ["", "   ", "x".repeat(4097), 42]) {
        const response = await h.json("/api/providers/anthropic/key", {
          method: "PUT",
          body: JSON.stringify({ apiKey }),
        });
        expect(response.status).toBe(400);
      }
    } finally {
      await h.close();
    }
  });

  it("sets the default model and thinking level", async () => {
    const h = await createSettingsHarness();
    try {
      const response = await h.json<ProvidersView>("/api/default-model", {
        method: "PUT",
        body: JSON.stringify({ provider: "faux", id: "faux-1", thinkingLevel: "high" }),
      });
      expect(response.status).toBe(200);
      expect(response.body.defaultModel).toEqual({ provider: "faux", id: "faux-1" });
      expect(response.body.defaultThinkingLevel).toBe("high");

      const settings = JSON.parse(await readFile(join(h.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
      expect(settings.defaultProvider).toBe("faux");
      expect(settings.defaultModel).toBe("faux-1");
      expect(settings.defaultThinkingLevel).toBe("high");

      const missing = await h.json("/api/default-model", {
        method: "PUT",
        body: JSON.stringify({ provider: "faux", id: "nope" }),
      });
      expect(missing.status).toBe(400);

      const badThinking = await h.json("/api/default-model", {
        method: "PUT",
        body: JSON.stringify({ provider: "faux", id: "faux-2", thinkingLevel: "banana" }),
      });
      expect(badThinking.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it("stores enabled-model patterns, deduped, and clears them with null", async () => {
    const h = await createSettingsHarness();
    try {
      const set = await h.json<ProvidersView>("/api/enabled-models", {
        method: "PUT",
        body: JSON.stringify({ patterns: [" faux/* ", "faux/*", "other/*"] }),
      });
      expect(set.status).toBe(200);
      expect(set.body.enabledModels).toEqual(["faux/*", "other/*"]);

      const cleared = await h.json<ProvidersView>("/api/enabled-models", {
        method: "PUT",
        body: JSON.stringify({ patterns: null }),
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.enabledModels).toBeNull();

      for (const patterns of [[1], [""], new Array(501).fill("a"), "faux/*"]) {
        const response = await h.json("/api/enabled-models", {
          method: "PUT",
          body: JSON.stringify({ patterns }),
        });
        expect(response.status).toBe(400);
      }
    } finally {
      await h.close();
    }
  });
});
