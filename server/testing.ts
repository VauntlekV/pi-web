import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { CreateSessionRequest } from "../shared/protocol.ts";
import { createApp } from "./app.ts";
import type { LiveSession } from "./live-session.ts";
import { SessionRegistry } from "./registry.ts";

export const TEST_TOKEN = "test-token";

export interface Harness {
  registry: SessionRegistry;
  faux: FauxProviderHandle;
  app: ReturnType<typeof createApp>;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  authHeaders: Record<string, string>;
  createSession(extra?: Partial<CreateSessionRequest>): Promise<LiveSession>;
  close(): Promise<void>;
}

export async function createHarness(options: { noAuth?: boolean; idleMs?: number } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-test-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const faux = fauxProvider({
    provider: "faux",
    models: [
      { id: "faux-1", reasoning: true },
      { id: "faux-2", reasoning: true },
    ],
    tokensPerSecond: 2000,
  });

  const registry = new SessionRegistry({
    defaultCwd: cwd,
    agentDir,
    sessionDir,
    idleMs: options.idleMs ?? 10 * 60_000,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    },
    settingsManagerFactory: () => SettingsManager.inMemory({}),
    onServices: async (services) => {
      services.modelRuntime.registerNativeProvider(faux.provider);
      // A native provider is only "available" once it has a credential; faux ignores the value.
      await services.modelRuntime.setRuntimeApiKey("faux", "faux-key");
    },
  });

  const app = createApp({
    registry,
    auth: { token: TEST_TOKEN, noAuth: options.noAuth ?? false },
    defaultCwd: cwd,
    agentDir,
    version: "test-version",
    piVersion: "test-pi",
  });

  return {
    registry,
    faux,
    app,
    cwd,
    agentDir,
    sessionDir,
    authHeaders: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
    createSession: (extra = {}) => registry.create({ cwd, ...extra }),
    close: async () => {
      await registry.disposeAll();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(
  check: () => T | undefined | false,
  timeoutMs = 15_000,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function messageText(message: { content: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((block): block is { type: "text"; text: string } =>
      typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text")
    .map((block) => block.text)
    .join("");
}
