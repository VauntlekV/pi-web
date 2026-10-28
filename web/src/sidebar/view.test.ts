import { describe, expect, it } from "vitest";
import type { SessionSummary, Workspace } from "../../../shared/protocol.ts";
import {
  DEFAULT_SIDEBAR_VIEW,
  filterByView,
  parseSidebarView,
  searchSessions,
  sessionTitle,
  sortSessions,
} from "./view.ts";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1",
    path: "/tmp/s1.jsonl",
    cwd: "/work/alpha",
    firstMessage: "",
    messageCount: 0,
    created: "2025-01-01T00:00:00.000Z",
    modified: "2025-01-01T00:00:00.000Z",
    live: false,
    running: false,
    awaitingInput: false,
    ...overrides,
  };
}

function workspace(cwd: string, label: string, sessions: SessionSummary[]): Workspace {
  return { cwd, label, sessions, lastActive: "2025-01-01T00:00:00.000Z" };
}

describe("parseSidebarView", () => {
  it("defaults when nothing is stored", () => {
    expect(parseSidebarView(null)).toEqual(DEFAULT_SIDEBAR_VIEW);
  });

  it("reads a stored choice", () => {
    expect(parseSidebarView('{"sort":"name","show":"archived"}')).toEqual({ sort: "name", show: "archived" });
  });

  it("falls back on junk and unknown values", () => {
    expect(parseSidebarView("nope")).toEqual(DEFAULT_SIDEBAR_VIEW);
    expect(parseSidebarView('{"sort":"x","show":"y"}')).toEqual(DEFAULT_SIDEBAR_VIEW);
  });
});

describe("searchSessions", () => {
  const alpha = workspace("/work/alpha", "alpha", [
    session({ id: "a1", name: "Fix Login flow", firstMessage: "x" }),
    session({ id: "a2", firstMessage: "Refactor the sidebar\nsecond line" }),
  ]);
  const beta = workspace("/work/beta", "beta", [session({ id: "b1", name: "Notes", firstMessage: "login page" })]);

  it("returns nothing for an empty query", () => {
    expect(searchSessions([alpha, beta], "  ")).toEqual([]);
  });

  it("matches the title case-insensitively", () => {
    const hits = searchSessions([alpha, beta], "fix login");
    expect(hits.map((hit) => hit.session.id)).toEqual(["a1"]);
    expect(hits[0]?.workspace.label).toBe("alpha");
  });

  it("matches a substring of the first message, across workspaces", () => {
    const hits = searchSessions([alpha, beta], "LOGIN");
    expect(hits.map((hit) => hit.session.id)).toEqual(["a1", "b1"]);
    expect(hits.map((hit) => hit.workspace.label)).toEqual(["alpha", "beta"]);
  });

  it("uses the first message line when there is no name", () => {
    expect(sessionTitle(alpha.sessions[1]!)).toBe("Refactor the sidebar");
    expect(searchSessions([alpha], "sidebar").map((hit) => hit.session.id)).toEqual(["a2"]);
  });
});

describe("view filters", () => {
  const sessions = [session({ id: "a", name: "b" }), session({ id: "b", name: "a" })];
  const archived = ["b"];

  it("shows only active sessions by default", () => {
    expect(filterByView(sessions, archived, DEFAULT_SIDEBAR_VIEW).map((s) => s.id)).toEqual(["a"]);
  });

  it("shows only archived sessions when asked", () => {
    expect(filterByView(sessions, archived, { sort: "recent", show: "archived" }).map((s) => s.id)).toEqual(["b"]);
  });

  it("sorts by title when asked", () => {
    expect(sortSessions(sessions, { sort: "name", show: "active" }).map((s) => s.id)).toEqual(["b", "a"]);
    expect(sortSessions(sessions, DEFAULT_SIDEBAR_VIEW).map((s) => s.id)).toEqual(["a", "b"]);
  });
});
