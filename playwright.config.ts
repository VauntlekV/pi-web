import { defineConfig, devices } from "@playwright/test";
import { E2E_PORT } from "./e2e/constants.ts";

const ci = Boolean(process.env.CI);

// Needs `npm run build:web` first (the server serves dist/web); `npm run test:e2e` does both.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  timeout: 30_000,
  reporter: ci ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 900 } } }],
  webServer: {
    command: "npx tsx e2e/server.ts",
    url: `http://127.0.0.1:${E2E_PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
  },
});
