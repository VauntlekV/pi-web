import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { ServerEvent, SessionState, Workspace } from "../shared/protocol.ts";
import { createHarness, waitFor, type Harness } from "./testing.ts";
import { WorkspaceStore, workspaceStore } from "./workspaces.ts";

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness({ noAuth: true });
});

afterEach(async () => {
  await harness.close();
});

const call = (method: string, path: string, body?: unknown) =>
  harness.app.request(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });

const workspaces = async () => ((await (await call("GET", "/api/workspaces")).json()) as { workspaces: Workspace[] }).workspaces;

/** A session with one finished turn, so it is on disk. */
async function sessionWithTurn(cwd: string) {
  const live = await harness.registry.create({ cwd });
  const events: ServerEvent[] = [];
  live.addClient((event) => events.push(event));
  harness.faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await live.prompt({ text: "hello" });
  await waitFor(() => events.some((event) => event.type === "agent_settled"));
  return live;
}

describe("workspaces", () => {
  it("lists no local sessions until their folder is added", async () => {
    await sessionWithTurn(harness.cwd);
    expect(await workspaces()).toEqual([]);

    const added = (await (await call("POST", "/api/workspaces", { cwd: harness.cwd })).json()) as { workspaces: Workspace[] };
    expect(added.workspaces).toHaveLength(1);
    expect(added.workspaces[0]).toMatchObject({ cwd: harness.cwd, sessions: [expect.objectContaining({ cwd: harness.cwd })] });
  });

  it("lists an added folder without sessions and rejects paths that are not directories", async () => {
    const empty = await mkdtemp(join(tmpdir(), "pi-web-empty-"));
    await call("POST", "/api/workspaces", { cwd: empty });
    const [workspace] = await workspaces();
    expect(workspace).toMatchObject({ cwd: empty, sessions: [] });
    expect(Date.parse(workspace!.lastActive)).toBeGreaterThan(Date.now() - 60_000);

    const file = join(empty, "file.txt");
    await writeFile(file, "x");
    const notDir = await call("POST", "/api/workspaces", { cwd: file });
    expect(notDir.status).toBe(400);
    expect(await notDir.text()).toContain("不是目录");
  });

  it("adds the folder of a session started from the web, and brings an archived one back", async () => {
    const created = (await (await call("POST", "/api/sessions", { cwd: harness.cwd })).json()) as { state: SessionState };
    expect(created.state.cwd).toBe(harness.cwd);
    expect((await workspaces()).map((workspace) => workspace.cwd)).toEqual([harness.cwd]);

    const archived = (await (await call("PATCH", "/api/workspaces", { cwd: harness.cwd, archived: true })).json()) as { workspaces: Workspace[] };
    expect(archived.workspaces[0]?.archived).toBe(true);

    await call("POST", "/api/sessions", { cwd: harness.cwd });
    expect((await workspaces())[0]?.archived).toBeUndefined();
    expect((await call("PATCH", "/api/workspaces", { cwd: "/nowhere", archived: true })).status).toBe(404);
  });

  it("deletes a workspace with its session files, but not while one runs", async () => {
    const live = await sessionWithTurn(harness.cwd);
    const file = live.session.sessionFile!;
    await call("POST", "/api/workspaces", { cwd: harness.cwd });

    harness.faux.setResponses([fauxAssistantMessage([fauxText("word ".repeat(2000))])]);
    await live.prompt({ text: "long" });
    await waitFor(() => live.session.isStreaming);
    const busy = await call("DELETE", `/api/workspaces?cwd=${encodeURIComponent(harness.cwd)}`);
    expect(busy.status).toBe(409);
    await live.session.abort();
    await waitFor(() => !live.isRunning);

    const removed = await call("DELETE", `/api/workspaces?cwd=${encodeURIComponent(harness.cwd)}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ workspaces: [], deleted: 1 });
    expect(existsSync(file)).toBe(false);
    expect(harness.registry.peek(live.session.sessionId)).toBeUndefined();
    expect((await call("DELETE", `/api/workspaces?cwd=${encodeURIComponent(harness.cwd)}`)).status).toBe(404);
  });

  it("persists the list and serializes concurrent writes", async () => {
    const store = workspaceStore(harness.agentDir);
    await Promise.all(["/a", "/b", "/c"].map((cwd) => store.add(cwd)));
    await store.setArchived("/b", true);
    const reread = await new WorkspaceStore(store.path).list();
    expect(reread.map((entry) => [entry.cwd, entry.archived ?? false])).toEqual([
      ["/a", false],
      ["/b", true],
      ["/c", false],
    ]);
  });
});
