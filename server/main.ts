import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import QRCode from "qrcode";
import { createApp, packageVersion } from "./app.ts";
import { resolveToken } from "./auth.ts";
import { SessionRegistry } from "./registry.ts";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 30142;

interface CliOptions {
  host: string;
  port: number;
  cwd: string;
  token?: string;
  noAuth: boolean;
}

const USAGE = `用法: pi-web [选项]

  --host <addr>    监听地址（默认 0.0.0.0，环境变量 PI_WEB_HOST）
  --port <n>       端口（默认 30142，环境变量 PI_WEB_PORT）
  --cwd <dir>      新会话的默认工作区（默认当前目录）
  --token <t>      访问令牌（默认首次生成并保存在 ~/.pi/agent/pi-web/token）
  --no-auth        关闭认证（代理能执行命令，只在可信网络里这样做）
  -h, --help       显示帮助
  -v, --version    显示版本`;

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  let noAuth = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`未知参数: ${argument}`);
    const [rawKey, inlineValue] = argument.slice(2).split("=", 2);
    if (rawKey === "no-auth") {
      noAuth = true;
      continue;
    }
    if (!["host", "port", "cwd", "token"].includes(rawKey)) {
      throw new Error(`未知参数: ${argument}`);
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined) throw new Error(`--${rawKey} 需要一个值`);
    values.set(rawKey, value);
  }

  const portText = values.get("port") ?? process.env.PI_WEB_PORT ?? String(DEFAULT_PORT);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`无效端口: ${portText}`);
  }

  return {
    host: values.get("host") ?? process.env.PI_WEB_HOST ?? DEFAULT_HOST,
    port,
    cwd: resolve(values.get("cwd") ?? process.cwd()),
    token: values.get("token"),
    noAuth,
  };
}

function findStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, "..", "dist", "web"), // server/main.ts (tsx)
    resolve(here, "..", "..", "..", "dist", "web"), // dist/server/server/main.js
    resolve(here, "..", "..", "dist", "web"), // dist/server/main.js
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "index.html")));
}

/** Non-internal IPv4 addresses of this machine (the LAN links). */
function lanAddresses(): string[] {
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.internal) continue;
      if (address.family !== "IPv4" && (address.family as unknown) !== 4) continue;
      found.push(address.address);
    }
  }
  return found;
}

/**
 * Print the links and a terminal QR code of one of them, so the token can be
 * carried to another machine or a phone by scanning. The QR holds the first LAN
 * link when the server listens on every interface (a 127.0.0.1 link opens
 * nothing on another device), otherwise the local one.
 */
async function printAddresses(host: string, port: number, token: string | undefined): Promise<void> {
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const local = `http://127.0.0.1:${port}/${suffix}`;
  const lan = lanAddresses().map((address) => `http://${address}:${port}/${suffix}`);
  console.log(`pi-web 已启动: ${local}`);
  for (const link of lan) console.log(`  ${link}`);

  const everywhere = host === "0.0.0.0" || host === "::";
  const target = everywhere && lan[0] ? lan[0] : local;
  try {
    const qr = await QRCode.toString(target, { type: "terminal", small: true, errorCorrectionLevel: "L" });
    console.log(`\n扫码打开 ${target}\n${qr}`);
  } catch {
    // The links above are enough; a QR that fails to render is not worth a crash.
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(packageVersion());
    return;
  }

  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(USAGE);
    process.exit(1);
  }

  const agentDir = getAgentDir();
  const token = options.noAuth ? undefined : resolveToken(agentDir, options.token);

  const registry = new SessionRegistry({ defaultCwd: options.cwd, agentDir });
  const app = createApp({
    registry,
    auth: { token: token ?? "", noAuth: options.noAuth },
    defaultCwd: options.cwd,
    agentDir,
    staticDir: findStaticDir(),
  });

  if (options.noAuth) {
    console.warn("");
    console.warn("⚠️  警告: 已关闭认证。任何能访问该端口的人都能在此机器上执行 bash 命令。");
    console.warn("⚠️  只应在完全可信的网络上这样运行。");
    console.warn("");
  }

  const server = serve(
    { fetch: app.fetch, hostname: options.host, port: options.port },
    () => void printAddresses(options.host, options.port, token),
  );

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`端口 ${options.port} 已被占用，请用 --port 指定其他端口。`);
    } else {
      console.error("服务器启动失败:", error.message);
    }
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在关闭会话…`);
    try {
      await registry.disposeAll();
    } finally {
      server.close();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
