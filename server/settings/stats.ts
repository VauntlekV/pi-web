import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UsageStats } from "../../shared/protocol.ts";
import type { AppDeps } from "../app.ts";
import { HttpError } from "../http-error.ts";
import { workspaceKey, workspaceStore } from "../workspaces.ts";

const RANGES: UsageStats["range"][] = ["all", "30d", "7d"];
const DAILY_DAYS = 182;
const RESULT_TTL_MS = 2000;

interface DayBucket {
  tokens: number;
  messages: number;
  /** Assistant messages per local hour. */
  hours: number[];
  /** Assistant messages per "provider/model". */
  models: Map<string, number>;
}

interface FileStats {
  mtimeMs: number;
  size: number;
  /** the session's working directory (from its header line) */
  cwd?: string;
  days: Map<string, DayBucket>;
}

// Parse results keyed by path; a file is re-read only when its (mtime, size) changes.
const cache = new Map<string, FileStats>();
// Whole stats per (session dir, range); the walk and aggregation are skipped for a couple of seconds.
const resultCache = new Map<string, { at: number; value: UsageStats }>();

/** Seam for tests: a cached request must not read session files again. */
export const statsIo = { readFile, stat };

export async function readUsageStats(deps: AppDeps, rangeParam: string | undefined): Promise<UsageStats> {
  const range = (rangeParam ?? "all") as UsageStats["range"];
  if (!RANGES.includes(range)) throw new HttpError(400, "range 必须是 all、30d 或 7d");

  const sessionDir = deps.registry.sessionDir ?? join(deps.agentDir, "sessions");
  // Only the workspaces pi-web lists count, like the sidebar.
  const workspaces = new Set((await workspaceStore(deps.agentDir).list()).map((entry) => entry.cwd));
  const resultKey = `${sessionDir}\0${range}\0${[...workspaces].join("\0")}`;
  const cached = resultCache.get(resultKey);
  if (cached && Date.now() - cached.at < RESULT_TTL_MS) return cached.value;

  const paths = await sessionFiles(sessionDir, deps.registry.sessionDir !== undefined);

  const files: FileStats[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    seen.add(path);
    try {
      const stats = await statsForFile(path);
      if (stats.cwd !== undefined && workspaces.has(workspaceKey(stats.cwd))) files.push(stats);
    } catch {
      // A session file that vanished or cannot be read is skipped, like a bad line.
    }
  }
  for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);

  const today = new Date();
  const todayKey = dayKey(today);
  const windowStart = dayKey(addDays(today, -(DAILY_DAYS - 1)));
  const cutoff = range === "all" ? undefined : dayKey(addDays(today, range === "7d" ? -6 : -29));

  let sessions = 0;
  let messages = 0;
  let tokens = 0;
  const activeDays = new Set<string>();
  const hours = new Array<number>(24).fill(0);
  const models = new Map<string, number>();
  const daily = new Map<string, { tokens: number; messages: number }>();

  for (const file of files) {
    let inRange = false;
    for (const [day, bucket] of file.days) {
      if (cutoff === undefined || day >= cutoff) {
        inRange = true;
        messages += bucket.messages;
        tokens += bucket.tokens;
        activeDays.add(day);
        for (let hour = 0; hour < 24; hour += 1) hours[hour] += bucket.hours[hour];
        for (const [model, count] of bucket.models) models.set(model, (models.get(model) ?? 0) + count);
      }
      if (day >= windowStart && day <= todayKey) {
        const entry = daily.get(day) ?? { tokens: 0, messages: 0 };
        entry.tokens += bucket.tokens;
        entry.messages += bucket.messages;
        daily.set(day, entry);
      }
    }
    if (inRange) sessions += 1;
  }

  const dailyEntries: UsageStats["daily"] = [];
  for (let offset = DAILY_DAYS - 1; offset >= 0; offset -= 1) {
    const date = dayKey(addDays(today, -offset));
    const entry = daily.get(date);
    dailyEntries.push({ date, tokens: entry?.tokens ?? 0, messages: entry?.messages ?? 0 });
  }

  const value: UsageStats = {
    range,
    sessions,
    messages,
    tokens,
    activeDays: activeDays.size,
    peakHour: peakHour(hours),
    topModel: topModel(models),
    daily: dailyEntries,
  };
  resultCache.set(resultKey, { at: Date.now(), value });
  return value;
}

/** Same layout as SessionManager: a custom session dir is flat, the default one holds per-cwd folders. */
async function sessionFiles(dir: string, flat: boolean): Promise<string[]> {
  try {
    if (flat) {
      return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
    }
    const files: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        for (const name of await readdir(join(dir, entry.name))) {
          if (name.endsWith(".jsonl")) files.push(join(dir, entry.name, name));
        }
      } catch {
        // An unreadable session folder is skipped.
      }
    }
    return files;
  } catch {
    return [];
  }
}

async function statsForFile(path: string): Promise<FileStats> {
  const info = await statsIo.stat(path);
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached;

  const text = await statsIo.readFile(path, "utf8");
  const stats: FileStats = { mtimeMs: info.mtimeMs, size: info.size, cwd: headerCwd(text), days: parseSessionText(text) };
  cache.set(path, stats);
  return stats;
}

/** The `cwd` of the session header (the first line). */
function headerCwd(text: string): string | undefined {
  const end = text.indexOf("\n");
  try {
    const header: unknown = JSON.parse(end === -1 ? text : text.slice(0, end));
    return isRecord(header) && header.type === "session" && typeof header.cwd === "string" ? header.cwd : undefined;
  } catch {
    return undefined;
  }
}

/** Count user/assistant messages per local day; bad lines are skipped silently. */
function parseSessionText(text: string): Map<string, DayBucket> {
  const days = new Map<string, DayBucket>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message)) continue;
    const role = message.role;
    if (role !== "user" && role !== "assistant") continue;
    const timestamp = typeof entry.timestamp === "string" ? new Date(entry.timestamp) : undefined;
    if (!timestamp || Number.isNaN(timestamp.getTime())) continue;

    const date = dayKey(timestamp);
    let bucket = days.get(date);
    if (!bucket) {
      bucket = { tokens: 0, messages: 0, hours: new Array<number>(24).fill(0), models: new Map() };
      days.set(date, bucket);
    }
    bucket.messages += 1;
    if (role !== "assistant") continue;

    const usage = message.usage;
    if (isRecord(usage) && typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
      bucket.tokens += usage.totalTokens;
    }
    bucket.hours[timestamp.getHours()] += 1;
    if (typeof message.provider === "string" && typeof message.model === "string") {
      const model = `${message.provider}/${message.model}`;
      bucket.models.set(model, (bucket.models.get(model) ?? 0) + 1);
    }
  }
  return days;
}

function peakHour(hours: number[]): number | null {
  let best: number | null = null;
  for (let hour = 0; hour < hours.length; hour += 1) {
    if (hours[hour] === 0) continue;
    if (best === null || hours[hour] > hours[best]) best = hour;
  }
  return best;
}

function topModel(models: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [model, count] of models) {
    if (count > bestCount || (count === bestCount && best !== null && model < best)) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

/** Local (not UTC) YYYY-MM-DD, so days and hours match the user's clock. */
function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
