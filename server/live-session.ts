import { randomUUID } from "node:crypto";
import {
  Theme,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIDialogOptions,
  type ExtensionUIContext,
  type ExtensionWidgetOptions,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentMessage,
  AssistantMessage,
  CommandInfo,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ModelRef,
  PromptRequest,
  ServerEvent,
  SessionState,
  ThinkingLevel,
  ToolResultMessage,
  TranscriptItem,
} from "../shared/protocol.ts";
import { HttpError } from "./http-error.ts";
import { generateTitle } from "./title.ts";
import { buildTranscript } from "./transcript.ts";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const UPDATE_THROTTLE_MS = 50;
const PROMPT_ACCEPT_TIMEOUT_MS = 5000;
const TITLE_TIMEOUT_MS = 20_000;

type ClientWriter = (event: ServerEvent) => void;

interface PendingUi {
  request: ExtensionUiRequest;
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
}

/** Extensions expect a Theme; the web UI does its own styling, so render without ANSI codes. */
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { muted: "", text: "", thinkingXhigh: "", searchMatchText: "" } as unknown as ConstructorParameters<typeof Theme>[0],
      { selectedBg: "" } as unknown as ConstructorParameters<typeof Theme>[1],
      "truecolor",
    );
  }

  override style(text: string): string {
    return text;
  }

  override fg(_color: Parameters<Theme["fg"]>[0], text: string): string {
    return text;
  }

  override bg(_color: Parameters<Theme["bg"]>[0], text: string): string {
    return text;
  }

  override bold(text: string): string {
    return text;
  }

  override italic(text: string): string {
    return text;
  }

  override underline(text: string): string {
    return text;
  }

  override inverse(text: string): string {
    return text;
  }

  override strikethrough(text: string): string {
    return text;
  }
}

const UI_THEME = new PlainTextTheme();

export class LiveSession {
  readonly session: AgentSession;
  readonly uiContext: ExtensionUIContext;

  private readonly clients = new Set<ClientWriter>();
  private readonly statuses = new Map<string, string>();
  private readonly widgets = new Map<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>();
  private readonly pendingUi = new Map<string, PendingUi>();
  private readonly unsubscribe: () => void;
  private streaming: AssistantMessage | null = null;
  private pendingPartial: AssistantMessage | null = null;
  private partialTimer: NodeJS.Timeout | undefined;
  private lastPartialSentAt = 0;
  private workingMessage: string | undefined;
  private titleAttempted = false;
  private titleAbort: AbortController | undefined;
  private disposed = false;
  private lastActivityAt = Date.now();

  constructor(session: AgentSession) {
    this.session = session;
    this.uiContext = this.createUiContext();
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
  }

  // ------------------------------------------------------------------ clients

