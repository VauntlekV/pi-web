import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import type { GeneralSettings, SettingsView, ThinkingLevel } from "../../shared/protocol.ts";
import type { AppDeps } from "../app.ts";
import { HttpError } from "../http-error.ts";
import { writeFileAtomic } from "./atomic.ts";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const QUEUE_MODES = ["all", "one-at-a-time"];
const PROJECT_TRUST = ["ask", "always", "never"];
const TOOL_ENTRY = /^[+-]?[a-z0-9_:-]+$/;

const GENERAL_FIELDS = new Set([
  "defaultThinkingLevel",
  "steeringMode",
  "followUpMode",
  "compactionEnabled",
  "retryEnabled",
  "enableSkillCommands",
  "hideThinkingBlock",
  "defaultTools",
  "defaultProjectTrust",
]);

/** A fresh manager per request, so the view always reflects the files on disk. */
export function settingsManagerFor(deps: AppDeps): SettingsManager {
  return SettingsManager.create(deps.defaultCwd, deps.agentDir);
}

export function settingsFilePath(deps: AppDeps): string {
  return join(deps.agentDir, "settings.json");
}

export function readSettingsView(deps: AppDeps): SettingsView {
  const manager = settingsManagerFor(deps);
  const defaultTools = manager.getDefaultTools();
  const general: GeneralSettings = {
    defaultThinkingLevel: (manager.getDefaultThinkingLevel() ?? "medium") as ThinkingLevel,
    steeringMode: manager.getSteeringMode(),
    followUpMode: manager.getFollowUpMode(),
    compactionEnabled: manager.getCompactionEnabled(),
    retryEnabled: manager.getRetryEnabled(),
    enableSkillCommands: manager.getEnableSkillCommands(),
    hideThinkingBlock: manager.getHideThinkingBlock(),
    ...(defaultTools === undefined ? {} : { defaultTools }),
    defaultProjectTrust: manager.getDefaultProjectTrust(),
  };
  return {
    general,
    agentDir: deps.agentDir,
    settingsFile: settingsFilePath(deps),
    piVersion: deps.piVersion ?? VERSION,
  };
}

/** `{}` when settings.json does not exist yet, as the protocol documents. */
export function readSettingsFile(deps: AppDeps): { path: string; text: string } {
  const path = settingsFilePath(deps);
  try {
    return { path, text: readFileSync(path, "utf8") };
  } catch {
    return { path, text: "{}\n" };
  }
}

/** Validate and apply a PATCH body; writes only the user (agentDir) scope. */
export async function patchSettings(deps: AppDeps, body: Record<string, unknown>): Promise<SettingsView> {
  const unknown = Object.keys(body).filter((key) => !GENERAL_FIELDS.has(key));
  if (unknown.length > 0) throw new HttpError(400, `不支持的设置字段: ${unknown.join(", ")}`);

  // Validate everything before writing, so an invalid field cannot half-apply the request.
  const thinking = "defaultThinkingLevel" in body ? asThinkingLevel(body.defaultThinkingLevel) : undefined;
  const steering = "steeringMode" in body ? asMode(body.steeringMode, "steeringMode") : undefined;
  const followUp = "followUpMode" in body ? asMode(body.followUpMode, "followUpMode") : undefined;
  const compaction = "compactionEnabled" in body ? asBoolean(body.compactionEnabled, "compactionEnabled") : undefined;
  const retry = "retryEnabled" in body ? asBoolean(body.retryEnabled, "retryEnabled") : undefined;
  const skillCommands = "enableSkillCommands" in body
    ? asBoolean(body.enableSkillCommands, "enableSkillCommands")
    : undefined;
  const hideThinking = "hideThinkingBlock" in body ? asBoolean(body.hideThinkingBlock, "hideThinkingBlock") : undefined;
  const trust = "defaultProjectTrust" in body ? asProjectTrust(body.defaultProjectTrust) : undefined;
  const defaultTools = "defaultTools" in body ? parseDefaultTools(body.defaultTools) : undefined;

  const manager = settingsManagerFor(deps);
  if (thinking !== undefined) manager.setDefaultThinkingLevel(thinking);
  if (steering !== undefined) manager.setSteeringMode(steering);
  if (followUp !== undefined) manager.setFollowUpMode(followUp);
  if (compaction !== undefined) manager.setCompactionEnabled(compaction);
  if (retry !== undefined) manager.setRetryEnabled(retry);
  if (skillCommands !== undefined) manager.setEnableSkillCommands(skillCommands);
  if (hideThinking !== undefined) manager.setHideThinkingBlock(hideThinking);
  if (trust !== undefined) manager.setDefaultProjectTrust(trust);

  // Setters write asynchronously; flush before the raw read-modify-write below.
  await manager.flush();
  if (defaultTools !== undefined) writeDefaultTools(deps, defaultTools);

  return readSettingsView(deps);
}

// -------------------------------------------------------------------- helpers

function asThinkingLevel(value: unknown): ThinkingLevel {
  if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
    throw new HttpError(400, `未知 thinking level: ${String(value)}`);
  }
  return value as ThinkingLevel;
}

function asMode(value: unknown, field: string): "all" | "one-at-a-time" {
  if (typeof value !== "string" || !QUEUE_MODES.includes(value)) {
    throw new HttpError(400, `${field} 必须是 all 或 one-at-a-time`);
  }
  return value as "all" | "one-at-a-time";
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `${field} 必须是布尔值`);
  return value;
}

function asProjectTrust(value: unknown): GeneralSettings["defaultProjectTrust"] {
  if (typeof value !== "string" || !PROJECT_TRUST.includes(value)) {
    throw new HttpError(400, "defaultProjectTrust 必须是 ask、always 或 never");
  }
  return value as GeneralSettings["defaultProjectTrust"];
}

/** `undefined` = field absent, `null` = delete the setting, otherwise the validated list. */
function parseDefaultTools(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new HttpError(400, "defaultTools 必须是字符串数组或 null");
  if (value.length > 500) throw new HttpError(400, "defaultTools 最多 500 项");
  return value.map((entry) => {
    if (typeof entry !== "string" || !TOOL_ENTRY.test(entry) || entry.length > 200) {
      throw new HttpError(400, `非法工具名: ${String(entry)}`);
    }
    return entry;
  });
}

/**
 * `defaultTools` has no SettingsManager setter, so merge it into settings.json directly.
 * Flushing first keeps the other setters' changes from being overwritten.
 * shortcut: no cross-process lock on this read-modify-write, add one if a second writer appears.
 */
function writeDefaultTools(deps: AppDeps, value: string[] | null): void {
  const path = settingsFilePath(deps);
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new HttpError(500, "settings.json 解析失败，未写入 defaultTools");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(500, "settings.json 必须是 JSON 对象，未写入 defaultTools");
    }
    settings = parsed as Record<string, unknown>;
  }
  if (value === null) delete settings.defaultTools;
  else settings.defaultTools = value;
  writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
}
