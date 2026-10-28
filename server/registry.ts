import { statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
  type InlineExtension,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { CreateSessionRequest, SessionSummary, ThinkingLevel, Workspace } from "../shared/protocol.ts";
import { HttpError } from "./http-error.ts";
import { LiveSession, THINKING_LEVELS } from "./live-session.ts";

type ResourceLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

/** The CLI's built-in extensions, which the SDK does not load on its own. */
const BUILTIN_EXTENSIONS: InlineExtension[] = [
  { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
  { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
  { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface SessionRegistryOptions {
  defaultCwd: string;
  agentDir?: string;
  sessionDir?: string;
  resourceLoaderOptions?: ResourceLoaderOptions;
  settingsManagerFactory?: (cwd: string) => SettingsManager;
  onServices?: (services: AgentSessionServices) => void | Promise<void>;
  idleMs?: number;
}

export class SessionRegistry {
  readonly defaultCwd: string;
  readonly agentDir: string;
  readonly sessionDir: string | undefined;
  readonly idleMs: number;

  private readonly options: SessionRegistryOptions;
  private readonly live = new Map<string, LiveSession>();
  private readonly reviving = new Map<string, Promise<LiveSession>>();
  private readonly idleTimer: NodeJS.Timeout;
  private listCache: { at: number; infos: SessionInfo[] } | undefined;

  constructor(options: SessionRegistryOptions) {
    this.options = options;
    this.defaultCwd = resolve(options.defaultCwd);
    this.agentDir = options.agentDir ?? getAgentDir();
    this.sessionDir = options.sessionDir;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.idleTimer = setInterval(() => void this.sweepIdle(), 60_000);
    this.idleTimer.unref?.();
  }

  // ------------------------------------------------------------------- create

  async create(request: CreateSessionRequest): Promise<LiveSession> {
    const cwd = this.validateCwd(request.cwd);
    const thinkingLevel = this.validateThinking(request.thinkingLevel);
    const sessionManager = SessionManager.create(cwd, this.sessionDir);
    const services = await this.createServices(cwd);

    let model;
    if (request.model) {
      model = services.modelRuntime.getModel(request.model.provider, request.model.id);
      if (!model) throw new HttpError(400, `未知模型 ${request.model.provider}/${request.model.id}`);
    }

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    });

    const live = new LiveSession(session);
    this.live.set(session.sessionId, live);
    this.listCache = undefined;
    await this.bind(live);
    return live;
  }

  // -------------------------------------------------------------------- lookup

  async get(id: string): Promise<LiveSession> {
    this.validateId(id);

    const existing = this.live.get(id);
    if (existing) {
      if (!existing.isDisposed) return existing;
      this.live.delete(id);
    }

    const inFlight = this.reviving.get(id);
    if (inFlight) return inFlight;

    const reviving = this.revive(id).finally(() => this.reviving.delete(id));
    this.reviving.set(id, reviving);
    return reviving;
  }

  /** Every live (not disposed) session. */
  liveSessions(): LiveSession[] {
    return [...this.live.values()].filter((live) => !live.isDisposed);
  }

  /** The live session, without reviving one from disk. */
  peek(id: string): LiveSession | undefined {
    const live = this.live.get(id);
    return live && !live.isDisposed ? live : undefined;
  }

  private async revive(id: string): Promise<LiveSession> {
    const info = await this.findSessionInfo(id);
    if (!info) throw new HttpError(404, "会话不存在");

    const sessionManager = SessionManager.open(info.path, this.sessionDir);
    const sessionCwd = sessionManager.getCwd() || this.defaultCwd;
    const cwd = this.isDirectory(sessionCwd) ? sessionCwd : this.defaultCwd;
    const services = await this.createServices(cwd);
    const { session } = await createAgentSessionFromServices({ services, sessionManager });

    const live = new LiveSession(session);
    this.live.set(id, live);
    await this.bind(live);
    return live;
  }

  // ---------------------------------------------------------------- workspaces

  async listWorkspaces(): Promise<Workspace[]> {
    const infos = await this.listInfos();
    const onDisk = new Set(infos.map((info) => info.id));
    const summaries = new Map<string, SessionSummary>();

    for (const info of infos) summaries.set(info.id, this.summaryFor(info));

    for (const [id, live] of this.live) {
      if (live.isDisposed) continue;
      const existing = summaries.get(id);
      if (existing) {
        const name = live.session.sessionName;
        if (name !== undefined) existing.name = name;
        existing.live = true;
        existing.running = live.isRunning;
        existing.awaitingInput = live.hasPendingUi;
        continue;
      }
      if (onDisk.has(id) || !live.hasUserMessage) continue;
      summaries.set(id, this.liveOnlySummary(live));
    }

    const groups = new Map<string, SessionSummary[]>();
    for (const summary of summaries.values()) {
      const sessions = groups.get(summary.cwd);
      if (sessions) sessions.push(summary);
      else groups.set(summary.cwd, [summary]);
    }

    const workspaces: Workspace[] = [];
    for (const [cwd, sessions] of groups) {
      sessions.sort((a, b) => b.modified.localeCompare(a.modified));
      workspaces.push({
        cwd,
        label: cwd === "" ? "(unknown)" : basename(cwd) || cwd,
        sessions,
        lastActive: sessions[0]?.modified ?? new Date(0).toISOString(),
      });
    }
    workspaces.sort((a, b) => b.lastActive.localeCompare(a.lastActive));
    return workspaces;
  }

  private summaryFor(info: SessionInfo): SessionSummary {
    const live = this.live.get(info.id);
    return {
      id: info.id,
      path: info.path,
      cwd: info.cwd,
      name: live?.session.sessionName ?? info.name,
      firstMessage: info.firstMessage,
      messageCount: info.messageCount,
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      live: Boolean(live && !live.isDisposed),
      running: live?.isRunning ?? false,
      awaitingInput: live?.hasPendingUi ?? false,
    };
  }

  private liveOnlySummary(live: LiveSession): SessionSummary {
    const branch = live.session.sessionManager.getBranch();
    const messages = branch.filter((entry) => entry.type === "message" && entry.message.role !== "system");
    const firstUser = messages.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstMessage =
      firstUser && firstUser.type === "message"
        ? userText((firstUser.message as unknown as { content?: unknown }).content)
        : "";
    const created = branch[0]?.timestamp ?? new Date().toISOString();
    return {
      id: live.session.sessionId,
      path: live.session.sessionFile ?? "",
      cwd: live.session.sessionManager.getCwd() || this.defaultCwd,
      name: live.session.sessionName,
      firstMessage,
      messageCount: messages.length,
      created,
      modified: branch[branch.length - 1]?.timestamp ?? created,
      live: true,
      running: live.isRunning,
      awaitingInput: live.hasPendingUi,
    };
  }

  // -------------------------------------------------------------------- delete

  async delete(id: string): Promise<void> {
    this.validateId(id);
    const live = this.peek(id);
    if (live?.isRunning) throw new HttpError(409, "会话正在运行，无法删除");

    let path: string | undefined;
    if (live) {
      path = live.session.sessionFile;
      await live.dispose();
      this.live.delete(id);
    }
    if (!path) {
      const info = await this.findSessionInfo(id);
      if (!info) {
        if (live) return;
        throw new HttpError(404, "会话不存在");
      }
      path = info.path;
    }

    await rm(path, { force: true });
    this.listCache = undefined;
  }

  /** Dispose one live session (tests and explicit shutdowns). */
  async dispose(id: string): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    this.live.delete(id);
    await live.dispose();
  }

  async disposeAll(): Promise<void> {
    clearInterval(this.idleTimer);
    const lives = [...this.live.values()];
    this.live.clear();
    await Promise.all(lives.map((live) => live.dispose()));
  }

  // -------------------------------------------------------------------- internals

  private async createServices(cwd: string): Promise<AgentSessionServices> {
    const { extensionFactories, ...rest } = this.options.resourceLoaderOptions ?? {};
    const services = await createAgentSessionServices({
      cwd,
      agentDir: this.agentDir,
      settingsManager: this.options.settingsManagerFactory?.(cwd) ?? SettingsManager.create(cwd, this.agentDir),
      resourceLoaderOptions: {
        extensionFactories: [...BUILTIN_EXTENSIONS, ...(extensionFactories ?? [])],
        ...rest,
      },
    });
    await this.options.onServices?.(services);
    return services;
  }

  private async bind(live: LiveSession): Promise<void> {
    try {
      await live.bind();
    } catch (error) {
      console.error("[pi-web] 扩展绑定失败:", error instanceof Error ? error.message : error);
    }
  }

  private validateId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new HttpError(400, "非法会话 id");
  }

  private validateCwd(cwd: string | undefined): string {
    const requested = (cwd ?? "").trim() || this.defaultCwd;
    const resolved = resolve(this.defaultCwd, requested);
    if (!this.isDirectory(resolved)) throw new HttpError(400, "目录不存在");
    return resolved;
  }

  private validateThinking(level: ThinkingLevel | undefined): ThinkingLevel | undefined {
    if (level === undefined) return undefined;
    if (!THINKING_LEVELS.includes(level)) throw new HttpError(400, `未知 thinking level: ${level}`);
    return level;
  }

  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }

  private async listInfos(force = false): Promise<SessionInfo[]> {
    const now = Date.now();
    if (!force && this.listCache && now - this.listCache.at < 3000) return this.listCache.infos;
    const infos = await SessionManager.listAll(this.sessionDir);
    this.listCache = { at: now, infos };
    return infos;
  }

  private async findSessionInfo(id: string): Promise<SessionInfo | undefined> {
    const cached = await this.listInfos();
    const found = cached.find((info) => info.id === id);
    if (found) return found;
    const fresh = await this.listInfos(true);
    return fresh.find((info) => info.id === id);
  }

  private async sweepIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, live] of [...this.live]) {
      if (live.isDisposed) {
        this.live.delete(id);
        continue;
      }
      if (live.isRunning || live.clientCount > 0 || live.hasPendingUi) continue;
      if (now - live.lastActivity < this.idleMs) continue;
      this.live.delete(id);
      await live.dispose();
    }
  }
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
    .map((block) => block.text)
    .join(" ");
}
