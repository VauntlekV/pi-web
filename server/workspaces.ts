/**
 * The workspaces pi-web shows, persisted in ~/.pi/agent/pi-web/workspaces.json.
 * pi keeps every session of every directory in one store; pi-web lists only the
 * folders the user added (or started a session in from the web), so sessions
 * from unrelated projects stay out of the sidebar and the stats.
 */
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { writeFileAtomic } from "./settings/atomic.ts";

export interface StoredWorkspace {
  /** absolute path */
  cwd: string;
  /** ISO 8601 */
  added: string;
  /** hidden from the sidebar; its sessions stay on disk */
  archived?: boolean;
}

/** Comparable form of a directory path (resolved, no trailing separator). */
export function workspaceKey(cwd: string): string {
  const resolved = resolve(cwd);
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

export class WorkspaceStore {
  private entries: StoredWorkspace[] | undefined;
  /** Writes run one after another so concurrent requests cannot drop an entry. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string) {}

  async list(): Promise<StoredWorkspace[]> {
    if (this.entries) return this.entries;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const raw = typeof parsed === "object" && parsed !== null ? (parsed as { workspaces?: unknown }).workspaces : undefined;
      this.entries = Array.isArray(raw) ? raw.flatMap(validEntry) : [];
    } catch {
      // Missing or unreadable: no workspaces added yet.
      this.entries = [];
    }
    return this.entries;
  }

  /** Add `cwd`, or bring it back from the archive. */
  add(cwd: string): Promise<StoredWorkspace[]> {
    const key = workspaceKey(cwd);
    return this.update((entries) => {
      const existing = entries.find((entry) => entry.cwd === key);
      if (!existing) return [...entries, { cwd: key, added: new Date().toISOString() }];
      if (!existing.archived) return entries;
      return entries.map((entry) => (entry === existing ? { cwd: entry.cwd, added: entry.added } : entry));
    });
  }

  setArchived(cwd: string, archived: boolean): Promise<StoredWorkspace[]> {
    const key = workspaceKey(cwd);
    return this.update((entries) =>
      entries.map((entry) =>
        entry.cwd !== key ? entry : archived ? { ...entry, archived: true } : { cwd: entry.cwd, added: entry.added },
      ),
    );
  }

  remove(cwd: string): Promise<StoredWorkspace[]> {
    const key = workspaceKey(cwd);
    return this.update((entries) => entries.filter((entry) => entry.cwd !== key));
  }

  async has(cwd: string): Promise<boolean> {
    const key = workspaceKey(cwd);
    return (await this.list()).some((entry) => entry.cwd === key);
  }

  private update(change: (entries: StoredWorkspace[]) => StoredWorkspace[]): Promise<StoredWorkspace[]> {
    const run = this.queue.then(async () => {
      const before = await this.list();
      const next = change(before);
      if (next !== before) {
        writeFileAtomic(this.path, `${JSON.stringify({ workspaces: next }, null, 2)}\n`);
        this.entries = next;
      }
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function validEntry(value: unknown): StoredWorkspace[] {
  if (typeof value !== "object" || value === null) return [];
  const { cwd, added, archived } = value as Record<string, unknown>;
  if (typeof cwd !== "string" || (!cwd.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(cwd))) return [];
  return [
    {
      cwd: workspaceKey(cwd),
      added: typeof added === "string" ? added : new Date(0).toISOString(),
      ...(archived === true ? { archived: true } : {}),
    },
  ];
}

const stores = new Map<string, WorkspaceStore>();

/** One store per agent directory, shared by the routes and the stats. */
export function workspaceStore(agentDir: string): WorkspaceStore {
  const path = join(agentDir, "pi-web", "workspaces.json");
  let store = stores.get(path);
  if (!store) {
    store = new WorkspaceStore(path);
    stores.set(path, store);
  }
  return store;
}
