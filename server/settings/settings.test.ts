import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SettingsView } from "../../shared/protocol.ts";
import { createSettingsHarness } from "./testing.ts";

describe("settings", () => {
  it("reads defaults, round-trips PATCH, and preserves unknown fields", async () => {
    const h = await createSettingsHarness();
    try {
      await writeFile(
        join(h.agentDir, "settings.json"),
        `${JSON.stringify({ unknownKey: { keep: true }, steeringMode: "all" }, null, 2)}\n`,
      );

      const initial = await h.json<SettingsView>("/api/settings");
      expect(initial.status).toBe(200);
      expect(initial.body.agentDir).toBe(h.agentDir);
      expect(initial.body.settingsFile).toBe(join(h.agentDir, "settings.json"));
      expect(initial.body.piVersion).toBe("test-pi");
      expect(initial.body.general.defaultThinkingLevel).toBe("medium");
      expect(initial.body.general.steeringMode).toBe("all");

      const patched = await h.json<SettingsView>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          defaultThinkingLevel: "high",
          followUpMode: "all",
          compactionEnabled: false,
          retryEnabled: false,
          enableSkillCommands: false,
          hideThinkingBlock: true,
          defaultProjectTrust: "never",
          defaultTools: ["read"],
        }),
      });
      expect(patched.status).toBe(200);
      expect(patched.body.general).toEqual({
        defaultThinkingLevel: "high",
        steeringMode: "all",
        followUpMode: "all",
        compactionEnabled: false,
        retryEnabled: false,
        enableSkillCommands: false,
        hideThinkingBlock: true,
        defaultTools: ["read"],
        defaultProjectTrust: "never",
      });

      const file = JSON.parse(await readFile(join(h.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
      expect(file.unknownKey).toEqual({ keep: true });
      expect(file.steeringMode).toBe("all");
      expect(file.defaultThinkingLevel).toBe("high");
      expect(file.defaultTools).toEqual(["read"]);
      expect(file.hideThinkingBlock).toBe(true);

      // null deletes the setting again, leaving the other fields in place.
      const cleared = await h.json<SettingsView>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ defaultTools: null }),
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.general.defaultTools).toBeUndefined();
      const afterClear = JSON.parse(await readFile(join(h.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
      expect("defaultTools" in afterClear).toBe(false);
      expect(afterClear.unknownKey).toEqual({ keep: true });
    } finally {
      await h.close();
    }
  });

  it("rejects unknown fields and invalid values with 400", async () => {
    const h = await createSettingsHarness();
    try {
      const cases: Record<string, unknown>[] = [
        { unknownField: 1 },
        { defaultThinkingLevel: "banana" },
        { steeringMode: "sometimes" },
        { followUpMode: 3 },
        { compactionEnabled: "yes" },
        { retryEnabled: 1 },
        { enableSkillCommands: null },
        { hideThinkingBlock: "no" },
        { defaultProjectTrust: "maybe" },
        { defaultTools: "read" },
        { defaultTools: ["Read"] },
        { defaultTools: [""] },
        { defaultTools: [1] },
      ];
      for (const body of cases) {
        const response = await h.json("/api/settings", { method: "PATCH", body: JSON.stringify(body) });
        expect(response.status, JSON.stringify(body)).toBe(400);
        expect((response.body as { error: string }).error).toMatch(/[\u4e00-\u9fff]/);
      }
      const get = await h.json<SettingsView>("/api/settings");
      expect(get.body.general.defaultThinkingLevel).toBe("medium");

      // An invalid field must not half-apply the rest of the request.
      const partial = await h.json("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ defaultThinkingLevel: "high", steeringMode: "sometimes" }),
      });
      expect(partial.status).toBe(400);
      const afterPartial = await h.json<SettingsView>("/api/settings");
      expect(afterPartial.body.general.defaultThinkingLevel).toBe("medium");
    } finally {
      await h.close();
    }
  });

  it("shows the raw settings file, with a {} placeholder when it does not exist", async () => {
    const h = await createSettingsHarness();
    try {
      const missing = await h.json<{ path: string; text: string }>("/api/settings/file");
      expect(missing.body).toEqual({ path: join(h.agentDir, "settings.json"), text: "{}\n" });

      await writeFile(join(h.agentDir, "settings.json"), '{\n  "theme": "dark"\n}\n');
      const present = await h.json<{ path: string; text: string }>("/api/settings/file");
      expect(present.body.text).toContain('"theme": "dark"');
    } finally {
      await h.close();
    }
  });
});
