/**
 * Right dock (右侧栏) state and actions. Any directory may call the actions,
 * e.g. the transcript opens a file preview when a step's path is clicked.
 *
 * CONTRACT: used by the shell (toggle button, layout), the transcript (open
 * file / diff from a step) and the dock itself (rendering).
 *
 * Tabs are per workspace: switching to a session in another cwd swaps the tab
 * set (each cwd remembers its own tabs while the page lives). A fresh set is
 * the two top-bar tabs 文件 and Git; closing the last tab closes the dock and
 * the next open starts from that fresh set again.
 */
import { createStore, useStore } from "../app/store.ts";
import { readStorage, writeStorage } from "../app/storage.ts";

export type DockTab =
  | { kind: "files"; id: string }
  | { kind: "file"; id: string; path: string; line?: number }
  | { kind: "git"; id: string }
  | { kind: "diff"; id: string; path: string; staged: boolean };

/** A tab description without its id (the id is derived from kind + path). */
export type DockTabInput = DockTab extends infer T ? (T extends DockTab ? Omit<T, "id"> : never) : never;

export interface DockState {
  open: boolean;
  /** dock takes the whole main area (conversation hidden) */
  fullscreen: boolean;
  /** dock width in px (desktop), clamped 320 … 70% of the window */
  width: number;
  /** workspace the tabs belong to; null when no session/home cwd is known */
  cwd: string | null;
  tabs: DockTab[];
  activeId: string | null;
}

const WIDTH_KEY = "pi-web-dock-width";
const OPEN_KEY = "pi-web-dock-open";

const savedWidth = Number(readStorage(WIDTH_KEY));

/** The tab set a workspace starts with: 文件 and Git in the top bar, files first. */
export function defaultTabs(): DockTab[] {
  return [
    { kind: "files", id: "files" },
    { kind: "git", id: "git" },
  ];
}

export const dockStore = createStore<DockState>({
  open: readStorage(OPEN_KEY) === "1",
  fullscreen: false,
  width: Number.isFinite(savedWidth) && savedWidth >= 320 ? savedWidth : 560,
  cwd: null,
  tabs: defaultTabs(),
  activeId: "files",
});

/** Tab sets of other workspaces, restored when their cwd becomes current again. */
const parked = new Map<string, { tabs: DockTab[]; activeId: string | null }>();

export function useDock(): DockState {
  return useStore(dockStore);
}

function tabId(tab: DockTabInput): string {
  switch (tab.kind) {
    case "files":
    case "git":
      return tab.kind;
    case "file":
      return `file:${tab.path}`;
    case "diff":
      return `diff:${tab.staged ? "staged" : "worktree"}:${tab.path}`;
  }
}

function persistOpen(open: boolean): void {
  writeStorage(OPEN_KEY, open ? "1" : "0");
}

/** Show the given tab (adding it if missing) and open the dock. */
function show(tab: DockTabInput): void {
  const id = tabId(tab);
  dockStore.set((prev) => {
    const existing = prev.tabs.find((t) => t.id === id);
    const nextTab = { ...tab, id } as DockTab;
    const tabs = existing ? prev.tabs.map((t) => (t.id === id ? nextTab : t)) : [...prev.tabs, nextTab];
    return { ...prev, open: true, tabs, activeId: id };
  });
  persistOpen(true);
}

export const dock = {
  /** Bind the dock to a workspace (call when the current session/home cwd changes). */
  setCwd(cwd: string | null): void {
    const prev = dockStore.get();
    if (prev.cwd === cwd) return;
    if (prev.cwd) parked.set(prev.cwd, { tabs: prev.tabs, activeId: prev.activeId });
    const restored = cwd ? parked.get(cwd) : undefined;
    dockStore.set({ ...prev, cwd, tabs: restored?.tabs ?? defaultTabs(), activeId: restored ? restored.activeId : "files" });
  },
  open(): void {
    dockStore.set((prev) => {
      if (prev.tabs.length > 0) return { ...prev, open: true };
      return { ...prev, open: true, tabs: defaultTabs(), activeId: "files" };
    });
    persistOpen(true);
  },
  close(): void {
    dockStore.set((prev) => ({ ...prev, open: false, fullscreen: false }));
    persistOpen(false);
  },
  toggle(): void {
    if (dockStore.get().open) dock.close();
    else dock.open();
  },
  setFullscreen(fullscreen: boolean): void {
    dockStore.set((prev) => ({ ...prev, fullscreen, open: fullscreen ? true : prev.open }));
  },
  setWidth(width: number): void {
    const max = Math.max(320, Math.round(window.innerWidth * 0.7));
    const clamped = Math.min(max, Math.max(320, Math.round(width)));
    dockStore.set((prev) => ({ ...prev, width: clamped }));
    writeStorage(WIDTH_KEY, String(clamped));
  },
  openFiles(): void {
    show({ kind: "files" });
  },
  openGit(): void {
    show({ kind: "git" });
  },
  /** path is relative to the dock cwd (absolute paths under it are accepted and relativized by the caller) */
  openFile(path: string, line?: number): void {
    show({ kind: "file", path, line });
  },
  openDiff(path: string, staged: boolean): void {
    show({ kind: "diff", path, staged });
  },
  activate(id: string): void {
    dockStore.set((prev) => (prev.tabs.some((t) => t.id === id) ? { ...prev, activeId: id } : prev));
  },
  closeTab(id: string): void {
    const prev = dockStore.get();
    if (prev.tabs.length === 1 && prev.tabs[0]?.id === id) {
      dockStore.set({ ...prev, open: false, fullscreen: false, tabs: defaultTabs(), activeId: "files" });
      persistOpen(false);
      return;
    }
    dockStore.set((prev) => {
      const index = prev.tabs.findIndex((t) => t.id === id);
      if (index < 0) return prev;
      const tabs = prev.tabs.filter((t) => t.id !== id);
      const activeId =
        prev.activeId === id ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : prev.activeId;
      return { ...prev, tabs, activeId };
    });
  },
};
