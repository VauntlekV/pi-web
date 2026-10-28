// Package smoke test (CI): pack the built project, check the tarball contents,
// install it globally into a throwaway prefix and start the installed CLI with
// an empty HOME. Run after `npm run build`.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temp = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-smoke-")));
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};
const step = (message) => console.log(`✓ ${message}`);

try {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root, encoding: "utf8" }));
  const files = pack.files.map((file) => file.path);
  for (const required of ["bin/pi-web.js", "dist/web/index.html", "dist/server/server/main.js", "LICENSE", "README.md"]) {
    if (!files.includes(required)) fail(`tarball is missing ${required}`);
  }
  const leaked = files.filter((file) => file.endsWith(".map") || /testing\.js$|\.test\.js$|^e2e\/|^demo\/|^web\/src\//.test(file));
  if (leaked.length > 0) fail(`tarball ships dev files: ${leaked.join(", ")}`);
  step(`${pack.filename}: ${files.length} files, ${(pack.size / 1024).toFixed(0)} KiB`);

  const prefix = join(temp, "prefix");
  execFileSync("npm", ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", join(temp, pack.filename)], {
    stdio: "inherit",
  });
  const bin = process.platform === "win32" ? join(prefix, "pi-web.cmd") : join(prefix, "bin", "pi-web");
  // An empty HOME: the first run must work without any ~/.pi setup.
  const env = { ...process.env, HOME: join(temp, "home"), USERPROFILE: join(temp, "home") };
  delete env.PI_CODING_AGENT_DIR;

  const printed = execFileSync(bin, ["--version"], { encoding: "utf8", env }).trim();
  if (printed !== version) fail(`--version printed ${printed}, expected ${version}`);
  step(`pi-web --version → ${printed}`);

  const port = 30150 + Math.floor(Math.random() * 40);
  const server = spawn(bin, ["--host", "127.0.0.1", "--port", String(port), "--no-auth", "--cwd", temp], { env, stdio: "inherit" });
  try {
    const base = `http://127.0.0.1:${port}`;
    let health;
    for (let attempt = 0; attempt < 60 && !health; attempt++) {
      health = await fetch(`${base}/api/health`).then((response) => response.json()).catch(() => undefined);
      if (!health) await new Promise((done) => setTimeout(done, 500));
    }
    if (health?.version !== version) fail(`/api/health answered ${JSON.stringify(health)}`);
    step(`/api/health → ${health.version} (pi ${health.piVersion})`);

    const page = await (await fetch(`${base}/`)).text();
    if (!page.includes('<div id="root">')) fail("/ did not serve the web app");
    const config = await (await fetch(`${base}/api/config`)).json();
    if (config.defaultCwd !== temp) fail(`/api/config defaultCwd is ${config.defaultCwd}`);
    step("web app and /api/config served by the installed package");
  } finally {
    server.kill("SIGTERM");
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
