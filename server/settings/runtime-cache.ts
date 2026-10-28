import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppDeps } from "../app.ts";

// One ModelRuntime per agent directory: creating one reads auth.json and models.json.
const runtimes = new Map<string, Promise<ModelRuntime>>();

/** The app-wide ModelRuntime, created on first use (tests may inject one via AppDeps). */
export function getGlobalRuntime(deps: AppDeps): Promise<ModelRuntime> {
  if (deps.modelRuntime) return Promise.resolve(deps.modelRuntime);
  const agentDir = deps.agentDir;
  let runtime = runtimes.get(agentDir);
  if (!runtime) {
    runtime = ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    }).catch((error: unknown) => {
      runtimes.delete(agentDir);
      throw error;
    });
    runtimes.set(agentDir, runtime);
  }
  return runtime;
}

/** Drop cached runtimes so the next getGlobalRuntime() re-reads auth.json and models.json. */
export function invalidateGlobalRuntime(): void {
  runtimes.clear();
}
