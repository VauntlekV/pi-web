/**
 * Live session stream: one EventSource per session, reconnecting with backoff.
 * Events that are not part of the transcript view (notify / error / retry /
 * settled) are handed to the caller; everything else goes through applyEvent.
 */
import { useEffect, useRef, useState } from "react";
import type { ServerEvent } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { applyEvent, emptyView, type SessionView } from "./session-reducer.ts";

export interface SessionStreamHandlers {
  onNotify: (message: string, level: "info" | "warning" | "error") => void;
  onError: (message: string) => void;
  onSettled: (aborted: boolean) => void;
}

const MAX_BACKOFF_MS = 10_000;
const CLOSED_RETRY_MS = 500;

export function useSessionStream(id: string | null, handlers: SessionStreamHandlers): SessionView {
  const [view, setView] = useState<SessionView>(emptyView);
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    setView(emptyView);
    if (!id) return;

    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let disposed = false;

    const schedule = (delay: number) => {
      if (disposed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
    };

    const markDisconnected = () => {
      setView((current) => (current.connected ? { ...current, connected: false } : current));
    };

    const connect = () => {
      if (disposed) return;
      const es = new EventSource(api.eventsUrl(id));
      source = es;

      es.onmessage = (event) => {
        if (disposed) return;
        let serverEvent: ServerEvent;
        try {
          serverEvent = JSON.parse(event.data) as ServerEvent;
        } catch {
          return;
        }

        if (serverEvent.type === "snapshot") {
          attempt = 0;
        } else if (serverEvent.type === "notify") {
          handlersRef.current.onNotify(serverEvent.message, serverEvent.level);
        } else if (serverEvent.type === "error") {
          handlersRef.current.onError(serverEvent.message);
        } else if (serverEvent.type === "agent_settled") {
          handlersRef.current.onSettled(serverEvent.aborted);
        } else if (serverEvent.type === "retry_start") {
          handlersRef.current.onNotify(
            `请求失败，${Math.round(serverEvent.delayMs / 1000)} 秒后重试（第 ${serverEvent.attempt}/${serverEvent.maxAttempts} 次）`,
            "warning",
          );
        }

        setView((current) => applyEvent(current, serverEvent));

        if (serverEvent.type === "closed") {
          es.close();
          source = null;
          markDisconnected();
          schedule(CLOSED_RETRY_MS);
        }
      };

      es.onerror = () => {
        if (disposed) return;
        es.close();
        source = null;
        markDisconnected();
        const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
        attempt += 1;
        schedule(delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
      source?.close();
    };
  }, [id]);

  return view;
}
