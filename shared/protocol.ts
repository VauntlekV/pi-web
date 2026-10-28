/**
 * Wire protocol between the pi-web server and the browser.
 *
 * This file is the single contract both halves import. It holds types only (no
 * runtime code, no SDK imports), so the browser bundle never pulls in the pi SDK.
 * Message shapes mirror pi 1.4.0 (`@earendil-works/pi-ai` / `pi-coding-agent`)
 * structurally; the server passes SDK values through unchanged.
 *
 * Transport:
 *   - Commands: JSON over HTTP under `/api` (see `Api` below).
 *   - Live events: one Server-Sent Events stream per session,
 *     `GET /api/sessions/:id/events`, each frame `data: <ServerEvent JSON>`.
 *   - Auth: cookie `pi_web_token` (set by `POST /api/auth/login`) or header
 *     `Authorization: Bearer <token>`. Every `/api/*` route except
 *     `/api/auth/*` and `/api/health` answers 401 without it.
 *   - Errors: non-2xx with body `ApiError`.
 */

// ---------------------------------------------------------------- content

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  redacted?: boolean;
}

export interface ImageContent {
  type: "image";
  /** base64, no data: prefix */
  data: string;
  mimeType: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";

// ---------------------------------------------------------------- messages

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  provider: string;
  model: string;
  usage: Usage;
  /** "pending" only while streaming */
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  /**
   * Tool-specific. Known shapes:
   *   edit:  { diff: string; patch: string; firstChangedLine?: number }
   *   bash:  { truncation?: {...}; fullOutputPath?: string }
   *   read:  { truncation?: {...} }
   * Anything else: render as JSON only if small, otherwise ignore.
   */
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

/** `!cmd` shell runs typed by the user (pi's bash-execution message). */
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  excludeFromContext?: boolean;
  timestamp: number;
}

/** Extension-injected message; hide when `display` is false. */
export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | CompactionSummaryMessage
  | BranchSummaryMessage;

/**
 * A transcript row: a message plus the session entry it came from.
 * The server never sends pi's `role: "system"` messages (prompt/tool loadout
 * declarations) nor custom messages with `display: false`.
 */
export interface TranscriptItem {
  /** Session entry id; `null` for the in-flight streaming message. */
  entryId: string | null;
  message: AgentMessage;
}

// ---------------------------------------------------------------- models & sessions

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  /** Model supports reasoning / thinking levels other than "off" */
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Accepts image input */
  vision: boolean;
  /** USD per million tokens, when the catalog knows it */
  cost?: ModelCost;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export interface SessionSummary {
  id: string;
  /** Absolute path of the .jsonl file */
  path: string;
  cwd: string;
  /** User/auto name; falls back to firstMessage on the client */
  name?: string;
  firstMessage: string;
  messageCount: number;
  /** ISO 8601 */
  created: string;
  /** ISO 8601 */
  modified: string;
  /** An AgentSession for it is live in this server process */
  live: boolean;
  /** Live and currently running (streaming, compacting, or retrying) */
  running: boolean;
  /** Live and waiting on an extension dialog answer */
  awaitingInput: boolean;
}

/** Sessions grouped by working directory (sidebar "工作区"). */
export interface Workspace {
  cwd: string;
  /** basename of cwd, or cwd itself for "/" */
  label: string;
  /** newest first */
  sessions: SessionSummary[];
  /** ISO 8601, max(sessions.modified) */
  lastActive: string;
}

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface SessionStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: ContextUsage;
}

/** Slash-command palette entry. */
export interface CommandInfo {
  /** without the leading "/" */
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill" | "builtin";
}

/** Live state of a session. Sent in `snapshot` and `state` events and by GET state. */
export interface SessionState {
  id: string;
  cwd: string;
  sessionFile?: string;
  name?: string;
  model?: ModelRef;
  thinkingLevel: ThinkingLevel;
  availableThinkingLevels: ThinkingLevel[];
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  /** Queued while streaming */
  steering: string[];
  followUp: string[];
  activeTools: string[];
  stats: SessionStats;
  /** Extension status line items, `setStatus(key, text)` */
  statuses: Record<string, string>;
  /** Extension widgets with string[] content, `setWidget(key, lines)` */
  widgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  /** `setWorkingMessage` text while running, if any */
  workingMessage?: string;
  /** Extension dialogs not yet answered (oldest first) */
  pendingUi: ExtensionUiRequest[];
}

// ---------------------------------------------------------------- extension UI bridge

