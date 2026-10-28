// The real app on a throwaway agent dir, a scripted faux model and a demo git
// workspace. Used by the E2E server and the GitHub Pages demo recorder; never
// touches ~/.pi.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createApp } from "../server/app.ts";
import { SessionRegistry } from "../server/registry.ts";
import { E2E_ANSWER, E2E_COMMIT, E2E_TITLE, E2E_TOKEN } from "./constants.ts";

export interface Fixture {
  app: ReturnType<typeof createApp>;
  registry: SessionRegistry;
  /** temp directory holding the workspace, agent dir and sessions */
  root: string;
  /** the demo git workspace */
  cwd: string;
}

const ANSWER = `${E2E_ANSWER}

## 改动

- \`src/todos.js\`：\`addTodo\` 现在返回新建的条目；新增 \`toggleTodo(id)\` 切换完成状态
- \`src/todos.test.js\`：覆盖切换逻辑

\`\`\`js
export function toggleTodo(id) {
  const todo = todos.find((item) => item.id === id);
  if (todo) todo.done = !todo.done;
  return todo;
}
\`\`\`

| 检查 | 结果 |
|---|---|
| \`node --test\` | 1 passed |
| \`git status\` | 1 个修改，1 个新文件 |

下一步可以给 HTTP 层加上 \`PATCH /todos/:id\`。`;

type Message = { role: string; content?: unknown };

const textOf = (message: Message | undefined) =>
  typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
      ? (message.content as { text?: string }[]).map((part) => part.text ?? "").join("")
      : "";

/** One factory for every request: titles, commit messages and the chat turn. */
function respond(context: { messages?: Message[] }) {
  const messages = context.messages ?? [];
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const prompt = textOf(lastUser);
  if (prompt.includes("Changes to commit:")) return fauxAssistantMessage(E2E_COMMIT);
  if (prompt.startsWith("Title this conversation opener")) return fauxAssistantMessage(E2E_TITLE);

  const step = messages.slice(messages.lastIndexOf(lastUser!) + 1).filter((message) => message.role === "toolResult").length;
  if (step === 0) {
    return fauxAssistantMessage(
      [fauxThinking("先看看 todos.js 的现状，再决定怎么加切换功能。"), fauxToolCall("read", { path: "src/todos.js" })],
      { stopReason: "toolUse" },
    );
  }
  if (step === 1) {
    return fauxAssistantMessage(
      [fauxThinking("已经有 addTodo；确认一下工作区状态。"), fauxToolCall("bash", { command: "git status --short" })],
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage([fauxThinking("整理结论。"), fauxText(ANSWER)]);
}

async function createWorkspace(cwd: string): Promise<void> {
  const identity = {
    GIT_AUTHOR_NAME: "pi-web demo",
    GIT_AUTHOR_EMAIL: "demo@example.com",
    GIT_COMMITTER_NAME: "pi-web demo",
    GIT_COMMITTER_EMAIL: "demo@example.com",
  };
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, stdio: "ignore", env: { ...process.env, ...identity } });
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };

  await write("README.md", "# todo-app\n\nA tiny todo list API.\n");
  await write(".gitignore", "node_modules/\n");
  await write(
    "package.json",
    `${JSON.stringify({ name: "todo-app", version: "0.1.0", type: "module", scripts: { start: "node src/server.js", test: "node --test" } }, null, 2)}\n`,
  );
  await write(
    "src/server.js",
    'import { createServer } from "node:http";\nimport { listTodos } from "./todos.js";\n\ncreateServer((req, res) => {\n  res.setHeader("content-type", "application/json");\n  res.end(JSON.stringify(listTodos()));\n}).listen(3000);\n',
  );
  await write("src/todos.js", "const todos = [];\n\nexport function listTodos() {\n  return todos;\n}\n");
  git("init", "-q", "-b", "main");
  // Commits made through the app use the repo's own identity (CI has no global one).
  git("config", "user.name", identity.GIT_AUTHOR_NAME);
  git("config", "user.email", identity.GIT_AUTHOR_EMAIL);
  git("config", "commit.gpgsign", "false");
  commit("init todo api");

  git("checkout", "-q", "-b", "feature/list-view");
  await write("web/index.html", "<!doctype html>\n<ul id=\"todos\"></ul>\n");
  commit("ui: list view");

  git("checkout", "-q", "main");
  await write(
    "src/todos.js",
    "const todos = [];\n\nexport function listTodos() {\n  return todos;\n}\n\nexport function addTodo(title) {\n  todos.push({ id: todos.length + 1, title, done: false });\n}\n",
  );
  commit("add addTodo");
  git("tag", "v0.1.0");

  git("checkout", "-q", "-b", "fix/port");
  await write("src/server.js", (await readFile(join(cwd, "src/server.js"), "utf8")).replace("listen(3000)", "listen(Number(process.env.PORT ?? 3000))"));
  commit("fix: read PORT from the environment");

  git("checkout", "-q", "feature/list-view");
  await write("web/style.css", "li.done { text-decoration: line-through; }\n");
  commit("ui: strike through done todos");

  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "Merge branch 'feature/list-view'", "feature/list-view");

  // Uncommitted work: a modified file and a new one, as an agent would leave them.
  await write(
    "src/todos.js",
    "const todos = [];\n\nexport function listTodos() {\n  return todos;\n}\n\nexport function addTodo(title) {\n  const todo = { id: todos.length + 1, title, done: false };\n  todos.push(todo);\n  return todo;\n}\n\nexport function toggleTodo(id) {\n  const todo = todos.find((item) => item.id === id);\n  if (todo) todo.done = !todo.done;\n  return todo;\n}\n",
  );
  await write(
    "src/todos.test.js",
    'import { test } from "node:test";\nimport assert from "node:assert";\nimport { addTodo, toggleTodo } from "./todos.js";\n\ntest("toggle", () => {\n  const todo = addTodo("write docs");\n  assert.equal(toggleTodo(todo.id).done, true);\n});\n',
  );
}

export async function createFixture(options: { noAuth?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-fixture-"));
  const cwd = join(root, "todo-app");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  for (const dir of [cwd, agentDir, sessionDir]) await mkdir(dir, { recursive: true });
  await createWorkspace(cwd);

  const faux = fauxProvider({
    provider: "demo",
    models: [{ id: "demo-coder", name: "Demo Coder", reasoning: true, contextWindow: 200_000 }],
    tokensPerSecond: Number(process.env.FAUX_TPS ?? 4000),
  });
  faux.setResponses(Array.from({ length: 1000 }, () => respond as never));

  const settings = () => SettingsManager.inMemory({ defaultProvider: "demo", defaultModel: "demo-coder" });
  const registry = new SessionRegistry({
    defaultCwd: cwd,
    agentDir,
    sessionDir,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true },
    settingsManagerFactory: settings,
    onServices: async (services) => {
      services.modelRuntime.registerNativeProvider(faux.provider);
      await services.modelRuntime.setRuntimeApiKey("demo", "demo-key");
    },
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("demo", "demo-key");

  const app = createApp({
    registry,
    modelRuntime,
    settingsManager: settings(),
    auth: { token: E2E_TOKEN, noAuth: options.noAuth ?? false },
    defaultCwd: cwd,
    agentDir,
    version: "demo",
    piVersion: "demo",
    staticDir: resolve(import.meta.dirname, "../dist/web"),
  });
  return { app, registry, root, cwd };
}
