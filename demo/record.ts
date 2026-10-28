// Records the GitHub Pages demo: drives the real app (e2e fixture, faux model)
// through the browser's own API client, then writes every response plus one
// streamed agent turn to JSON. web/src/demo/mock.ts replays it in the browser.
//
//   npx tsx demo/record.ts [out.json]     (default .demo/demo-data.json)
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ServerEvent } from "../shared/protocol.ts";
import { E2E_PROMPT } from "../e2e/constants.ts";
import { createFixture } from "../e2e/fixture.ts";
import type { DemoData, DemoResponse } from "../web/src/demo/data.ts";

const out = resolve(process.argv[2] ?? ".demo/demo-data.json");
const { app, cwd, root, registry } = await createFixture({ noAuth: true });

// The browser client calls fetch("/api/..."); route it into the app and keep every GET.
const responses: Record<string, DemoResponse> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const response = await app.request(url, init);
  const method = init?.method ?? "GET";
  if (method === "GET" || url === "/api/git/message") {
    const text = await response.clone().text();
    responses[`${method} ${url}`] = { status: response.status, body: text ? JSON.parse(text) : null };
  }
  return response;
}) as typeof fetch;
const { api } = await import("../web/src/api/client.ts");

// ------------------------------------------------------------ one agent turn

const created = await api.createSession({ cwd });
const id = created.state.id;
const turn: { at: number; event: ServerEvent }[] = [];
const stream = await app.request(api.eventsUrl(id));
const reader = stream.body!.pipeThrough(new TextDecoderStream()).getReader();
let started = 0;
let settled = false;
let named = false;

const reading = (async () => {
  let buffer = "";
  while (!(settled && named)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const chunk = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      const event = JSON.parse(data) as ServerEvent;
      if (event.type === "snapshot") continue;
      turn.push({ at: Date.now() - started, event });
      if (event.type === "agent_settled") settled = true;
      if (event.type === "session_name") named = true;
    }
  }
})();

started = Date.now();
await api.prompt(id, { text: E2E_PROMPT });
await Promise.race([reading, new Promise((done) => setTimeout(done, 20_000))]);
await reader.cancel();
if (!settled) throw new Error("the recorded turn never settled");

// ------------------------------------------------------------- every GET

await api.config();
await api.workspaces();
await api.models();
await api.models(id);
await api.getSession(id);
await api.commands(id);
await api.listDirs();
await api.listDirs(cwd);
await api.searchFiles(cwd, "");

const files: string[] = [];
const walk = async (path: string) => {
  const tree = await api.fileTree(cwd, path);
  for (const entry of tree.entries) {
    if (entry.type === "dir") {
      if (entry.name !== ".git" && entry.name !== "node_modules") await walk(entry.path);
    } else {
      files.push(entry.path);
    }
  }
};
await walk("");
for (const path of files) await api.readFile(cwd, path);

const status = await api.gitStatus(cwd);
for (const file of status.files) {
  if (file.staged) await api.gitDiff(cwd, file.path, true);
  if (file.unstaged) await api.gitDiff(cwd, file.path, false);
}
await api.gitLog(cwd, 100, true);
await api.gitMessage(cwd, null);

await api.settings();
await api.settingsFile();
await api.providers();
await api.modelsConfig();
await api.resources();
await api.resources(cwd);
for (const range of ["all", "30d", "7d"] as const) await api.stats(range);
await api.uiState();
await registry.disposeAll();

// --------------------------------------------------------------- write out

const data: DemoData = {
  sessionId: id,
  cwd,
  prompt: E2E_PROMPT,
  created: created.state,
  turn,
  responses,
};
// Show a believable home directory instead of the runner's temp paths.
const replacements: [string, string][] = [
  [join(root, "agent"), "/home/demo/.pi/agent"],
  [join(root, "sessions"), "/home/demo/.pi/agent/sessions"],
  [root, "/home/demo/code"],
  [homedir(), "/home/demo"],
];
let json = JSON.stringify(data);
for (const [from, to] of replacements) {
  json = json.split(from).join(to).split(encodeURIComponent(from)).join(encodeURIComponent(to));
}
await mkdir(dirname(out), { recursive: true });
await writeFile(out, json);
console.log(`recorded ${Object.keys(responses).length} responses and ${turn.length} events → ${out}`);
process.exit(0);
