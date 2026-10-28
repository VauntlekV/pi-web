// Runs the API server (tsx watch) and the Vite dev server together.
import { spawn } from "node:child_process";

const children = [
  spawn("npx", ["tsx", "watch", "server/main.ts", "--host", "127.0.0.1"], { stdio: "inherit" }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];
const stop = () => { for (const child of children) child.kill("SIGTERM"); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", (code) => { if (code) stop(); });
