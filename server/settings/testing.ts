import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { SessionRegistry } from "../registry.ts";

/**
 * App harness for the settings routes. Unlike `createHarness`, it injects a shared
 * ModelRuntime (with a faux provider) so provider listing and default-model
 * selection can be tested without touching the real ~/.pi.
 */
export interface SettingsHarness {
  app: Hono;
  registry: SessionRegistry;
  faux: FauxProviderHandle;
  modelRuntime: ModelRuntime;
  root: string;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  json<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<{ status: number; body: T }>;
  close(): Promise<void>;
}

export async function createSettingsHarness(): Promise<SettingsHarness> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-settings-"));
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
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("faux", "faux-key");

  const registry = new SessionRegistry({
    defaultCwd: cwd,
    agentDir,
    sessionDir,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
      noThemes: true,
    },
    settingsManagerFactory: () => SettingsManager.create(cwd, agentDir),
    onServices: async (services) => {
      services.modelRuntime.registerNativeProvider(faux.provider);
      await services.modelRuntime.setRuntimeApiKey("faux", "faux-key");
    },
  });

  const app = createApp({
    registry,
    auth: { token: "test-token", noAuth: true },
    defaultCwd: cwd,
    agentDir,
    version: "test-version",
    piVersion: "test-pi",
    modelRuntime,
  });

  const json = async <T>(path: string, init: RequestInit = {}) => {
    const response = await app.request(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    return { status: response.status, body: (await response.json()) as T };
  };

  return {
    app,
    registry,
    faux,
    modelRuntime,
    root,
    cwd,
    agentDir,
    sessionDir,
    json,
    close: async () => {
      await registry.disposeAll();
      await rm(root, { recursive: true, force: true });
    },
  };
}
