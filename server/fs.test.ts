import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listDirectories, listFiles } from "./fs.ts";
import { createHarness } from "./testing.ts";

async function temporaryDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("fs", () => {
  it("lists absolute directories without hidden entries and reports the parent", async () => {
    const root = await temporaryDir("pi-web-fs-");
    await mkdir(join(root, "src"));
    await mkdir(join(root, "zeta"));
    await mkdir(join(root, ".hidden"));

    const listing = listDirectories(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).toBe(join(root, ".."));
    expect(listing.dirs).toEqual(["src", "zeta"]);

    expect(listDirectories("/").parent).toBeNull();

    await expect(() => listDirectories("relative/dir")).toThrowError(/绝对路径/);
    await expect(() => listDirectories(join(root, "missing"))).toThrowError(/不存在/);
  });

  it("serves fs/list errors through the HTTP API", async () => {
    const harness = await createHarness();
    try {
      const relative = await harness.app.request("/api/fs/list?path=relative", {
        headers: harness.authHeaders,
      });
      expect(relative.status).toBe(400);

      const missing = await harness.app.request(`/api/fs/list?path=${encodeURIComponent(join(harness.cwd, "nope"))}`, {
        headers: harness.authHeaders,
      });
      expect(missing.status).toBe(404);

      const ok = await harness.app.request(`/api/fs/list?path=${encodeURIComponent(harness.cwd)}`, {
        headers: harness.authHeaders,
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { path: string; parent: string | null; dirs: string[] };
      expect(body.path).toBe(harness.cwd);
      expect(body.dirs).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it("uses git ls-files and honors gitignore in a repository", async () => {
    const root = await temporaryDir("pi-web-git-");
    execFileSync("git", ["init", "-q"], { cwd: root });
    await mkdir(join(root, "src"));
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "ignored.txt"), "ignored");
    await writeFile(join(root, "src", "b.ts"), "b");

    const files = await listFiles(root);
    expect(files).toEqual(expect.arrayContaining(["a.txt", ".gitignore", "src/b.ts"]));
    expect(files).not.toContain("ignored.txt");

    expect(await listFiles(root, "B.TS")).toEqual(["src/b.ts"]);
    expect(await listFiles(root, "SRC/")).toEqual(["src/b.ts"]);
    expect(await listFiles(root, "no-match")).toEqual([]);
  });

  it("falls back to a bounded walk outside git and skips dot dirs and node_modules", async () => {
    const root = await temporaryDir("pi-web-plain-");
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "z.md"), "z");
    await writeFile(join(root, "src", "a.txt"), "a");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x");
    await writeFile(join(root, ".hidden", "secret.txt"), "s");

    const files = await listFiles(root);
    expect(files).toEqual(expect.arrayContaining(["src/a.txt", "z.md"]));
    expect(files).not.toContain("node_modules/pkg/index.js");
    expect(files.some((file) => file.startsWith(".hidden"))).toBe(false);
    expect(await listFiles(root, "A.TXT")).toEqual(["src/a.txt"]);

    await expect(listFiles(join(root, "missing"))).rejects.toThrowError(/cwd/);
  });
});
