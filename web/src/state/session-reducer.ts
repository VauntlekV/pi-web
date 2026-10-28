/**
 * Pure reducer over the SSE event stream. Everything the conversation page
 * renders comes from this view; side effects (toasts, refresh) live in the
 * hook that feeds it.
 */
import type { AssistantMessage, ServerEvent, SessionState, TranscriptItem } from "../../../shared/protocol.ts";
import type { ToolRuntime } from "../transcript/index.tsx";

export interface SessionView {
  state: SessionState | null;
  items: TranscriptItem[];
  streaming: AssistantMessage | null;
  /** Live tool state, keyed by toolCallId */
  tools: Record<string, ToolRuntime>;
  connected: boolean;
}

export const emptyView: SessionView = {
  state: null,
  items: [],
  streaming: null,
  tools: {},
  connected: false,
};

export function applyEvent(view: SessionView, ev: ServerEvent): SessionView {
  switch (ev.type) {
    case "snapshot":
      return { state: ev.state, items: ev.transcript, streaming: ev.streaming, tools: {}, connected: true };

    case "state":
      return { ...view, state: ev.state };

    case "message_start":
      return ev.message.role === "assistant" ? { ...view, streaming: ev.message } : view;

    case "message_update":
      return { ...view, streaming: ev.message };

    case "message_end": {
      const duplicate = ev.entryId !== null && view.items.some((item) => item.entryId === ev.entryId);
      const items = duplicate ? view.items : [...view.items, { entryId: ev.entryId, message: ev.message }];
      const streaming = ev.message.role === "assistant" ? null : view.streaming;
      return { ...view, items, streaming };
    }

    case "tool_start":
      return { ...view, tools: { ...view.tools, [ev.toolCallId]: { status: "running" } } };

    case "tool_update": {
      const previous = view.tools[ev.toolCallId];
      return {
        ...view,
        tools: {
          ...view.tools,
          [ev.toolCallId]: {
            status: previous?.status ?? "running",
            partial: ev.partial,
            durationMs: previous?.durationMs,
          },
        },
      };
    }

    case "tool_end":
      return {
        ...view,
        tools: {
          ...view.tools,
          [ev.toolCallId]: {
            status: ev.isError ? "error" : "done",
            partial: view.tools[ev.toolCallId]?.partial,
            durationMs: ev.durationMs,
          },
        },
      };

    case "agent_settled":
      return view.streaming === null ? view : { ...view, streaming: null };

    case "transcript_reset":
      return { ...view, items: ev.transcript, streaming: null };

    case "session_name":
      return view.state === null ? view : { ...view, state: { ...view.state, name: ev.name } };

    case "ui_request": {
      if (view.state === null) return view;
      if (view.state.pendingUi.some((request) => request.id === ev.request.id)) return view;
      return { ...view, state: { ...view.state, pendingUi: [...view.state.pendingUi, ev.request] } };
    }

    case "ui_request_cancelled": {
      if (view.state === null) return view;
      if (!view.state.pendingUi.some((request) => request.id === ev.id)) return view;
      return {
        ...view,
        state: { ...view.state, pendingUi: view.state.pendingUi.filter((request) => request.id !== ev.id) },
      };
    }

    // notify / error / retry_* / compaction_* / agent_start / closed: the hook
    // handles these; the view itself does not change.
    default:
      return view;
  }
}
