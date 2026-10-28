import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadOrCreateToken, resolveToken, safeEqual } from "./auth.ts";
import { createHarness, TEST_TOKEN } from "./testing.ts";

const json = { "content-type": "application/json" };

describe("auth", () => {
  it("requires credentials, accepts Bearer and the login cookie", async () => {
    const harness = await createHarness();
    try {
      expect((await harness.app.request("/api/config")).status).toBe(401);

      const bearer = await harness.app.request("/api/config", {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(bearer.status).toBe(200);

      const login = await harness.app.request("/api/auth/login", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ token: TEST_TOKEN }),
      });
      expect(login.status).toBe(200);
      expect(await login.json()).toEqual({ ok: true });

      const setCookie = login.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("pi_web_token=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("Max-Age=2592000");
      expect(setCookie).not.toContain("Secure");

      const cookie = setCookie.split(";")[0];
      expect((await harness.app.request("/api/config", { headers: { cookie } })).status).toBe(200);
    } finally {
      await harness.close();
    }
  });

  it("rejects a wrong token and rate limits the 11th failure", async () => {
    const harness = await createHarness();
    try {
      const wrong = () =>
        harness.app.request("/api/auth/login", {
          method: "POST",
          headers: { ...json, "x-forwarded-for": "203.0.113.9" },
          body: JSON.stringify({ token: "nope" }),
        });

      for (let attempt = 1; attempt <= 10; attempt += 1) {
        expect((await wrong()).status).toBe(401);
      }
      expect((await wrong()).status).toBe(429);

      // A correct token still logs in.
      const login = await harness.app.request("/api/auth/login", {
        method: "POST",
        headers: { ...json, "x-forwarded-for": "203.0.113.9" },
        body: JSON.stringify({ token: TEST_TOKEN }),
      });
      expect(login.status).toBe(200);

      expect(
        (
          await harness.app.request("/api/config", {
            headers: { authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(401);
    } finally {
      await harness.close();
    }
  });

  it("malformed login bodies are 400 and logout clears the cookie", async () => {
    const harness = await createHarness();
    try {
      const notJson = await harness.app.request("/api/auth/login", {
        method: "POST",
        headers: json,
        body: "not json",
      });
      expect(notJson.status).toBe(400);

      const notString = await harness.app.request("/api/auth/login", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ token: 42 }),
      });
      expect(notString.status).toBe(400);

      const logout = await harness.app.request("/api/auth/logout", { method: "POST" });
      expect(logout.status).toBe(200);
      expect(logout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    } finally {
      await harness.close();
    }
  });

  it("health is public, auth check reports its state", async () => {
    const harness = await createHarness();
    try {
      const health = await harness.app.request("/api/health");
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        ok: true,
        version: "test-version",
        piVersion: "test-pi",
      });

      expect((await harness.app.request("/api/auth/check")).status).toBe(401);
      const check = await harness.app.request("/api/auth/check", {
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(check.status).toBe(200);
      expect(await check.json()).toEqual({ authRequired: true });
    } finally {
      await harness.close();
    }
  });

  it("no-auth mode lets every API call through", async () => {
    const harness = await createHarness({ noAuth: true });
    try {
      expect((await harness.app.request("/api/workspaces")).status).toBe(200);
      const check = await harness.app.request("/api/auth/check");
      expect(check.status).toBe(200);
      expect(await check.json()).toEqual({ authRequired: false });
    } finally {
      await harness.close();
    }
  });

  it("?token= on a page sets the cookie and redirects without it", async () => {
    const harness = await createHarness();
    try {
      const redirect = await harness.app.request(`/?token=${TEST_TOKEN}`);
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/");
      expect(redirect.headers.get("set-cookie") ?? "").toContain("pi_web_token=");

      const withOtherQuery = await harness.app.request(`/some/page?foo=1&token=${TEST_TOKEN}`);
      expect(withOtherQuery.status).toBe(302);
      expect(withOtherQuery.headers.get("location")).toBe("/some/page?foo=1");

      const rejected = await harness.app.request("/?token=wrong");
      expect(rejected.status).not.toBe(302);
      expect(rejected.headers.get("set-cookie")).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("persists a generated 32-byte token with 0600 permissions", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-web-token-"));
    const previous = process.env.PI_WEB_TOKEN;
    try {
      const first = loadOrCreateToken(agentDir);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(loadOrCreateToken(agentDir)).toBe(first);

      const file = join(agentDir, "pi-web", "token");
      const mode = (await stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
      const dirMode = (await stat(join(agentDir, "pi-web"))).mode & 0o777;
      expect(dirMode).toBe(0o700);

      process.env.PI_WEB_TOKEN = "from-env";
      expect(resolveToken(agentDir, "from-flag")).toBe("from-flag");
      expect(resolveToken(agentDir)).toBe("from-env");
      delete process.env.PI_WEB_TOKEN;
      expect(resolveToken(agentDir)).toBe(first);
    } finally {
      if (previous === undefined) delete process.env.PI_WEB_TOKEN;
      else process.env.PI_WEB_TOKEN = previous;
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("safeEqual returns false for different lengths instead of throwing", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
