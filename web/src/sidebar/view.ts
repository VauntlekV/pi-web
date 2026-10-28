/**
 * Sidebar view helpers: the persisted sort/filter choice, session titles and
 * the flat search results shown while the search box has text.
 */
import type { SessionSummary, Workspace } from "../../../shared/protocol.ts";
import { firstLine } from "../app/text.ts";

export interface SidebarView {
  sort: "recent" | "name";
  show: "active" | "archived";
}

export const DEFAULT_SIDEBAR_VIEW: SidebarView = { sort: "recent", show: "active" };

export function parseSidebarView(raw: string | null): SidebarView {
  if (!raw) return DEFAULT_SIDEBAR_VIEW;
  try {
    const value = JSON.parse(raw) as Partial<SidebarView> | null;
    if (!value || typeof value !== "object") return DEFAULT_SIDEBAR_VIEW;
    return {
      sort: value.sort === "name" ? "name" : "recent",
      show: value.show === "archived" ? "archived" : "active",
    };
  } catch {
    return DEFAULT_SIDEBAR_VIEW;
  }
}

/** Title shown for a session row (its name, else the first line of message one). */
export function sessionTitle(session: SessionSummary): string {
  return session.name?.trim() || firstLine(session.firstMessage, 60) || "新会话";
}

export interface SessionHit {
  session: SessionSummary;
  workspace: Workspace;
}

/** Case-insensitive substring match on the title or the first message; flat. */
export function searchSessions(workspaces: Workspace[], query: string): SessionHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: SessionHit[] = [];
  for (const workspace of workspaces) {
    for (const session of workspace.sessions) {
      if (sessionTitle(session).toLowerCase().includes(q) || session.firstMessage.toLowerCase().includes(q)) {
        hits.push({ session, workspace });
      }
    }
  }
  return hits;
}

/** 进行中 (everything not archived) or 已归档, per the view choice. */
export function filterByView(sessions: SessionSummary[], archived: string[], view: SidebarView): SessionSummary[] {
  return sessions.filter((session) => archived.includes(session.id) === (view.show === "archived"));
}

/** Newest-active order comes from the server; "name" sorts titles. */
export function sortSessions(sessions: SessionSummary[], view: SidebarView): SessionSummary[] {
  if (view.sort !== "name") return sessions;
  return [...sessions].sort((a, b) => sessionTitle(a).localeCompare(sessionTitle(b), "zh"));
}

export interface WorkspaceGroup {
  workspace: Workspace;
  sessions: SessionSummary[];
}

/**
 * The workspace groups a view shows. 进行中: workspaces that are not archived,
 * each with its unarchived sessions (empty ones too, so a freshly added folder
 * is visible). 已归档: archived workspaces with all their sessions, plus other
 * workspaces that hold archived sessions.
 */
export function visibleGroups(workspaces: Workspace[], archived: string[], view: SidebarView): WorkspaceGroup[] {
  const groups: WorkspaceGroup[] = [];
  for (const workspace of workspaces) {
    if (view.show === "active") {
      if (!workspace.archived) groups.push({ workspace, sessions: sortSessions(filterByView(workspace.sessions, archived, view), view) });
    } else if (workspace.archived) {
      groups.push({ workspace, sessions: sortSessions(workspace.sessions, view) });
    } else {
      const sessions = filterByView(workspace.sessions, archived, view);
      if (sessions.length > 0) groups.push({ workspace, sessions: sortSessions(sessions, view) });
    }
  }
  return groups;
}
