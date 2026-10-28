// E2E server, started by playwright.config.ts: the shared fixture over HTTP.
import { serve } from "@hono/node-server";
import { E2E_PORT } from "./constants.ts";
import { createFixture } from "./fixture.ts";

const { app, cwd } = await createFixture();
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: E2E_PORT }, () =>
  console.log(`e2e server http://127.0.0.1:${E2E_PORT} cwd=${cwd}`),
);
