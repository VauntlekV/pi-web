import { describe, expect, it } from "vitest";
import type { PackageOpResult } from "../../shared/protocol.ts";
import { acquirePackageLock } from "./packages.ts";
import { createSettingsHarness } from "./testing.ts";

describe("packages", () => {
  it("rejects invalid sources and local operations without cwd", async () => {
    const h = await createSettingsHarness();
    try {
      const invalid = [
        {},
        { source: "" },
        { source: "   " },
        { source: `bad\nsource` },
        { source: "x".repeat(501) },
        { source: 42 },
      ];
      for (const body of invalid) {
        for (const command of ["install", "remove"]) {
          const response = await h.json(`/api/packages/${command}`, { method: "POST", body: JSON.stringify(body) });
          expect(response.status, `${command} ${JSON.stringify(body)}`).toBe(400);
        }
      }

      const localWithoutCwd = await h.json("/api/packages/install", {
        method: "POST",
        body: JSON.stringify({ source: "./pkg", local: true }),
      });
      expect(localWithoutCwd.status).toBe(400);

      const badLocalCwd = await h.json("/api/packages/install", {
        method: "POST",
        body: JSON.stringify({ source: "./pkg", local: true, cwd: "/definitely/not/a/real/directory" }),
      });
      expect(badLocalCwd.status).toBe(400);

      const badLocalFlag = await h.json("/api/packages/update", {
        method: "POST",
        body: JSON.stringify({ local: "yes" }),
      });
      expect(badLocalFlag.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it("allows only one package operation at a time", async () => {
    const h = await createSettingsHarness();
    try {
      const release = acquirePackageLock();
      try {
        expect(() => acquirePackageLock()).toThrowError(/已有包操作进行中/);

        const concurrent = await h.json<PackageOpResult>("/api/packages/install", {
          method: "POST",
          body: JSON.stringify({ source: "npm:@example/slow-package" }),
        });
        expect(concurrent.status).toBe(409);
      } finally {
        release();
      }

      const reacquired = acquirePackageLock();
      reacquired();
      reacquired(); // releasing twice is harmless
      const again = acquirePackageLock();
      again();
    } finally {
      await h.close();
    }
  });
});
