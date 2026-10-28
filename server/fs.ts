import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FsListResponse } from "../shared/protocol.ts";
import { HttpError } from "./http-error.ts";

const MAX_WALK_FILES = 5000;
const MAX_FILES_RETURNED = 50;

function requireDirectory(path: string, status: number, message: string): void {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    throw new HttpError(status, message);
  }
  if (!stats.isDirectory()) throw new HttpError(status, message);
}

/** Directories only, hidden ones dropped, for the cwd picker. */
export function listDirectories(input?: string): FsListResponse {
  const requested = input?.trim() ? input.trim() : homedir();
  if (!isAbsolute(requested)) throw new HttpError(400, "路径必须是绝对路径");
  const path = resolve(requested);
  requireDirectory(path, 404, "目录不存在");

  const dirs = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const parentPath = dirname(path);
  return { path, parent: parentPath === path ? null : parentPath, dirs };
}

function gitLsFiles(cwd: string): Promise<string[]> {
  return new Promise((resolveFiles, reject) => {
    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd, timeout: 3000, maxBuffer: 20 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveFiles(stdout.split("\n").filter((line) => line.length > 0));
      },
    );
  });
}

function walkFiles(dir: string, out: string[], prefix = ""): void {
  if (out.length >= MAX_WALK_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_WALK_FILES) return;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      walkFiles(join(dir, entry.name), out, relative);
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
}

/** Relative paths for @-completion; git-aware, filtered, shortest 50 first. */
export async function listFiles(cwd: string, query?: string): Promise<string[]> {
  if (!cwd?.trim()) throw new HttpError(400, "cwd 不能为空");
  const root = resolve(cwd.trim());
  requireDirectory(root, 400, "cwd 必须是目录");

  let files: string[];
  try {
    files = await gitLsFiles(root);
  } catch {
    files = [];
    walkFiles(root, files);
  }

  const needle = (query ?? "").trim().toLowerCase();
  const matched = needle ? files.filter((file) => file.toLowerCase().includes(needle)) : files;
  matched.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return matched.slice(0, MAX_FILES_RETURNED);
}
