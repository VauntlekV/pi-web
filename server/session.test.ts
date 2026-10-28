import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import type { ServerEvent, ThinkingLevel } from "../shared/protocol.ts";
import { createApp } from "./app.ts";
import { createHarness, TEST_TOKEN, waitFor, type Harness } from "./testing.ts";

async function promptAndSettle(harness: Harness, live: Awaited<ReturnType<Harness["createSession"]>>, text: string) {
  const events: ServerEvent[] = [];
  live.addClient((event) => events.push(event));
  await live.prompt({ text });
  await waitFor(() => events.some((event) => event.type === "agent_settled"));
}

describe("sessions", () => {
  it("validates create requests and picks the default faux model", async () => {
    const harness = await createHarness();
    try {
      await expect(harness.registry.create({ cwd: join(harness.cwd, "missing") })).rejects.toMatchObject({
        status: 400,
        message: "目录不存在",
      });
      await expect(
        harness.registry.create({ cwd: harness.cwd, model: { provider: "ghost", id: "nope" } }),
      ).rejects.toMatchObject({ status: 400, message: "未知模型 ghost/nope" });
      await expect(
        harness.registry.create({ cwd: harness.cwd, thinkingLevel: "banana" as ThinkingLevel }),
      ).rejects.toMatchObject({ status: 400 });

      const live = await harness.registry.create({ cwd: harness.cwd });
      const state = live.getState();
      expect(state.model).toEqual({ provider: "faux", id: "faux-1" });
      expect(state.thinkingLevel).toBe("medium");
      expect(state.isStreaming).toBe(false);
      expect(state.stats.contextUsage?.contextWindow ?? 0).toBeGreaterThan(0);
    } finally {
      await harness.close();
    }
  });

  it("runs a prompt end to end over HTTP and SSE events", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      const events: ServerEvent[] = [];
      live.addClient((event) => events.push(event));

      harness.faux.setResponses([
        fauxAssistantMessage([fauxText("running bash"), fauxToolCall("bash", { command: "echo hi" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("done")]),
      ]);

      const response = await harness.app.request(`/api/sessions/${live.session.sessionId}/prompt`, {
        method: "POST",
        headers: harness.authHeaders,
        body: JSON.stringify({ text: "please run something" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });

      await waitFor(() => events.some((event) => event.type === "agent_settled"));

      expect(events[0]?.type).toBe("snapshot");

      for (const event of events) {
        if (event.type === "message_start" || event.type === "message_end") {
          expect(event.message.role).not.toBe("system");
        }
      }

      const steps: Array<(event: ServerEvent) => boolean> = [
        (event) => event.type === "agent_start",
        (event) => event.type === "message_start" && event.message.role === "assistant",
        (event) => event.type === "message_update",
        (event) => event.type === "message_end" && event.message.role === "assistant",
        (event) => event.type === "tool_start",
        (event) => event.type === "tool_end",
        (event) => event.type === "message_end" && event.message.role === "toolResult",
        (event) => event.type === "agent_settled",
      ];
      let cursor = 0;
      for (const step of steps) {
        const index = events.findIndex((event, position) => position >= cursor && step(event));
        expect(index, `missing step ${step}`).toBeGreaterThanOrEqual(cursor);
        cursor = index + 1;
      }

      const assistantEnds = events.filter(
        (event): event is Extract<ServerEvent, { type: "message_end" }> =>
          event.type === "message_end" && event.message.role === "assistant",
      );
      expect(assistantEnds.length).toBeGreaterThan(0);
      for (const end of assistantEnds) expect(end.entryId).not.toBeNull();

      expect(live.getTranscript().map((item) => item.message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(live.getState().isStreaming).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("auto-titles a session from the model exactly once", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      const events: ServerEvent[] = [];
      live.addClient((event) => events.push(event));
      harness.faux.setResponses([
        fauxAssistantMessage([fauxText("ok")]),
        // Reasoning models may spend the title budget on thinking first; the text still wins.
        fauxAssistantMessage([fauxThinking("I should name this conversation."), fauxText('"Fix the login bug."')]),
      ]);
      await live.prompt({ text: "please fix the login bug" });

      const name = await waitFor(() => live.getState().name);
      expect(name).toBe("Fix the login bug");
      await waitFor(() =>
        events.some((event) => event.type === "session_name" && event.name === "Fix the login bug"),
      );
      expect(harness.faux.getPendingResponseCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("falls back to the first user line when the title response has only thinking", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      harness.faux.setResponses([
        fauxAssistantMessage([fauxText("ok")]),
        fauxAssistantMessage([fauxThinking("thinking only, no title")]),
      ]);
      await live.prompt({ text: "summarize the login flow" });

      const name = await waitFor(() => live.getState().name);
      expect(name).toBe("summarize the login flow");
    } finally {
      await harness.close();
    }
  });

  it("revives a disposed session from its file, and rejects bad ids", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      harness.faux.setResponses([fauxAssistantMessage([fauxText("hello back")])]);
      await promptAndSettle(harness, live, "hello");
      const id = live.session.sessionId;
      const before = live.getTranscript();
      expect(before.length).toBeGreaterThan(0);

      await harness.registry.dispose(id);
      const revived = await harness.registry.get(id);
      expect(revived.getTranscript()).toEqual(before);
      expect(revived.getState().model).toEqual({ provider: "faux", id: "faux-1" });

      await expect(harness.registry.get("../../etc/passwd")).rejects.toMatchObject({ status: 400 });
      await expect(harness.registry.get("no-such-session")).rejects.toMatchObject({ status: 404 });

      const viaHttp = await harness.app.request("/api/sessions/no-such-session", {
        headers: harness.authHeaders,
      });
      expect(viaHttp.status).toBe(404);
      expect(await viaHttp.json()).toEqual({ error: "会话不存在" });
    } finally {
      await harness.close();
    }
  });

  it("groups workspaces, sorts them, and refuses to delete a running session", async () => {
    const harness = await createHarness();
    const otherCwd = await mkdtemp(join(tmpdir(), "pi-web-other-"));
    try {
      const first = await harness.registry.create({ cwd: harness.cwd });
      harness.faux.setResponses([fauxAssistantMessage([fauxText("one")])]);
      await promptAndSettle(harness, first, "first");

      await new Promise((resolve) => setTimeout(resolve, 30));

      const second = await harness.registry.create({ cwd: otherCwd });
      harness.faux.setResponses([fauxAssistantMessage([fauxText("two")])]);
      await promptAndSettle(harness, second, "second");

      const workspaces = await harness.registry.listWorkspaces([
        { cwd: harness.cwd, added: new Date(0).toISOString() },
        { cwd: otherCwd, added: new Date(0).toISOString() },
      ]);
      expect(workspaces).toHaveLength(2);
      expect(workspaces[0]?.cwd).toBe(otherCwd);
      expect(workspaces[0]?.label).toBe(basename(otherCwd));
      expect(workspaces[1]?.cwd).toBe(harness.cwd);
      expect(workspaces[1]?.sessions).toHaveLength(1);
      expect(workspaces[1]?.sessions[0]?.live).toBe(true);
      expect(workspaces[1]?.sessions[0]?.running).toBe(false);

      const running = await harness.createSession();
      harness.faux.setResponses([fauxAssistantMessage([fauxText("word ".repeat(1500))])]);
      await running.prompt({ text: "long answer" });
      await waitFor(() => running.session.isStreaming);

      const id = running.session.sessionId;
      const file = await waitFor(() => {
        const path = running.session.sessionFile;
        return path && existsSync(path) ? path : undefined;
      });

      const conflict = await harness.app.request(`/api/sessions/${id}`, {
        method: "DELETE",
        headers: harness.authHeaders,
      });
      expect(conflict.status).toBe(409);

      const aborted = await harness.app.request(`/api/sessions/${id}/abort`, {
        method: "POST",
        headers: harness.authHeaders,
      });
      expect(aborted.status).toBe(200);
      await waitFor(() => !running.session.isStreaming);

      const deleted = await harness.app.request(`/api/sessions/${id}`, {
        method: "DELETE",
        headers: harness.authHeaders,
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ ok: true });
      expect(existsSync(file!)).toBe(false);
    } finally {
      await harness.close();
      const { rm } = await import("node:fs/promises");
      await rm(otherCwd, { recursive: true, force: true });
    }
  });

  it("serves dist/web with an SPA fallback and keeps /api JSON errors", async () => {
    const harness = await createHarness();
    const staticDir = await mkdtemp(join(tmpdir(), "pi-web-static-"));
    try {
      await writeFile(join(staticDir, "index.html"), "<html>pi-web app</html>");
      const app = createApp({
        registry: harness.registry,
        auth: { token: TEST_TOKEN, noAuth: true },
        defaultCwd: harness.cwd,
        agentDir: harness.agentDir,
        version: "test-version",
        piVersion: "test-pi",
        staticDir,
      });

      const root = await app.request("/");
      expect(root.status).toBe(200);
      expect(await root.text()).toContain("pi-web app");

      const deepLink = await app.request("/sessions/abc");
      expect(deepLink.status).toBe(200);
      expect(await deepLink.text()).toContain("pi-web app");

      const apiMissing = await app.request("/api/does-not-exist");
      expect(apiMissing.status).toBe(404);
      expect(await apiMissing.json()).toEqual({ error: "not found" });
    } finally {
      await rm(staticDir, { recursive: true, force: true });
      await harness.close();
    }
  });

  it("returns the config and workspace routes", async () => {
    const harness = await createHarness();
    try {
      const config = await harness.app.request("/api/config", { headers: harness.authHeaders });
      expect(config.status).toBe(200);
      expect(await config.json()).toMatchObject({
        defaultCwd: harness.cwd,
        version: "test-version",
        piVersion: "test-pi",
        defaultThinkingLevel: "medium",
      });

      const workspaces = await harness.app.request("/api/workspaces", { headers: harness.authHeaders });
      expect(workspaces.status).toBe(200);
      expect(await workspaces.json()).toEqual({ workspaces: [] });

      const live = await harness.createSession();
      const models = await harness.app.request(`/api/models?sessionId=${live.session.sessionId}`, {
        headers: harness.authHeaders,
      });
      expect(models.status).toBe(200);
      expect((await models.json()).models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "faux", id: "faux-1", reasoning: true, vision: true }),
        ]),
      );
    } finally {
      await harness.close();
    }
  });
});
