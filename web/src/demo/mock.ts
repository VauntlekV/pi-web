/**
 * GitHub Pages demo backend: replaces fetch("/api/…") and EventSource with a
 * replay of demo-data.json (recorded from the real server by demo/record.ts).
 * Reads come from the recording; new sessions and prompts replay the recorded
 * agent turn; other writes answer "read-only". Only bundled in `--mode demo`.
 */
import type {
  AgentMessage,
  ServerEvent,
  SessionState,
  SessionSummary,
  TranscriptItem,
  Workspace,
} from "../../../shared/protocol.ts";
import type { DemoData } from "./data.ts";

const READ_ONLY = "演示站点是只读的：安装 pi-web 后可以完整使用（npm i -g @vauntlek/pi-web）";
const REPO_URL = "https://github.com/VauntlekV/pi-web";

interface DemoSession {
  state: SessionState;
  transcript: TranscriptItem[];
  timers: number[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const clone = <T>(value: T): T => structuredClone(value);

export async function installDemo(): Promise<void> {
  const realFetch = window.fetch.bind(window);
  const data = (await (await realFetch(`${import.meta.env.BASE_URL}demo-data.json`)).json()) as DemoData;

  const recorded = (key: string) => data.responses[key];
  const sessions = new Map<string, DemoSession>();
  const streams = new Map<string, Set<DemoEventSource>>();
  const main = recorded(`GET /api/sessions/${encodeURIComponent(data.sessionId)}`)?.body as
    | { state: SessionState; transcript: TranscriptItem[] }
    | undefined;
  if (main) sessions.set(data.sessionId, { ...clone(main), timers: [] });
  let workspaces = clone((recorded("GET /api/workspaces")?.body as { workspaces: Workspace[] }).workspaces);
  let counter = 0;

  const emit = (id: string, event: ServerEvent) => {
    for (const source of streams.get(id) ?? []) source.deliver(event);
  };

  const summaryOf = (session: DemoSession, firstMessage: string): SessionSummary => {
    const template = workspaces.flatMap((workspace) => workspace.sessions)[0];
    const now = new Date().toISOString();
    return {
      ...(template ?? { path: "", messageCount: 0 }),
      id: session.state.id,
      cwd: session.state.cwd,
      name: session.state.name,
      firstMessage,
      created: now,
      modified: now,
    } as SessionSummary;
  };

  const touchSummary = (session: DemoSession, firstMessage?: string) => {
    workspaces = workspaces.map((workspace) => {
      if (workspace.cwd !== session.state.cwd) return workspace;
      const existing = workspace.sessions.find((item) => item.id === session.state.id);
      const next = existing
        ? { ...existing, name: session.state.name, modified: new Date().toISOString() }
        : summaryOf(session, firstMessage ?? "");
      return {
        ...workspace,
        lastActive: new Date().toISOString(),
        sessions: [next, ...workspace.sessions.filter((item) => item.id !== session.state.id)],
      };
    });
  };

  /** The recorded turn with the user's own text, ids made unique per replay. */
  const replay = (session: DemoSession, text: string) => {
    const id = session.state.id;
    const run = ++counter;
    const rewrite = (message: AgentMessage): AgentMessage =>
      message.role === "user" ? ({ ...message, content: [{ type: "text", text }], timestamp: Date.now() } as AgentMessage) : message;
    for (const { at, event } of data.turn) {
      const timer = window.setTimeout(() => {
        let next = clone(event);
        if (next.type === "state") next = { ...next, state: { ...next.state, id, cwd: session.state.cwd, name: session.state.name ?? next.state.name } };
        if (next.type === "message_start") next = { ...next, message: rewrite(next.message) };
        if (next.type === "message_end") {
          next = { ...next, message: rewrite(next.message), entryId: next.entryId && `${next.entryId}-${run}` };
          session.transcript.push({ entryId: next.entryId, message: next.message });
        }
        if (next.type === "session_name") {
          if (session.state.name) return;
          // The recorded title belongs to the recorded prompt; name it after the user's own.
          const name = Array.from(text.trim().split("\n")[0] ?? "").slice(0, 20).join("") || next.name;
          next = { ...next, name };
          session.state.name = name;
          touchSummary(session);
        }
        if (next.type === "state") session.state = next.state;
        emit(id, next);
      }, at);
      session.timers.push(timer);
    }
  };

  const sessionRoute = /^\/api\/sessions\/([^/?]+)(\/[a-z-]+)?$/;

  const handle = async (method: string, url: string, body: unknown): Promise<Response> => {
    const path = url.split("?")[0];
    const query = new URLSearchParams(url.split("?")[1] ?? "");

    if (path === "/api/auth/check") return json({ authRequired: false });
    if (path === "/api/workspaces") return json({ workspaces });
    if (path === "/api/models") return json(recorded(`GET /api/models`)?.body);
    if (path === "/api/fs/files") {
      const all = (recorded(`GET /api/fs/files?cwd=${encodeURIComponent(data.cwd)}&q=`)?.body as { files: string[] }).files;
      const q = (query.get("q") ?? "").toLowerCase();
      return json({ files: all.filter((file) => file.toLowerCase().includes(q)) });
    }
    if (path === "/api/git/message") return json(recorded("POST /api/git/message")?.body);

    if (method === "POST" && path === "/api/sessions") {
      const id = `demo-${Date.now().toString(36)}`;
      const request = body as { cwd?: string };
      const state = { ...clone(data.created), id, cwd: request.cwd ?? data.cwd, name: undefined };
      sessions.set(id, { state, transcript: [], timers: [] });
      return json({ state });
    }

    const match = sessionRoute.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const action = match[2] ?? "";
      const session = sessions.get(id);
      if (!session) return json({ error: "会话不存在" }, 404);
      if (method === "GET" && action === "") return json({ state: session.state, transcript: session.transcript });
      if (method === "GET" && action === "/commands") {
        return json(recorded(`GET /api/sessions/${encodeURIComponent(data.sessionId)}/commands`)?.body ?? { commands: [] });
      }
      if (method === "POST" && action === "/prompt") {
        const text = (body as { text?: string }).text ?? "";
        touchSummary(session, text);
        replay(session, text);
        return json({ ok: true });
      }
      if (method === "POST" && action === "/abort") {
        for (const timer of session.timers.splice(0)) window.clearTimeout(timer);
        emit(id, { type: "agent_settled", aborted: true });
        return json({ ok: true });
      }
      if (method === "POST" && action === "/model") {
        session.state = { ...session.state, model: body as SessionState["model"] };
        emit(id, { type: "state", state: session.state });
        return json({ state: session.state });
      }
      if (method === "POST" && action === "/thinking") {
        session.state = { ...session.state, thinkingLevel: (body as { level: SessionState["thinkingLevel"] }).level };
        emit(id, { type: "state", state: session.state });
        return json({ state: session.state });
      }
      if (method === "PATCH" && action === "") {
        session.state = { ...session.state, name: (body as { name: string }).name };
        touchSummary(session);
        return json({ state: session.state });
      }
      if (method === "DELETE" && action === "") {
        sessions.delete(id);
        workspaces = workspaces.map((workspace) => ({ ...workspace, sessions: workspace.sessions.filter((item) => item.id !== id) }));
        return json({ ok: true });
      }
    }

    // Reads that are not session-specific come straight from the recording.
    const hit = method === "GET" ? recorded(`GET ${url}`) : undefined;
    if (hit) return json(hit.body, hit.status);
    if (method === "GET" && path === "/api/models") return json(recorded("GET /api/models")?.body);
    if (method === "GET") return json({ error: "演示站点没有录制这项数据" }, 404);
    return json({ error: READ_ONLY }, 403);
  };

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname + input.search : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    // A small delay keeps loading states honest without feeling slow.
    await new Promise((done) => setTimeout(done, 60));
    return handle(init?.method ?? "GET", url, body);
  };

