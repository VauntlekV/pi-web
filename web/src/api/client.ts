/**
 * Typed HTTP client for the pi-web server. One function per route in
 * shared/protocol.ts. All requests are same-origin and carry the auth cookie.
 *
 * A 401 from any call fires `onUnauthorized` listeners (the app shows the login
 * screen) and rejects with ApiRequestError(401).
 */
import type {
  CommandInfo,
  ConfigResponse,
  CreateSessionRequest,
  ExtensionUiResponse,
  FileReadResponse,
  FileTreeResponse,
  FsListResponse,
  GeneralSettings,
  GitCommit,
  GitDiffResponse,
  GitStatus,
  PackageOpResult,
  ProvidersView,
  ResourcesView,
  ResourceToggleRequest,
  SettingsView,
  UiState,
  UsageStats,
  ModelRef,
  ModelsResponse,
  PromptRequest,
  SessionState,
  ThinkingLevel,
  TranscriptItem,
  Workspace,
} from "../../../shared/protocol.ts";

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(path, init);
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    for (const listener of unauthorizedListeners) listener();
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = (data as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiRequestError(res.status, message);
  }
  return data as T;
}

const enc = encodeURIComponent;
const session = (id: string) => `/api/sessions/${enc(id)}`;

export const api = {
  // auth
  authCheck: () => request<{ authRequired: boolean }>("GET", "/api/auth/check"),
  login: (token: string) => request<{ ok: true }>("POST", "/api/auth/login", { token }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),

  // global
  config: () => request<ConfigResponse>("GET", "/api/config"),
  workspaces: () => request<{ workspaces: Workspace[] }>("GET", "/api/workspaces"),
  models: (sessionId?: string) =>
    request<ModelsResponse>("GET", `/api/models${sessionId ? `?sessionId=${enc(sessionId)}` : ""}`),
  listDirs: (path?: string) => request<FsListResponse>("GET", `/api/fs/list${path ? `?path=${enc(path)}` : ""}`),
  searchFiles: (cwd: string, q: string) =>
    request<{ files: string[] }>("GET", `/api/fs/files?cwd=${enc(cwd)}&q=${enc(q)}`),

  // sessions
  createSession: (req: CreateSessionRequest) => request<{ state: SessionState }>("POST", "/api/sessions", req),
  getSession: (id: string) => request<{ state: SessionState; transcript: TranscriptItem[] }>("GET", session(id)),
  renameSession: (id: string, name: string) => request<{ state: SessionState }>("PATCH", session(id), { name }),
  deleteSession: (id: string) => request<{ ok: true }>("DELETE", session(id)),
  commands: (id: string) => request<{ commands: CommandInfo[] }>("GET", `${session(id)}/commands`),

  prompt: (id: string, req: PromptRequest) => request<{ ok: true }>("POST", `${session(id)}/prompt`, req),
  abort: (id: string) => request<{ ok: true }>("POST", `${session(id)}/abort`),
  setModel: (id: string, ref: ModelRef) => request<{ state: SessionState }>("POST", `${session(id)}/model`, ref),
  setThinking: (id: string, level: ThinkingLevel) =>
    request<{ state: SessionState }>("POST", `${session(id)}/thinking`, { level }),
  compact: (id: string, instructions?: string) =>
    request<{ ok: true }>("POST", `${session(id)}/compact`, instructions ? { instructions } : {}),
  respondUi: (id: string, response: ExtensionUiResponse) =>
    request<{ ok: true }>("POST", `${session(id)}/ui-response`, response),

  /** SSE URL for EventSource; the cookie authenticates it. */
  eventsUrl: (id: string) => `${session(id)}/events`,
  reloadSession: (id: string) => request<{ state: SessionState }>("POST", `${session(id)}/reload`),
  /** Download URL for the session .jsonl */
  exportUrl: (id: string) => `${session(id)}/export`,

  // workspace files
  fileTree: (cwd: string, path = "") =>
    request<FileTreeResponse>("GET", `/api/files/tree?cwd=${enc(cwd)}&path=${enc(path)}`),
  readFile: (cwd: string, path: string) =>
    request<FileReadResponse>("GET", `/api/files/read?cwd=${enc(cwd)}&path=${enc(path)}`),
  /** URL of the raw bytes (images, downloads) */
  rawFileUrl: (cwd: string, path: string) => `/api/files/raw?cwd=${enc(cwd)}&path=${enc(path)}`,

  // git
  gitStatus: (cwd: string) => request<GitStatus>("GET", `/api/git/status?cwd=${enc(cwd)}`),
  gitDiff: (cwd: string, path: string, staged: boolean) =>
    request<GitDiffResponse>("GET", `/api/git/diff?cwd=${enc(cwd)}&path=${enc(path)}&staged=${staged ? 1 : 0}`),
  gitLog: (cwd: string, limit = 30) =>
    request<{ commits: GitCommit[] }>("GET", `/api/git/log?cwd=${enc(cwd)}&limit=${limit}`),
  gitStage: (cwd: string, paths: string[]) => request<GitStatus>("POST", "/api/git/stage", { cwd, paths }),
  gitUnstage: (cwd: string, paths: string[]) => request<GitStatus>("POST", "/api/git/unstage", { cwd, paths }),
  gitCommit: (cwd: string, message: string) =>
    request<{ commit: GitCommit; status: GitStatus }>("POST", "/api/git/commit", { cwd, message }),

  // settings
  settings: () => request<SettingsView>("GET", "/api/settings"),
  updateSettings: (patch: Partial<GeneralSettings>) => request<SettingsView>("PATCH", "/api/settings", patch),
  settingsFile: () => request<{ path: string; text: string }>("GET", "/api/settings/file"),
  providers: () => request<ProvidersView>("GET", "/api/providers"),
  setProviderKey: (id: string, apiKey: string) =>
    request<ProvidersView>("PUT", `/api/providers/${enc(id)}/key`, { apiKey }),
  removeProviderKey: (id: string) => request<ProvidersView>("DELETE", `/api/providers/${enc(id)}/key`),
  setDefaultModel: (ref: ModelRef & { thinkingLevel?: ThinkingLevel }) =>
    request<ProvidersView>("PUT", "/api/default-model", ref),
  setEnabledModels: (patterns: string[] | null) =>
    request<ProvidersView>("PUT", "/api/enabled-models", { patterns }),
  resources: (cwd?: string) => request<ResourcesView>("GET", `/api/resources${cwd ? `?cwd=${enc(cwd)}` : ""}`),
  toggleResource: (req: ResourceToggleRequest) => request<ResourcesView>("POST", "/api/resources/toggle", req),
  installPackage: (source: string, opts: { local?: boolean; cwd?: string } = {}) =>
    request<PackageOpResult>("POST", "/api/packages/install", { source, ...opts }),
  removePackage: (source: string, opts: { local?: boolean; cwd?: string } = {}) =>
    request<PackageOpResult>("POST", "/api/packages/remove", { source, ...opts }),
  updatePackages: (source?: string, cwd?: string) =>
    request<PackageOpResult>("POST", "/api/packages/update", { source, cwd }),

  // misc
  stats: (range: UsageStats["range"] = "all") => request<UsageStats>("GET", `/api/stats?range=${range}`),
  uiState: () => request<UiState>("GET", "/api/ui-state"),
  setUiState: (state: UiState) => request<UiState>("PUT", "/api/ui-state", state),
};
