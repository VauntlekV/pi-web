import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Write a file through a temp file + rename so a reader never sees half of it.
 * `mode` applies to the new file (0600 keeps settings and state private).
 */
export function writeFileAtomic(path: string, content: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { encoding: "utf8", mode, flush: true });
    renameSync(temp, path);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Already renamed (or never created).
    }
  }
}
