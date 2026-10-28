import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  ServerEvent,
  SessionState,
  TranscriptItem,
  UserMessage,
} from "../../../shared/protocol.ts";
import { applyEvent, emptyView, type SessionView } from "./session-reducer.ts";

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "s1",
    cwd: "/tmp/demo",
    thinkingLevel: "off",
    availableThinkingLevels: ["off"],
    isStreaming: false,
    isCompacting: false,
    isRetrying: false,
    steering: [],
    followUp: [],
    activeTools: [],
    stats: {
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
    statuses: {},
    widgets: {},
    pendingUi: [],
    ...overrides,
  };
}

function assistant(text: string, stopReason: AssistantMessage["stopReason"] = "pending"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "demo",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  };
}

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 1 };
}

describe("applyEvent", () => {
  it("walks a full turn: items, streaming and tools end up correct", () => {
    let view: SessionView = applyEvent(emptyView, {
      type: "snapshot",
      state: makeState({ isStreaming: true }),
      transcript: [],
      streaming: null,
    });
    expect(view.connected).toBe(true);

    view = applyEvent(view, { type: "message_start", message: assistant("Hel") });
    expect(view.streaming?.content).toEqual([{ type: "text", text: "Hel" }]);

    view = applyEvent(view, { type: "message_update", message: assistant("Hello") });
    expect(view.streaming?.content).toEqual([{ type: "text", text: "Hello" }]);

    view = applyEvent(view, {
      type: "tool_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(view.tools.t1).toEqual({ status: "running" });

    view = applyEvent(view, {
      type: "tool_update",
      toolCallId: "t1",
      toolName: "bash",
      partial: { content: [{ type: "text", text: "a\nb" }] },
    });
    expect(view.tools.t1.status).toBe("running");
    expect(view.tools.t1.partial?.content).toEqual([{ type: "text", text: "a\nb" }]);

    view = applyEvent(view, {
      type: "tool_end",
      toolCallId: "t1",
      toolName: "bash",
      isError: false,
      durationMs: 42,
    });
    expect(view.tools.t1).toMatchObject({ status: "done", durationMs: 42 });
    expect(view.tools.t1.partial).toBeDefined();

    view = applyEvent(view, { type: "tool_start", toolCallId: "t2", toolName: "read", args: {} });
    view = applyEvent(view, { type: "tool_end", toolCallId: "t2", toolName: "read", isError: true });
    expect(view.tools.t2.status).toBe("error");

    view = applyEvent(view, { type: "message_end", message: assistant("Hello", "stop"), entryId: "e1" });
    expect(view.items).toHaveLength(1);
    expect(view.items[0]).toEqual({ entryId: "e1", message: assistant("Hello", "stop") });
    expect(view.streaming).toBeNull();

    view = applyEvent(view, { type: "agent_settled", aborted: false });
    expect(view.streaming).toBeNull();
    expect(view.tools.t1.status).toBe("done");
  });

  it("deduplicates message_end by entryId but appends null ids", () => {
    const end: ServerEvent = { type: "message_end", message: user("hi"), entryId: "e1" };
    let view = applyEvent(emptyView, end);
    view = applyEvent(view, end);
    expect(view.items).toHaveLength(1);

    const noEntry: ServerEvent = { type: "message_end", message: assistant("x", "stop"), entryId: null };
    view = applyEvent(view, noEntry);
    view = applyEvent(view, noEntry);
    expect(view.items).toHaveLength(3);
    expect(view.items.map((item) => item.entryId)).toEqual(["e1", null, null]);
  });

  it("snapshot replaces stale data and clears tools", () => {
    let view = applyEvent(emptyView, {
      type: "snapshot",
      state: makeState(),
      transcript: [{ entryId: "old", message: user("old") }],
      streaming: null,
    });
    view = applyEvent(view, { type: "tool_start", toolCallId: "t1", toolName: "bash", args: {} });
    view = applyEvent(view, { type: "message_start", message: assistant("partial") });

    const transcript: TranscriptItem[] = [{ entryId: "new", message: user("new") }];
    view = applyEvent(view, {
      type: "snapshot",
      state: makeState({ id: "s2" }),
      transcript,
      streaming: null,
    });
    expect(view.state?.id).toBe("s2");
    expect(view.items).toEqual(transcript);
    expect(view.streaming).toBeNull();
    expect(view.tools).toEqual({});
    expect(view.connected).toBe(true);
  });

  it("session_name and ui_request are no-ops while state is null", () => {
    expect(applyEvent(emptyView, { type: "session_name", name: "x" })).toBe(emptyView);
    expect(
      applyEvent(emptyView, {
        type: "ui_request",
        request: { id: "u1", method: "select", title: "Pick", options: ["a"] },
      }),
    ).toBe(emptyView);
    expect(applyEvent(emptyView, { type: "ui_request_cancelled", id: "u1" })).toBe(emptyView);
  });

  it("applies names and extension dialogs to a live state", () => {
    let view = applyEvent(emptyView, { type: "snapshot", state: makeState(), transcript: [], streaming: null });
    view = applyEvent(view, { type: "session_name", name: "My session" });
    expect(view.state?.name).toBe("My session");

    const request = { id: "u1", method: "confirm", title: "Go?", message: "Sure?" } as const;
    view = applyEvent(view, { type: "ui_request", request });
    view = applyEvent(view, { type: "ui_request", request });
    expect(view.state?.pendingUi).toEqual([request]);

    view = applyEvent(view, { type: "ui_request_cancelled", id: "u1" });
    expect(view.state?.pendingUi).toEqual([]);
  });

  it("transcript_reset replaces items and clears streaming", () => {
    let view = applyEvent(emptyView, {
      type: "snapshot",
      state: makeState(),
      transcript: [{ entryId: "a", message: user("a") }],
      streaming: null,
    });
    view = applyEvent(view, { type: "message_start", message: assistant("partial") });
    view = applyEvent(view, {
      type: "transcript_reset",
      transcript: [{ entryId: "b", message: user("b") }],
    });
    expect(view.items).toEqual([{ entryId: "b", message: user("b") }]);
    expect(view.streaming).toBeNull();
  });

  it("returns the same view for events it does not render", () => {
    let view = applyEvent(emptyView, { type: "snapshot", state: makeState(), transcript: [], streaming: null });
    const events: ServerEvent[] = [
      { type: "agent_start" },
      { type: "notify", message: "hi", level: "info" },
      { type: "error", message: "boom" },
      { type: "retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "x" },
      { type: "retry_end", success: true },
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual", aborted: false },
      { type: "closed" },
      { type: "from-the-future" } as unknown as ServerEvent,
    ];
    for (const event of events) {
      expect(applyEvent(view, event)).toBe(view);
    }
  });

  it("marks a running tool as error on tool_end without prior update", () => {
    const view = applyEvent(emptyView, {
      type: "tool_end",
      toolCallId: "t9",
      toolName: "edit",
      isError: true,
      durationMs: 7,
    });
    expect(view.tools.t9).toEqual({ status: "error", partial: undefined, durationMs: 7 });
  });
});
