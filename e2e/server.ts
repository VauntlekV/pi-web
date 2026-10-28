// E2E server, started by playwright.config.ts: the shared fixture over HTTP.
import { serve } from "@hono/node-server";
import { E2E_PORT } from "./constants.ts";
import { createFixture } from "./fixture.ts";

// A two-listing models.dev stand-in, so the editor's catalog fill works offline.
process.env.PI_WEB_MODELS_DEV_URL = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    qwen: {
      name: "Qwen",
      api: "https://dashscope.example.com/v1",
      models: {
        "qwen3-coder": {
          name: "Qwen3 Coder",
          reasoning: false,
          limit: { context: 262144, output: 65536 },
          cost: { input: 0.3, output: 1.2 },
        },
      },
    },
  }),
)}`;

const { app, cwd } = await createFixture();
serve({ fetch: app.fetch, hostname: "127.0.0.1", port: E2E_PORT }, () =>
  console.log(`e2e server http://127.0.0.1:${E2E_PORT} cwd=${cwd}`),
);
