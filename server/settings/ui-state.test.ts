import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UiState } from "../../shared/protocol.ts";
import { createSettingsHarness } from "./testing.ts";

const statePath = (agentDir: string) => join(agentDir, "pi-web", "ui-state.json");

describe("ui state", () => {
  it("round-trips pinned and archived ids, deduped in order", async () => {
    const h = await createSettingsHarness();
    try {
      const empty = await h.json<UiState>("/api/ui-state");
      expect(empty.body).toEqual({ pinned: [], archived: [] });

      const put = await h.json<UiState>("/api/ui-state", {
        method: "PUT",
        body: JSON.stringify({ pinned: ["b", "a", "b"], archived: ["c", "c"] }),
      });
      expect(put.status).toBe(200);
      expect(put.body).toEqual({ pinned: ["b", "a"], archived: ["c"] });

      const stored = JSON.parse(await readFile(statePath(h.agentDir), "utf8")) as UiState;
      expect(stored).toEqual({ pinned: ["b", "a"], archived: ["c"] });

      const read = await h.json<UiState>("/api/ui-state");
      expect(read.body).toEqual({ pinned: ["b", "a"], archived: ["c"] });

      if (process.platform !== "win32") {
        expect((await stat(join(h.agentDir, "pi-web"))).mode & 0o777).toBe(0o700);
        expect((await stat(statePath(h.agentDir))).mode & 0o777).toBe(0o600);
      }

      const cleared = await h.json<UiState>("/api/ui-state", {
        method: "PUT",
        body: JSON.stringify({ pinned: [], archived: [] }),
      });
      expect(cleared.body).toEqual({ pinned: [], archived: [] });
    } finally {
      await h.close();
    }
  });

  it("rejects invalid ids and malformed bodies", async () => {
    const h = await createSettingsHarness();
    try {
      const invalid: unknown[] = [
        { pinned: ["ok"], archived: ["bad/id"] },
        { pinned: ["ok"], archived: ["has space"] },
        { pinned: ["x".repeat(129)], archived: [] },
        { pinned: "not-an-array", archived: [] },
        { pinned: [1], archived: [] },
        { pinned: [] },
        { pinned: new Array(2001).fill("id"), archived: [] },
      ];
      for (const body of invalid) {
        const response = await h.json("/api/ui-state", { method: "PUT", body: JSON.stringify(body) });
        expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      }

      const untouched = await h.json<UiState>("/api/ui-state");
      expect(untouched.body).toEqual({ pinned: [], archived: [] });
    } finally {
      await h.close();
    }
  });
});