  get clientCount(): number {
    return this.clients.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  get isRunning(): boolean {
    return this.session.isStreaming || this.session.isCompacting || this.session.isRetrying;
  }

  get hasPendingUi(): boolean {
    return this.pendingUi.size > 0;
  }

  get hasUserMessage(): boolean {
    return this.session.messages.some((message) => message.role === "user");
  }

  /** First frame is a snapshot, then deltas. Returns an unsubscribe function. */
  addClient(write: ClientWriter): () => void {
    this.touch();
    write({
      type: "snapshot",
      state: this.getState(),
      transcript: this.getTranscript(),
      streaming: this.streaming,
    });
    this.clients.add(write);
    return () => {
      this.clients.delete(write);
    };
  }

  // ------------------------------------------------------------------- state

  getState(): SessionState {
    const session = this.session;
    const stats = session.getSessionStats();
    const model = session.model;
    return {
      id: session.sessionId,
      cwd: session.sessionManager.getCwd(),
      sessionFile: session.sessionFile,
      name: session.sessionName,
      model: model ? { provider: model.provider, id: model.id } : undefined,
      thinkingLevel: session.thinkingLevel as ThinkingLevel,
      availableThinkingLevels: session.getAvailableThinkingLevels() as ThinkingLevel[],
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isRetrying: session.isRetrying,
      steering: [...session.getSteeringMessages()],
      followUp: [...session.getFollowUpMessages()],
      activeTools: session.getActiveToolNames(),
      stats: {
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        tokens: stats.tokens,
        cost: stats.cost,
        contextUsage: stats.contextUsage,
      },
      statuses: Object.fromEntries(this.statuses),
      widgets: Object.fromEntries(
        [...this.widgets].map(([key, widget]) => [key, { lines: [...widget.lines], placement: widget.placement }]),
      ),
      workingMessage: this.workingMessage,
      pendingUi: [...this.pendingUi.values()].map((pending) => pending.request),
    };
  }

  getTranscript(): TranscriptItem[] {
    return buildTranscript(this.session.sessionManager.getBranch());
  }

  getCommands(): CommandInfo[] {
    const commands = new Map<string, CommandInfo>();
    for (const command of this.session.extensionRunner.getRegisteredCommands()) {
      commands.set(command.invocationName, {
        name: command.invocationName,
        description: command.description,
        source: "extension",
      });
    }
    for (const template of this.session.promptTemplates) {
      commands.set(template.name, {
        name: template.name,
        description: template.description,
        source: "prompt",
      });
    }
    for (const skill of this.session.resourceLoader.getSkills().skills) {
      const name = `skill:${skill.name}`;
      commands.set(name, { name, description: skill.description, source: "skill" });
    }
    return [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ----------------------------------------------------------------- commands

  async prompt(request: PromptRequest): Promise<void> {
    const text = (request.text ?? "").trim();
    const images = request.images ?? [];
    if (!text && images.length === 0) throw new HttpError(400, "prompt 不能为空");

    this.touch();
    let accepted = false;
    let resolveAccepted: () => void = () => {};
    let rejectBeforeAccepted: (error: unknown) => void = () => {};
    const acceptedPromise = new Promise<void>((resolve, reject) => {
      resolveAccepted = resolve;
      rejectBeforeAccepted = reject;
    });

    const run = this.session.prompt(text, {
      images: images.length > 0 ? images : undefined,
      streamingBehavior: request.behavior ?? "followUp",
      source: "rpc",
      preflightResult: () => {
        accepted = true;
        resolveAccepted();
      },
    });

    run.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (accepted) this.emitError(message);
      else rejectBeforeAccepted(new Error(message));
    });

    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PROMPT_ACCEPT_TIMEOUT_MS);
      timer.unref?.();
    });

    try {
      await Promise.race([acceptedPromise, timeout]);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  async abort(): Promise<void> {
    this.touch();
    this.cancelAllPendingUi();
    try {
      await this.session.abort();
    } catch (error) {
      this.emitError(error);
    }
  }

  async setModel(ref: ModelRef): Promise<SessionState> {
    const model = this.session.modelRuntime.getModel(ref.provider, ref.id);
    if (!model) throw new HttpError(400, `未知模型 ${ref.provider}/${ref.id}`);
    await this.session.setModel(model);
    // The model switch may clamp the thinking level; every client needs the new state.
    this.broadcastState();
    return this.getState();
  }

  setThinking(level: ThinkingLevel): SessionState {
    if (!THINKING_LEVELS.includes(level)) throw new HttpError(400, `未知 thinking level: ${level}`);
    if (!this.session.getAvailableThinkingLevels().includes(level)) {
      throw new HttpError(400, `当前模型不支持 thinking level: ${level}`);
    }
    this.session.setThinkingLevel(level);
    this.broadcastState();
    return this.getState();
  }

  compact(instructions?: string): void {
    this.touch();
    void this.session.compact(instructions).catch((error: unknown) => this.emitError(error));
  }

  rename(name: string): SessionState {
    if (typeof name !== "string") throw new HttpError(400, "name 必须是字符串");
    const trimmed = name.trim();
    const length = Array.from(trimmed).length;
    if (length < 1 || length > 200) throw new HttpError(400, "name 长度必须在 1 到 200 之间");
    this.session.setSessionName(trimmed);
    return this.getState();
  }

  respondExtensionUi(response: ExtensionUiResponse): void {
    const pending = this.pendingUi.get(response.id);
    if (!pending) throw new HttpError(404, "未知的 UI 请求");
    if ("cancelled" in response && response.cancelled) {
      pending.cancel();
      return;
    }
    if (pending.request.method === "confirm") {
      if (typeof (response as { confirmed?: unknown }).confirmed !== "boolean") {
        throw new HttpError(400, "confirm 响应需要 confirmed 布尔值");
      }
    } else if (typeof (response as { value?: unknown }).value !== "string") {
      throw new HttpError(400, "该对话框需要 value 字符串");
    }
    pending.resolve(response);
  }

  /**
   * Re-read settings, extensions, skills, prompts, and themes for this session, then tell
   * clients the transcript may have changed.
   *
   * A changed provider API key does not need this: the SDK re-reads auth.json on the next
   * request. Call reload after editing settings.json or enabling/installing resources.
   */
  async reload(): Promise<SessionState> {
    if (this.isRunning) throw new HttpError(409, "会话正在运行，无法重载");
    await this.session.reload();
    this.broadcast({ type: "transcript_reset", transcript: this.getTranscript() });
    this.broadcastState();
    return this.getState();
  }

  async bind(): Promise<void> {
    await this.session.bindExtensions({
      uiContext: this.uiContext,
      mode: "rpc",
      commandContextActions: {
        waitForIdle: () => this.session.waitForIdle(),
        newSession: async () => {
          this.notify("pi-web 暂不支持新建会话", "warning");
          return { cancelled: true };
        },
        fork: async () => {
          this.notify("pi-web 暂不支持 fork", "warning");
          return { cancelled: true };
        },
        navigateTree: async () => {
          this.notify("pi-web 暂不支持会话树导航", "warning");
          return { cancelled: true };
        },
        switchSession: async () => {
          this.notify("pi-web 暂不支持切换会话", "warning");
          return { cancelled: true };
        },
        reload: async () => {
          if (typeof this.session.reload !== "function") throw new Error("当前会话不支持 reload");
          await this.session.reload();
        },
      },
      shutdownHandler: () => this.notify("扩展请求关闭会话，pi-web 暂不支持", "warning"),
      onError: (error) => {
        const message = `扩展 ${error.extensionPath} 在 ${error.event} 出错: ${error.error}`;
        console.error(`[pi-web] ${message}`);
        this.notify(message, "error");
      },
    });
  }

  notify(message: string, level: "info" | "warning" | "error" = "info"): void {
    this.broadcast({ type: "notify", message, level });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.titleAbort?.abort();
    this.cancelAllPendingUi();
    this.clearPartialTimer();
    this.unsubscribe();
    this.broadcast({ type: "closed" });
    this.clients.clear();
    try {
      await this.session.abort();
    } catch {
      // Disposing anyway.
    }
    try {
      this.session.dispose();
    } catch (error) {
      console.error("[pi-web] 会话释放失败:", error instanceof Error ? error.message : error);
    }
  }

  // ------------------------------------------------------------------ events

  private onEvent(event: AgentSessionEvent): void {
    this.touch();
    switch (event.type) {
      case "agent_start":
        this.broadcast({ type: "agent_start" });
        this.broadcastState();
        break;

      case "message_start":
        if (event.message.role === "assistant") {
          this.streaming = event.message as unknown as AssistantMessage;
          this.broadcast({ type: "message_start", message: event.message as unknown as AgentMessage });
        }
        break;

      case "message_update": {
        if (event.message.role !== "assistant") break;
        this.streaming = event.message as unknown as AssistantMessage;
        this.queuePartial(this.streaming);
        break;
      }

      case "message_end": {
        const message = event.message;
        if (message.role === "system") break;
        if (message.role === "custom" && message.display === false) break;
        if (message.role === "assistant") {
          this.streaming = message as unknown as AssistantMessage;
          this.queuePartial(this.streaming);
          this.flushPartial();
          this.streaming = null;
        } else {
          this.flushPartial();
        }
        // SessionManager persists the entry right after `_emit` returns, so read the leaf one
        // microtask later to report the persisted entryId.
        queueMicrotask(() => {
          this.broadcast({
            type: "message_end",
            message: message as unknown as AgentMessage,
            entryId: this.entryIdFor(message),
          });
        });
        break;
      }

      case "tool_execution_start":
        this.broadcast({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;

      case "tool_execution_update": {
        const partial = event.partialResult as Partial<ToolResultMessage> | undefined;
        this.broadcast({
          type: "tool_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partial: { content: partial?.content ?? [], details: partial?.details },
        });
        break;
      }

      case "tool_execution_end":
        this.broadcast({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
          durationMs: event.durationMs,
        });
        break;

      case "queue_update":
        this.broadcastState();
        break;

      case "thinking_level_changed":
        this.broadcastState();
        break;

      case "session_info_changed":
        this.broadcast({ type: "session_name", name: event.name });
        this.broadcastState();
        break;

      case "auto_retry_start":
        this.broadcast({
          type: "retry_start",
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          errorMessage: event.errorMessage,
        });
        this.broadcastState();
        break;

      case "auto_retry_end":
        this.broadcast({ type: "retry_end", success: event.success });
        this.broadcastState();
        break;

      case "compaction_start":
        this.broadcast({ type: "compaction_start", reason: event.reason });
        this.broadcastState();
        break;

      case "compaction_end":
        this.broadcast({
          type: "compaction_end",
          reason: event.reason,
          aborted: event.aborted,
          errorMessage: event.errorMessage,
        });
        this.broadcast({ type: "transcript_reset", transcript: this.getTranscript() });
        this.broadcastState();
        break;

      case "agent_settled":
        this.broadcast({ type: "agent_settled", aborted: event.aborted });
        this.broadcastState();
        if (event.aborted) this.cancelAllPendingUi();
        void this.maybeAutoTitle();
        break;

      default:
        break;
    }
  }

  private entryIdFor(message: unknown): string | null {
    const leaf = this.session.sessionManager.getLeafEntry();
    if (!leaf || leaf.type !== "message") return null;
    const persisted: unknown = leaf.message;
    if (persisted === message) return leaf.id;
    const a = persisted as { role?: unknown; timestamp?: unknown };
    const b = message as { role?: unknown; timestamp?: unknown };
    return a.role === b.role && a.timestamp === b.timestamp ? leaf.id : null;
  }

  // --------------------------------------------------------------- streaming

  private queuePartial(message: AssistantMessage): void {
    this.pendingPartial = message;
    const elapsed = Date.now() - this.lastPartialSentAt;
    if (elapsed >= UPDATE_THROTTLE_MS) {
      this.flushPartial();
      return;
    }
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = undefined;
      this.flushPartial();
    }, UPDATE_THROTTLE_MS - elapsed);
    this.partialTimer.unref?.();
  }

  private flushPartial(): void {
    this.clearPartialTimer();
    const message = this.pendingPartial;
    if (!message) return;
    this.pendingPartial = null;
    this.lastPartialSentAt = Date.now();
    this.broadcast({ type: "message_update", message });
  }

  private clearPartialTimer(): void {
    if (!this.partialTimer) return;
    clearTimeout(this.partialTimer);
    this.partialTimer = undefined;
  }

  private broadcastState(): void {
    this.broadcast({ type: "state", state: this.getState() });
  }

  private broadcast(event: ServerEvent): void {
    for (const write of [...this.clients]) {
      try {
        write(event);
      } catch {
        this.clients.delete(write);
      }
    }
  }

  private emitError(error: unknown): void {
    this.broadcast({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  // ------------------------------------------------------------------ titles

  private async maybeAutoTitle(): Promise<void> {
    if (this.titleAttempted || this.disposed || this.session.sessionName) return;
    this.titleAttempted = true;

    const controller = new AbortController();
    this.titleAbort = controller;
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    timer.unref?.();
    try {
      const name = await generateTitle(this.session, controller.signal);
      if (name && !this.disposed) this.session.setSessionName(name);
    } catch (error) {
      console.error("[pi-web] 自动标题失败:", error instanceof Error ? error.message : error);
    } finally {
      clearTimeout(timer);
      if (this.titleAbort === controller) this.titleAbort = undefined;
    }
  }

  // --------------------------------------------------------------- extension ui

  private createUiContext(): ExtensionUIContext {
    const context = {
      select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) =>
        this.createDialog<string | undefined>(
          {
            id: randomUUID(),
            method: "select",
            title,
            options,
            ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
          },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
          opts,
        ),

      confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
        this.createDialog<boolean>(
          {
            id: randomUUID(),
            method: "confirm",
            title,
            message,
            ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
          },
          false,
          (response) => ("confirmed" in response ? response.confirmed : false),
          opts,
        ),

      input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
        this.createDialog<string | undefined>(
          {
            id: randomUUID(),
            method: "input",
            title,
            ...(placeholder !== undefined ? { placeholder } : {}),
            ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
          },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
          opts,
        ),

      editor: (title: string, prefill?: string, opts?: ExtensionUIDialogOptions) =>
        this.createDialog<string | undefined>(
          {
            id: randomUUID(),
            method: "editor",
            title,
            ...(prefill !== undefined ? { prefill } : {}),
            ...(opts?.timeout !== undefined ? { timeout: opts.timeout } : {}),
          },
          undefined,
          (response) => ("value" in response ? response.value : undefined),
          opts,
        ),

      notify: (message: string, type?: "info" | "warning" | "error") => this.notify(message, type),

      onTerminalInput: () => () => {},

      setStatus: (key: string, text: string | undefined) => {
        if (text === undefined) this.statuses.delete(key);
        else this.statuses.set(key, text);
        this.broadcastState();
      },

      setWorkingMessage: (message?: string) => {
        this.workingMessage = message;
        this.broadcastState();
      },

      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},

      setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) => {
        if (content === undefined) {
          this.widgets.delete(key);
        } else if (Array.isArray(content)) {
          this.widgets.set(key, {
            lines: content as string[],
            placement: options?.placement ?? "aboveEditor",
          });
        } else {
          return; // TUI component factories have no web equivalent.
        }
        this.broadcastState();
      },

      setFooter: () => {},
      setHeader: () => {},
      setTitle: () => {},
      custom: async () => undefined,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() {
        return UI_THEME;
      },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "pi-web 暂不支持主题切换" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
    return context as unknown as ExtensionUIContext;
  }

  private createDialog<T>(
    request: ExtensionUiRequest,
    fallback: T,
    parse: (response: ExtensionUiResponse) => T,
    opts?: ExtensionUIDialogOptions,
  ): Promise<T> {
    if (this.disposed) return Promise.resolve(fallback);

    return new Promise<T>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const signal = opts?.signal;

      const finish = (value: T): void => {
        if (!this.pendingUi.has(request.id)) return;
        this.pendingUi.delete(request.id);
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(value);
        // Answered by any client, timed out, or aborted: every open client closes the dialog.
        this.broadcast({ type: "ui_request_cancelled", id: request.id });
        this.broadcastState();
      };

      const onAbort = (): void => finish(fallback);

      if (signal?.aborted) {
        resolve(fallback);
        return;
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (opts?.timeout !== undefined && opts.timeout > 0) {
        timer = setTimeout(() => finish(fallback), opts.timeout);
        timer.unref?.();
      }

      this.pendingUi.set(request.id, {
        request,
        resolve: (response) => finish(parse(response)),
        cancel: () => finish(fallback),
      });
      this.broadcast({ type: "ui_request", request });
    });
  }

  private cancelAllPendingUi(): void {
    for (const pending of [...this.pendingUi.values()]) pending.cancel();
  }
}
