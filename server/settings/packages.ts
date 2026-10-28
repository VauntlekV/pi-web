import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PackageOpResult } from "../../shared/protocol.ts";
import type { AppDeps } from "../app.ts";
import { HttpError } from "../http-error.ts";
import { readResources } from "./resources.ts";

const OP_TIMEOUT_MS = 10 * 60_000;
const MAX_SOURCE_LENGTH = 500;

export type PackageCommand = "install" | "remove" | "update";

let packageOpRunning = false;

/**
 * The single package-operation slot. Another holder gets a 409, so two npm/git operations
 * never rewrite settings.json at the same time.
 */
export function acquirePackageLock(): () => void {
  if (packageOpRunning) throw new HttpError(409, "已有包操作进行中");
  packageOpRunning = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    packageOpRunning = false;
  };
}

export async function runPackageCommand(
  deps: AppDeps,
  command: PackageCommand,
  body: Record<string, unknown>,
): Promise<PackageOpResult> {
  const source = parseSource(body.source, command !== "update");
  if (body.local !== undefined && typeof body.local !== "boolean") throw new HttpError(400, "local 必须是布尔值");
  const local = body.local === true;
  if (local && (typeof body.cwd !== "string" || body.cwd.trim() === "")) {
    throw new HttpError(400, "local 操作需要提供 cwd");
  }
  const cwd = resolveCwd(deps, body.cwd);

  // Validate everything before taking the slot so a bad request stays a 400 even while busy.
  const release = acquirePackageLock();
  const manager = new DefaultPackageManager({
    cwd,
    agentDir: deps.agentDir,
    settingsManager: SettingsManager.create(cwd, deps.agentDir),
  });
  const log: string[] = [];
  manager.setProgressCallback((event) => {
    log.push(event.message ?? `${event.action}: ${event.source}`);
  });

  const operation = command === "install"
    ? manager.installAndPersist(source as string, { local })
    : command === "remove"
      ? manager.removeAndPersist(source as string, { local }).then(() => undefined)
      : manager.update(source);

  let timedOut = false;
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout("timeout"), OP_TIMEOUT_MS);
    timer.unref?.();
  });
  const settled = operation.then(() => "ok" as const);

  try {
    const outcome = await Promise.race([settled, timeout]);
    if (outcome === "timeout") {
      timedOut = true;
      return { ok: false, error: "包操作超时", log, resources: await readResources(deps, cwd) };
    }
    return { ok: true, log, resources: await readResources(deps, cwd) };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      log,
      resources: await readResources(deps, cwd),
    };
  } finally {
    manager.setProgressCallback(undefined);
    // A timed-out operation keeps running; hold the slot until it settles.
    if (timedOut) void settled.catch(() => {}).finally(release);
    else release();
  }
}

function parseSource(value: unknown, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new HttpError(400, "缺少 source");
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, "source 必须是字符串");
  const source = value.trim();
  if (source.length < 1 || source.length > MAX_SOURCE_LENGTH) {
    throw new HttpError(400, `source 长度必须在 1 到 ${MAX_SOURCE_LENGTH} 之间`);
  }
  if (/[\r\n]/.test(source)) throw new HttpError(400, "source 不能包含换行");
  return source;
}

function resolveCwd(deps: AppDeps, value: unknown): string {
  if (value !== undefined && typeof value !== "string") throw new HttpError(400, "cwd 必须是字符串");
  const requested = (typeof value === "string" ? value.trim() : "") || deps.defaultCwd;
  const cwd = isAbsolute(requested) ? requested : resolve(deps.defaultCwd, requested);
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new HttpError(400, "目录不存在");
  }
  return cwd;
}
