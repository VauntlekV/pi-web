import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ServerEvent } from "../shared/protocol.ts";
import { createHarness, messageText, waitFor } from "./testing.ts";

const latestUiRequest = (events: ServerEvent[]) =>
  events.filter(
    (event): event is Extract<ServerEvent, { type: "ui_request" }> => event.type === "ui_request",
  ).at(-1)!.request;

const assistantEnds = (events: ServerEvent[]) =>
  events.filter(
    (event): event is Extract<ServerEvent, { type: "message_end" }> =>
      event.type === "message_end" && event.message.role === "assistant",
  );

describe("live session", () => {
  it("throttles message_update but always flushes the final partial", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      const events: ServerEvent[] = [];
      live.addClient((event) => events.push(event));

      let deltas = 0;
      live.session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") deltas += 1;
      });

      const answer = "alpha bravo charlie delta ".repeat(150);
      harness.faux.setResponses([fauxAssistantMessage([fauxText(answer)])]);
      await live.prompt({ text: "stream please" });
      await waitFor(() => events.some((event) => event.type === "agent_settled"));

      const updates = events.filter(
        (event): event is Extract<ServerEvent, { type: "message_update" }> => event.type === "message_update",
      );
      const ends = assistantEnds(events);
      expect(deltas).toBeGreaterThan(20);
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.length).toBeLessThan(deltas / 2);
      expect(messageText(updates[updates.length - 1]!.message)).toBe(messageText(ends[ends.length - 1]!.message));
      expect(messageText(ends[ends.length - 1]!.message)).toBe(answer);
    } finally {
      await harness.close();
    }
  });

  it("rejects empty prompts and accepts queued prompts while streaming", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      const id = live.session.sessionId;

      for (const text of ["", "   ", "\n\t"]) {
        const response = await harness.app.request(`/api/sessions/${id}/prompt`, {
          method: "POST",
          headers: harness.authHeaders,
          body: JSON.stringify({ text }),
        });
        expect(response.status).toBe(400);
      }

      harness.faux.setResponses([
        fauxAssistantMessage([fauxText("word ".repeat(1500))]),
        fauxAssistantMessage([fauxText("steered")]),
        fauxAssistantMessage([fauxText("followed up")]),
      ]);
      await live.prompt({ text: "first" });
      await waitFor(() => live.session.isStreaming);

      const steer = await harness.app.request(`/api/sessions/${id}/prompt`, {
        method: "POST",
        headers: harness.authHeaders,
        body: JSON.stringify({ text: "steer", behavior: "steer" }),
      });
      expect(steer.status).toBe(200);

      const followUp = await harness.app.request(`/api/sessions/${id}/prompt`, {
        method: "POST",
        headers: harness.authHeaders,
        body: JSON.stringify({ text: "follow" }),
      });
      expect(followUp.status).toBe(200);
      const abort = await harness.app.request(`/api/sessions/${id}/abort`, {
        method: "POST",
        headers: harness.authHeaders,
      });
      expect(abort.status).toBe(200);
      await waitFor(() => !live.session.isStreaming);
    } finally {
      await harness.close();
    }
  });

  it("bridges extension dialogs, exposes state and reports errors", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      const id = live.session.sessionId;
      const events: ServerEvent[] = [];
      live.addClient((event) => events.push(event));

      const selectPromise = live.uiContext.select("Pick one", ["a", "b"]);
      const selectRequest = events.find(
        (event): event is Extract<ServerEvent, { type: "ui_request" }> => event.type === "ui_request",
      )!.request;
      expect(selectRequest).toMatchObject({ method: "select", title: "Pick one", options: ["a", "b"] });
      live.respondExtensionUi({ id: selectRequest.id, value: "b" });
      await expect(selectPromise).resolves.toBe("b");
      expect(live.getState().pendingUi).toEqual([]);

      const confirmPromise = live.uiContext.confirm("Sure?", "Do it");
      live.respondExtensionUi({ id: latestUiRequest(events).id, confirmed: true });
      await expect(confirmPromise).resolves.toBe(true);

      const inputPromise = live.uiContext.input("Name", "your name");
      live.respondExtensionUi({ id: latestUiRequest(events).id, cancelled: true });
      await expect(inputPromise).resolves.toBeUndefined();
      // select, confirm and input all stopped being pending, so each broadcast a cancellation.
      expect(events.filter((event) => event.type === "ui_request_cancelled")).toHaveLength(3);

      const editorPromise = live.uiContext.editor("Edit", "prefill");
      live.respondExtensionUi({ id: latestUiRequest(events).id, value: "edited" });
      await expect(editorPromise).resolves.toBe("edited");

      const unknown = await harness.app.request(`/api/sessions/${id}/ui-response`, {
        method: "POST",
        headers: harness.authHeaders,
        body: JSON.stringify({ id: "nope", value: "x" }),
      });
      expect(unknown.status).toBe(404);

      const wrongValuePromise = live.uiContext.select("Types", ["a"]);
      const wrongValueId = latestUiRequest(events).id;
      const wrongValue = await harness.app.request(`/api/sessions/${id}/ui-response`, {
        method: "POST",
        headers: harness.authHeaders,
        body: JSON.stringify({ id: wrongValueId, value: 123 }),
      });
      expect(wrongValue.status).toBe(400);
      expect(live.getState().pendingUi).toHaveLength(1);
      live.respondExtensionUi({ id: wrongValueId, value: "a" });
      await expect(wrongValuePromise).resolves.toBe("a");

      const timeoutStart = events.length;
      await expect(live.uiContext.select("Timeout", ["a"], { timeout: 25 })).resolves.toBeUndefined();
      expect(
        events.slice(timeoutStart).filter((event) => event.type === "ui_request_cancelled"),
      ).toHaveLength(1);

      const controller = new AbortController();
      const abortedPromise = live.uiContext.input("Aborted", undefined, { signal: controller.signal });
      const pendingPromise = live.uiContext.confirm("Also pending", "message");
      controller.abort();
      await expect(abortedPromise).resolves.toBeUndefined();
      await live.abort();
      await expect(pendingPromise).resolves.toBe(false);
      expect(live.getState().pendingUi).toEqual([]);

      live.uiContext.setStatus("mode", "fast");
      live.uiContext.setWidget("stats", ["line one"], { placement: "belowEditor" });
      live.uiContext.setWorkingMessage("working…");
      const state = live.getState();
      expect(state.statuses).toEqual({ mode: "fast" });
      expect(state.widgets).toEqual({ stats: { lines: ["line one"], placement: "belowEditor" } });
      expect(state.workingMessage).toBe("working…");

      live.uiContext.setStatus("mode", undefined);
      live.uiContext.setWidget("stats", undefined);
      live.uiContext.setWorkingMessage(undefined);
      expect(live.getState().statuses).toEqual({});
      expect(live.getState().widgets).toEqual({});
      expect(live.getState().workingMessage).toBeUndefined();

      live.uiContext.notify("careful", "warning");
      expect(events.at(-1)).toEqual({ type: "notify", message: "careful", level: "warning" });
    } finally {
      await harness.close();
    }
  });

  it("closes a dialog for every connected client once one client answers", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      const first: ServerEvent[] = [];
      const second: ServerEvent[] = [];
      live.addClient((event) => first.push(event));
      live.addClient((event) => second.push(event));

      const answer = live.uiContext.select("Pick", ["a", "b"]);
      const request = latestUiRequest(first);
      expect(latestUiRequest(second).id).toBe(request.id);
      expect(live.getState().pendingUi).toHaveLength(1);

      live.respondExtensionUi({ id: request.id, value: "b" });
      await expect(answer).resolves.toBe("b");
      expect(live.getState().pendingUi).toEqual([]);

      for (const events of [first, second]) {
        expect(
          events.some((event) => event.type === "ui_request_cancelled" && event.id === request.id),
        ).toBe(true);
        expect(events.at(-1)?.type).toBe("state");
      }
    } finally {
      await harness.close();
    }
  });

  it("broadcasts state to clients after model and thinking changes", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      const events: ServerEvent[] = [];
      live.addClient((event) => events.push(event));
      const start = events.length;

      const modelState = await live.setModel({ provider: "faux", id: "faux-2" });
      expect(modelState.model).toEqual({ provider: "faux", id: "faux-2" });
      const modelEvent = await waitFor(() =>
        events.slice(start).find(
          (event): event is Extract<ServerEvent, { type: "state" }> =>
            event.type === "state" && event.state.model?.id === "faux-2",
        ),
      );
      expect(modelEvent.state.model).toEqual({ provider: "faux", id: "faux-2" });

      const target = live.session
        .getAvailableThinkingLevels()
        .find((level) => level !== live.session.thinkingLevel);
      expect(target).toBeDefined();
      const thinkingState = live.setThinking(target!);
      expect(thinkingState.thinkingLevel).toBe(target);

      const thinkingEvent = events.findLast(
        (event): event is Extract<ServerEvent, { type: "state" }> =>
          event.type === "state" && event.state.thinkingLevel === target,
      );
      expect(thinkingEvent).toBeDefined();
      expect(thinkingEvent!.state.model).toEqual({ provider: "faux", id: "faux-2" });
    } finally {
      await harness.close();
    }
  });

  it("cancels dialogs on dispose and exposes commands", async () => {
    const harness = await createHarness();
    try {
      const live = await harness.createSession();
      const events: ServerEvent[] = [];
      live.addClient((event) => events.push(event));
      const pending = live.uiContext.select("Never answered", ["a"]);
      await live.dispose();
      await expect(pending).resolves.toBeUndefined();
      expect(events.some((event) => event.type === "closed")).toBe(true);
      expect(live.getCommands()).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
