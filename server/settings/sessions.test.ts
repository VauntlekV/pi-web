import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { SessionState } from "../../shared/protocol.ts";
import { createSettingsHarness } from "./testing.ts";

describe("session reload and export", () => {
  it("returns 404 for a session that was never written to disk", async () => {
    const h = await createSettingsHarness();
    try {
      const live = await h.registry.create({ cwd: h.cwd });
      const response = await h.app.request(`/api/sessions/${live.session.sessionId}/export`);
      expect(response.status).toBe(404);
      if (live.session.sessionFile) expect(existsSync(live.session.sessionFile)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("downloads the persisted transcript as .jsonl", async () => {
    const h = await createSettingsHarness();
    try {
      const live = await h.registry.create({ cwd: h.cwd });
      h.faux.setResponses([fauxAssistantMessage([fauxText("hello there")])]);
      await live.prompt({ text: "hello from the test" });
      await live.session.waitForIdle();

      const id = live.session.sessionId;
      expect(live.session.sessionFile).toBeTruthy();
      expect(existsSync(live.session.sessionFile!)).toBe(true);

      const response = await h.app.request(`/api/sessions/${id}/export`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-ndjson");
      expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${id}.jsonl"`);
      const text = await response.text();
      expect(text).toContain("hello from the test");
      for (const line of text.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    } finally {
      await h.close();
    }
  });

  it("reloads a session and returns its state", async () => {
    const h = await createSettingsHarness();
    try {
      const live = await h.registry.create({ cwd: h.cwd });
      const id = live.session.sessionId;
      const events: string[] = [];
      live.addClient((event) => events.push(event.type));

      const response = await h.json<{ state: SessionState }>(`/api/sessions/${id}/reload`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(response.body.state.id).toBe(id);
      expect(events).toContain("transcript_reset");

      const missing = await h.json("/api/sessions/does-not-exist/reload", { method: "POST" });
      expect(missing.status).toBe(404);
    } finally {
      await h.close();
    }
  });
});
