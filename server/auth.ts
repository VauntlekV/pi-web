import { randomBytes, timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context, type MiddlewareHandler } from "hono";

const COOKIE_NAME = "pi_web_token";
const COOKIE_MAX_AGE = 2_592_000; // 30 days
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_FAILURES = 10;

export interface AuthOptions {
  token: string;
  noAuth: boolean;
}

export interface Auth {
  readonly token: string;
  readonly noAuth: boolean;
  /** Guards `/api/*`, except health and auth routes. */
  readonly middleware: MiddlewareHandler;
  /** `/api/auth/check|login|logout` */
  readonly routes: Hono;
  authorized(c: Context): boolean;
}

/** `--token` > `PI_WEB_TOKEN` > `<agentDir>/pi-web/token`, generating the file on first use. */
export function resolveToken(agentDir: string, explicit?: string): string {
  const fromFlag = explicit?.trim();
  if (fromFlag) return fromFlag;
  const fromEnv = process.env.PI_WEB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return loadOrCreateToken(agentDir);
}

export function loadOrCreateToken(agentDir: string): string {
  const dir = join(agentDir, "pi-web");
  const file = join(dir, "token");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // Missing file: create it below.
  }

  const token = randomBytes(32).toString("hex");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A shared agent dir may not allow chmod; the token file mode still applies.
  }
  writeFileSync(file, token, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best effort, same as above.
  }
  return token;
}

/** Constant-time compare; unequal lengths return false without throwing. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return nodeTimingSafeEqual(left, right);
}

export function authCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
}

export function clearAuthCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function bearerToken(c: Context): string | undefined {
  const header = c.req.header("authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1];
  }
  const cookie = c.req.header("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== COOKIE_NAME) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function clientIp(c: Context): string {
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return address;
  } catch {
    // No socket (tests, some runtimes): fall back to the forwarded header.
  }
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isProtectedPath(path: string): boolean {
  if (!path.startsWith("/api/")) return false;
  return path !== "/api/health" && !path.startsWith("/api/auth/");
}

export function createAuth(options: AuthOptions): Auth {
  const failures = new Map<string, { count: number; resetAt: number }>();

  function authorized(c: Context): boolean {
    if (options.noAuth) return true;
    const presented = bearerToken(c);
    return presented !== undefined && safeEqual(presented, options.token);
  }

  function recordFailure(ip: string): number {
    const now = Date.now();
    const entry = failures.get(ip);
    if (!entry || entry.resetAt <= now) {
      failures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    if (options.noAuth) return next();
    if (!isProtectedPath(new URL(c.req.url).pathname)) return next();
    if (authorized(c)) return next();
    return c.json({ error: "unauthorized" }, 401);
  };

  const routes = new Hono();

  routes.get("/api/auth/check", (c) => {
    if (options.noAuth) return c.json({ authRequired: false });
    if (authorized(c)) return c.json({ authRequired: true });
    return c.json({ error: "unauthorized" }, 401);
  });

  routes.post("/api/auth/login", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const token = (body as { token?: unknown } | null)?.token;
    if (typeof token !== "string") return c.json({ error: "token 必须是字符串" }, 400);

    const ip = clientIp(c);
    if (options.noAuth || safeEqual(token, options.token)) {
      failures.delete(ip);
      c.header("Set-Cookie", authCookie(options.noAuth ? token : options.token));
      return c.json({ ok: true });
    }

    if (recordFailure(ip) > LOGIN_MAX_FAILURES) {
      return c.json({ error: "too many failed attempts" }, 429);
    }
    return c.json({ error: "invalid token" }, 401);
  });

  routes.post("/api/auth/logout", (c) => {
    c.header("Set-Cookie", clearAuthCookie());
    return c.json({ ok: true });
  });

  return { token: options.token, noAuth: options.noAuth, middleware, routes, authorized };
}