  class DemoEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly url: string;
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private readonly id: string;

    constructor(url: string) {
      this.url = url;
      this.id = decodeURIComponent(/\/api\/sessions\/([^/]+)\/events/.exec(url)?.[1] ?? "");
      window.setTimeout(() => {
        if (this.readyState === 2) return;
        const session = sessions.get(this.id);
        if (!session) {
          this.onerror?.(new Event("error"));
          return;
        }
        this.readyState = 1;
        let set = streams.get(this.id);
        if (!set) streams.set(this.id, (set = new Set()));
        set.add(this);
        this.onopen?.(new Event("open"));
        this.deliver({ type: "snapshot", state: session.state, transcript: session.transcript, streaming: null });
      }, 0);
    }

    deliver(event: ServerEvent) {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
    }

    close() {
      this.readyState = 2;
      streams.get(this.id)?.delete(this);
    }

    addEventListener() {}
    removeEventListener() {}
  }
  window.EventSource = DemoEventSource as unknown as typeof EventSource;

  showBadge();
}

/** A small dismissible note that this is a recorded demo. */
function showBadge() {
  const badge = document.createElement("div");
  badge.className = "demo-badge";
  badge.innerHTML = `<span>演示站点 · 录制回放，写操作只读</span><a href="${REPO_URL}" target="_blank" rel="noreferrer">GitHub ↗</a><button type="button" aria-label="关闭">×</button>`;
  badge.querySelector("button")?.addEventListener("click", () => badge.remove());
  const style = document.createElement("style");
  style.textContent = `
    .demo-badge { position: fixed; left: 50%; bottom: 6px; z-index: 100; transform: translateX(-50%);
      display: flex; align-items: center; gap: 10px; padding: 4px 6px 4px 12px; border-radius: 999px;
      border: 1px solid var(--border-1); background: var(--overlay); box-shadow: var(--shadow-2);
      color: var(--ink-3); font-size: 12px; white-space: nowrap; }
    .demo-badge a { color: var(--accent); text-decoration: none; }
    .demo-badge button { width: 20px; height: 20px; border-radius: 999px; color: var(--ink-3); }
    .demo-badge button:hover { background: var(--hover-wash); color: var(--ink); }
    @media (max-width: 640px) { .demo-badge { top: 8px; bottom: auto; } }
  `;
  document.head.append(style);
  document.body.append(badge);
}
