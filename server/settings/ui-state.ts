import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { UiState } from "../../shared/protocol.ts";
import { HttpError } from "../http-error.ts";
import { writeFileAtomic } from "./atomic.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_IDS = 2000;

export function uiStatePath(agentDir: string): string {
  return join(agentDir, "pi-web", "ui-state.json");
}

export async function readUiState(agentDir: string): Promise<UiState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(uiStatePath(agentDir), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { pinned: [], archived: [] };
    const record = parsed as Record<string, unknown>;
    return { pinned: validIds(record.pinned), archived: validIds(record.archived) };
  } catch {
    // Missing (or unreadable) state means nothing is pinned or archived.
    return { pinned: [], archived: [] };
  }
}

/** Validate a PUT body; 400 for anything the UI could not have produced. */
export function parseUiState(body: Record<string, unknown>): UiState {
  return {
    pinned: parseIdList(body.pinned, "pinned"),
    archived: parseIdList(body.archived, "archived"),
  };
}

export async function saveUiState(agentDir: string, state: UiState): Promise<UiState> {
  writeFileAtomic(uiStatePath(agentDir), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

function parseIdList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${field} 必须是数组`);
  if (value.length > MAX_IDS) throw new HttpError(400, `${field} 最多 ${MAX_IDS} 项`);
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      throw new HttpError(400, `${field} 包含非法会话 id`);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function validIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id === "string" && ID_PATTERN.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(0, MAX_IDS);
}