/**
 * Dialogs requested by extensions through `ctx.ui.*`. Answer with
 * `POST /api/sessions/:id/ui-response`. Whenever a request stops being pending —
 * answered by any client, timed out, or aborted — the server emits
 * `ui_request_cancelled` so every open client closes the dialog.
 */
export type ExtensionUiRequest =
  | { id: string; method: "select"; title: string; options: string[]; timeout?: number }
  | { id: string; method: "confirm"; title: string; message: string; timeout?: number }
  | { id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
  | { id: string; method: "editor"; title: string; prefill?: string; timeout?: number };

export type ExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

// ---------------------------------------------------------------- SSE events

/**
 * Events on `GET /api/sessions/:id/events`.
 *
 * The first frame after connecting is always `snapshot`. After that the stream
 * carries deltas. `message_update` carries the *whole* partial assistant message
 * (throttled server-side to ~20/s; the final partial is always flushed before
 * `message_end`), so the client simply replaces its streaming message.
 * A `: ping` comment line is sent every 15s.
 */
export type ServerEvent =
  | { type: "snapshot"; state: SessionState; transcript: TranscriptItem[]; streaming: AssistantMessage | null }
  | { type: "state"; state: SessionState }
  | { type: "agent_start" }
  /** The agent will not continue automatically. */
  | { type: "agent_settled"; aborted: boolean }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AssistantMessage }
  /** Authoritative completed message, already persisted with `entryId`. */
  | { type: "message_end"; message: AgentMessage; entryId: string | null }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  /** Streaming tool output (e.g. bash). `partial` is a ToolResultMessage-like `{ content, details }`. */
  | { type: "tool_update"; toolCallId: string; toolName: string; partial: { content: (TextContent | ImageContent)[]; details?: unknown } }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean; durationMs?: number }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "compaction_end"; reason: "manual" | "threshold" | "overflow"; aborted: boolean; errorMessage?: string }
  | { type: "retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "retry_end"; success: boolean }
  /** Session was renamed (by user or extension). */
  | { type: "session_name"; name: string | undefined }
  | { type: "ui_request"; request: ExtensionUiRequest }
  /** The request is no longer pending: answered (by any client), timed out, or aborted. Close its dialog. */
  | { type: "ui_request_cancelled"; id: string }
  | { type: "notify"; message: string; level: "info" | "warning" | "error" }
  /** The transcript changed in a way deltas can't express (compaction, tree nav, reload). Refetch. */
  | { type: "transcript_reset"; transcript: TranscriptItem[] }
  /** Server-side failure outside a request, e.g. a prompt that rejected after being accepted. */
  | { type: "error"; message: string }
  /** The live session was disposed (idle timeout / deleted). Client may reconnect to revive. */
  | { type: "closed" };

// ---------------------------------------------------------------- HTTP API

export interface ApiError {
  error: string;
}

/**
 * Routes (all JSON). `:id` is the pi session id.
 *
 * GET    /api/health                         -> { ok: true, version: string, piVersion: string }
 * GET    /api/auth/check                     -> 200 { authRequired: boolean } | 401
 * POST   /api/auth/login   {token}           -> 200 (sets cookie) | 401
 * POST   /api/auth/logout                    -> 200 (clears cookie)
 *
 * GET    /api/config                         -> ConfigResponse
 * GET    /api/workspaces                     -> { workspaces: Workspace[] }   (newest workspace first)
 * GET    /api/models[?sessionId=]            -> ModelsResponse
 * GET    /api/fs/list?path=                  -> FsListResponse  (directories only, for the cwd picker; path defaults to home)
 * GET    /api/fs/files?cwd=&q=               -> { files: string[] }  (relative paths for @-mention, max 50, git-ignored skipped)
 *
 * POST   /api/sessions     CreateSessionRequest  -> { state: SessionState }   (creates a persistent session file lazily, on first prompt)
 * GET    /api/sessions/:id                   -> { state: SessionState; transcript: TranscriptItem[] }  (revives the session if not live)
 * PATCH  /api/sessions/:id {name}            -> { state: SessionState }
 * DELETE /api/sessions/:id                   -> { ok: true }   (disposes if live, then deletes the .jsonl; 409 if running)
 * GET    /api/sessions/:id/events            -> SSE stream of ServerEvent
 * GET    /api/sessions/:id/commands          -> { commands: CommandInfo[] }
 *
 * POST   /api/sessions/:id/prompt   PromptRequest       -> { ok: true }  (returns once accepted, not when the run ends)
 * POST   /api/sessions/:id/abort                        -> { ok: true }
 * POST   /api/sessions/:id/model    ModelRef            -> { state }
 * POST   /api/sessions/:id/thinking {level}             -> { state }
 * POST   /api/sessions/:id/compact  {instructions?}     -> { ok: true }
 * POST   /api/sessions/:id/ui-response ExtensionUiResponse -> { ok: true }
 */
export interface ConfigResponse {
  /** Directory the server was started in / --cwd; default for new sessions */
  defaultCwd: string;
  home: string;
  version: string;
  piVersion: string;
  defaultModel?: ModelRef;
  defaultThinkingLevel: ThinkingLevel;
}

export interface ModelsResponse {
  models: ModelInfo[];
  defaultModel?: ModelRef;
}

export interface FsListResponse {
  path: string;
  parent: string | null;
  /** names only, sorted, hidden (dot) directories excluded */
  dirs: string[];
}

export interface CreateSessionRequest {
  cwd: string;
  model?: ModelRef;
  thinkingLevel?: ThinkingLevel;
}

export interface PromptRequest {
  text: string;
  images?: ImageContent[];
  /**
   * Only used while the session is streaming. "steer" interrupts after the
   * current tool calls; "followUp" waits for the run to finish. Defaults to
   * "followUp" when streaming.
   */
  behavior?: "steer" | "followUp";
}

// ================================================================ v2: workspace files & git

/**
 * Routes. `cwd` is an absolute workspace directory; every `path` is relative to
 * it ("" = the root) and must resolve (after symlinks) inside it, else 400.
 *
 * GET  /api/files/tree?cwd=&path=          -> FileTreeResponse   (one directory level; lazy)
 * GET  /api/files/read?cwd=&path=          -> FileReadResponse
 * GET  /api/files/raw?cwd=&path=           -> the file bytes with its Content-Type (images, downloads)
 *
 * GET  /api/git/status?cwd=                -> GitStatus
 * GET  /api/git/diff?cwd=&path=&staged=0|1 -> GitDiffResponse    (untracked files diff against /dev/null)
 * GET  /api/git/log?cwd=&limit=&all=0|1    -> { commits: GitCommit[] }   (limit default 30, max 200;
 *                                             all=1: every branch, remote and tag in topological order, for the graph)
 * POST /api/git/stage    { cwd, paths }    -> GitStatus
 * POST /api/git/unstage  { cwd, paths }    -> GitStatus
 * POST /api/git/commit   { cwd, message }  -> { commit: GitCommit; status: GitStatus }  (400 if nothing staged / empty message)
 * POST /api/git/pull     { cwd }           -> GitStatus   (fast-forward only; 400 when diverged)
 * POST /api/git/push     { cwd }           -> GitStatus   (sets the upstream on the first push of a branch)
 * POST /api/git/message  { cwd, sessionId? } -> { message: string }
 *      commit message for the staged diff (or all changes when nothing is staged), written by the
 *      session's model (the default model without a session) with thinking off
 */

export type FileEntryType = "file" | "dir" | "symlink";

export interface FileEntry {
  name: string;
  /** relative to cwd, "/"-separated */
  path: string;
  type: FileEntryType;
  /** bytes, files only */
  size?: number;
  /** matched by .gitignore (shown dimmed) */
  ignored: boolean;
  /** git change of this file, or for a dir: "modified" when anything inside changed */
  git?: GitChangeKind;
}

export interface FileTreeResponse {
  cwd: string;
  path: string;
  /** dirs first, then files; each group by name (localeCompare, numeric) */
  entries: FileEntry[];
}

export interface FileReadResponse {
  path: string;
  size: number;
  /** ISO 8601 */
  modified: string;
  /**
   * text: UTF-8 text (content in `text`, cut at 1 MiB with truncated=true)
   * image: render via /api/files/raw
   * binary: not shown
   */
  kind: "text" | "image" | "binary";
  text?: string;
  truncated?: boolean;
  /** highlight.js language id guessed from the extension, if any */
  language?: string;
  mimeType?: string;
}

export type GitChangeKind = "modified" | "added" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted" | "typechange";

export interface GitFileChange {
  path: string;
  /** rename/copy source */
  origPath?: string;
  /** change in the index (staged), if any */
  staged?: GitChangeKind;
  /** change in the worktree (unstaged), if any; "untracked" lives here */
  unstaged?: GitChangeKind;
}

export interface GitStatus {
  isRepo: boolean;
  /** repository top level (absolute) */
  root?: string;
  /** null when detached */
  branch?: string | null;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export interface GitDiffResponse {
  path: string;
  staged: boolean;
  /** unified diff text ("" when no change) */
  diff: string;
  binary: boolean;
  /** cut at 512 KiB */
  truncated: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  /** ISO 8601 */
  date: string;
  /** parent hashes (empty for a root commit) */
  parents?: string[];
  /** branches, remote branches and tags pointing at this commit */
  refs?: GitRef[];
}

export interface GitRef {
  name: string;
  /** "head": the checked-out branch (or "HEAD" when detached) */
  kind: "head" | "branch" | "remote" | "tag";
}

// ================================================================ v2: settings, models, resources

/**
 * Routes:
 * GET   /api/settings                         -> SettingsView
 * PATCH /api/settings   Partial<GeneralSettings> -> SettingsView   (writes ~/.pi/agent/settings.json)
 * GET   /api/settings/file                    -> { path: string; text: string }   (the raw settings.json, read-only view)
 *
 * GET   /api/providers                        -> ProvidersView
 * PUT   /api/providers/:id/key  { apiKey }    -> ProvidersView    (stores the key like `pi` /login does, in auth.json)
 * DELETE /api/providers/:id/key               -> ProvidersView    (logout)
 * PUT   /api/default-model  ModelRef & { thinkingLevel? } -> ProvidersView
 * PUT   /api/enabled-models { patterns: string[] | null } -> ProvidersView   (null = all models)
 *
 * GET   /api/models-config                    -> ModelsConfigView   (~/.pi/agent/models.json)
 * PUT   /api/models-config  { config }        -> ModelsConfigSaved  (400 with pi's message when the config does not load)
 * POST  /api/models-config/discover { config, provider } -> ModelDiscoveryResult
 *       lists the provider's models from its /models endpoint; auth, baseUrl and api resolve
 *       from the draft `config` exactly as pi would
 * POST  /api/models-config/test { config, provider, model } -> ModelTestResult
 *       one tiny request ("Reply with OK only.") through the draft config
 * GET   /api/models-catalog?model=&provider=&baseUrl= -> ModelCatalogMatch
 *       what models.dev knows about the model id (cached for an hour; 502 when unreachable)
 *
 * GET   /api/resources?cwd=                   -> ResourcesView
 * POST  /api/resources/toggle  ResourceToggleRequest -> ResourcesView
 * POST  /api/packages/install  { source, local?, cwd? } -> PackageOpResult   (waits; up to 10 min)
 * POST  /api/packages/remove   { source, local?, cwd? } -> PackageOpResult
 * POST  /api/packages/update   { source?, cwd? }        -> PackageOpResult
 *
 * POST  /api/sessions/:id/reload               -> { state: SessionState }   (re-reads extensions/skills/settings; 409 while running)
 * GET   /api/sessions/:id/export               -> the session .jsonl as a download
 *
 * GET   /api/stats?range=all|30d|7d            -> UsageStats
 * GET   /api/ui-state                          -> UiState
 * PUT   /api/ui-state  UiState                 -> UiState
 */

export interface GeneralSettings {
  defaultThinkingLevel: ThinkingLevel;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  compactionEnabled: boolean;
  retryEnabled: boolean;
  enableSkillCommands: boolean;
  hideThinkingBlock: boolean;
  /** pi `defaultTools`; undefined = pi default (read, bash, edit, write) */
  defaultTools?: string[];
  defaultProjectTrust: "ask" | "always" | "never";
}

export interface SettingsView {
  general: GeneralSettings;
  agentDir: string;
  settingsFile: string;
  piVersion: string;
}

export interface ProviderView {
  id: string;
  name: string;
  /** auth is configured (stored credential, env var or models.json key) */
  configured: boolean;
  /** where the credential comes from, when known */
  authSource?: "stored" | "env" | "config" | "oauth" | "none";
  /** supports storing an API key from the UI */
  supportsApiKey: boolean;
  /** has an OAuth login (done in the `pi` CLI for now) */
  supportsOAuth: boolean;
  /** environment variables pi reads for this provider's key */
  envVars: string[];
  models: ModelInfo[];
}

/** Per-million-token prices in USD. */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * models.json, typed for the fields the editor touches. Index signatures keep
 * everything else (tiers, inputLimits, samplingParams, …) intact on a round trip.
 */
/** A `modelOverrides` value: fields that replace a built-in model's (objects merge field by field). */
export interface ModelsJsonOverride {
  name?: string;
  reasoning?: boolean;
  /** provider value per thinking level; null = unsupported */
  thinkingLevelMap?: Record<string, string | null>;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<ModelCost> & Record<string, unknown>;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  [field: string]: unknown;
}

/** A `models` entry: adds a model to the provider (or replaces the one with that id). */
export interface ModelsJsonModel extends ModelsJsonOverride {
  id: string;
  api?: string;
  baseUrl?: string;
}

export interface ModelsJsonProvider {
  name?: string;
  baseUrl?: string;
  /** literal key, "$ENV_NAME" or "!command" */
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelsJsonModel[];
  modelOverrides?: Record<string, ModelsJsonOverride>;
  [field: string]: unknown;
}

export interface ModelsJson {
  providers?: Record<string, ModelsJsonProvider>;
  [field: string]: unknown;
}

export interface ModelsConfigView {
  /** absolute path of models.json */
  path: string;
  /** the parsed file ({} when it does not exist) */
  config: ModelsJson;
  /** set when the file is not valid JSON; `text` then holds it verbatim */
  error?: string;
  text?: string;
  /** provider ids pi knows without models.json; any other id is a custom provider */
  builtinProviders: string[];
}

export interface ModelsConfigSaved {
  config: ModelsConfigView;
  providers: ProvidersView;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface ModelDiscoveryResult {
  /** the URL that was listed */
  endpoint: string;
  models: DiscoveredModel[];
}

export interface ModelTestResult {
  ok: boolean;
  latencyMs?: number;
  /** the model's reply (first 300 chars) */
  text?: string;
  error?: string;
}

/** Model fields from models.dev, in the editor's terms. */
export interface CatalogPreset {
  name?: string;
  reasoning?: boolean;
  image?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** only when the price is reliable */
  cost?: ModelCost;
}

export type CatalogPrice =
  | {
      reliable: true;
      /** the same provider (by id or base URL host) listed it, or most listings agree */
      by: "provider" | "base-url" | "consensus";
      providerName?: string;
      /** listings with this price / listings with any price */
      support: number;
      total: number;
    }
  | {
      reliable: false;
      reason: "no-match" | "no-price" | "single" | "conflict";
      support: number;
      total: number;
    };

export interface ModelCatalogMatch {
  /** the catalog URL */
  source: string;
  /** catalog listings with exactly this model id (across providers) */
  matches: number;
  /** where the metadata came from */
  matchedBy: "provider" | "base-url" | "consensus" | "none";
  providerName?: string;
  preset: CatalogPreset;
  price: CatalogPrice;
}

export interface ProvidersView {
  providers: ProviderView[];
  defaultModel?: ModelRef;
  defaultThinkingLevel: ThinkingLevel;
  /** pi `enabledModels` patterns; null = all available models */
  enabledModels: string[] | null;
}

export type ResourceType = "extension" | "skill" | "prompt" | "theme";

export interface ResourceItem {
  type: ResourceType;
  /** stable id: absolute path (or "builtin:<name>") */
  id: string;
  name: string;
  description?: string;
  /** absolute path on disk, if any */
  path?: string;
  /** where it was found */
  origin: "builtin" | "package" | "user" | "project";
  /** package source string when origin === "package" */
  packageSource?: string;
  enabled: boolean;
}

export interface PackageView {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
  /** settings narrow which resources load */
  filtered: boolean;
  /** resources contributed by this package (counts by type) */
  counts: Partial<Record<ResourceType, number>>;
}

export interface ResourcesView {
  cwd: string;
  packages: PackageView[];
  items: ResourceItem[];
  /** non-fatal load errors */
  diagnostics: string[];
}

export interface ResourceToggleRequest {
  cwd?: string;
  type: ResourceType;
  id: string;
  enabled: boolean;
}

export interface PackageOpResult {
  ok: boolean;
  /** progress / npm output lines */
  log: string[];
  error?: string;
  resources: ResourcesView;
}

export interface UsageStats {
  range: "all" | "30d" | "7d";
  sessions: number;
  messages: number;
  tokens: number;
  activeDays: number;
  /** 0-23 local hour with most assistant messages, null if none */
  peakHour: number | null;
  /** "provider/model" used by most assistant messages */
  topModel: string | null;
  /** one entry per local day, oldest first, covering the last 26 weeks (182 days) regardless of range */
  daily: { date: string; tokens: number; messages: number }[];
}

export interface UiState {
  /** pinned session ids, in pin order */
  pinned: string[];
  /** archived session ids (hidden from the sidebar unless "已归档" filter) */
  archived: string[];
}
