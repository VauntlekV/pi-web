import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileReadResponse, FileTreeResponse } from "../shared/protocol.ts";
import { resolveInside } from "./files.ts";
import { createHarness, type Harness } from "./testing.ts";

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({ noAuth: true });
});

afterAll(async () => {
  await harness.close();
});

type Params = Record<string, string | undefined>;

function request(path: string, params: Params): Promise<Response> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, value);
  return harness.app.request(`${path}?${search.toString()}`);
}

async function get<T>(path: string, params: Params): Promise<T> {
  const response = await request(path, params);
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

function plainDir(name: string): Promise<string> {
  const dir = join(harness.cwd, name);
  return mkdir(dir, { recursive: true }).then(() => dir);
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

async function gitRepo(name: string): Promise<string> {
  const dir = await plainDir(name);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

describe("resolveInside", () => {
  it("accepts the root and paths inside, rejects escapes", async () => {
    const workspace = await plainDir("resolve/ws");
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "sub", "a.txt"), "a");
    await mkdir(join(workspace, ".."), { recursive: true });
    await writeFile(join(workspace, "..", "outside.txt"), "outside");
    await symlink(join(workspace, "..", "outside.txt"), join(workspace, "escape.txt"));
    await symlink(join(workspace, "sub", "a.txt"), join(workspace, "inner-link.txt"));
    const cwd = await realpath(workspace);

    expect(await resolveInside(cwd, "")).toEqual({ abs: cwd, rel: "" });
    expect(await resolveInside(cwd, "sub/a.txt")).toEqual({
      abs: join(cwd, "sub/a.txt"),
      rel: "sub/a.txt",
    });
    expect(await resolveInside(cwd, "inner-link.txt")).toEqual({
      abs: join(cwd, "sub/a.txt"),
      rel: "sub/a.txt",
    });

    const statusOf = async (rel: string): Promise<number> =>
      resolveInside(cwd, rel).then(
        () => 200,
        (error: { status?: number }) => error.status ?? 500,
      );
    const errorOf = async (rel: string): Promise<string> =>
      resolveInside(cwd, rel).then(
        () => "200",
        (error: { status?: number; message: string }) => `${error.status} ${error.message}`,
      );

    // Lexical containment runs before any fs access: an existing and a missing
    // path outside the workspace must be indistinguishable.
    expect(await errorOf("../outside.txt")).toBe("400 路径超出工作区");
    expect(await errorOf("../missing-outside.txt")).toBe("400 路径超出工作区");
    expect(await statusOf("/etc/passwd")).toBe(400);
    expect(await statusOf("a\u0000b")).toBe(400);
    expect(await statusOf("escape.txt")).toBe(400);
    expect(await statusOf("missing.txt")).toBe(404);
    expect(await statusOf(join(cwd, "nope"))).toBe(400);
    expect(await statusOf("../../..")).toBe(400);

    await expect(resolveInside(join(cwd, "nope"), "")).rejects.toThrowError(/工作区目录不存在/);
    await expect(resolveInside("relative/dir", "")).rejects.toThrowError(/工作区目录不存在/);
  });
});

describe("files tree", () => {
  it("lists one level: dirs first, natural order, dotfiles, ignore and git marks", async () => {
    const root = await gitRepo("tree");
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "a10.txt"), "10");
    await writeFile(join(root, "a2.txt"), "2");
    await writeFile(join(root, "b.txt"), "b");
    await writeFile(join(root, "ignored.txt"), "ignored");
    await mkdir(join(root, "zdir"));
    await writeFile(join(root, "zdir", "inner.txt"), "inner");
    await symlink(join(root, "a2.txt"), join(root, "link.txt"));
    git(root, ["add", "-A"]);
    git(root, ["commit", "-qm", "init"]);
    await writeFile(join(root, "a2.txt"), "changed");
    await writeFile(join(root, "zdir", "inner.txt"), "changed");

    const cwd = await realpath(root);
    const tree = await get<FileTreeResponse>("/api/files/tree", { cwd });
    expect(tree.cwd).toBe(cwd);
    expect(tree.path).toBe("");
    expect(tree.entries.map((entry) => entry.name)).toEqual([
      ".git",
      "zdir",
      ".gitignore",
      "a2.txt",
      "a10.txt",
      "b.txt",
      "ignored.txt",
      "link.txt",
    ]);

    const byName = new Map(tree.entries.map((entry) => [entry.name, entry]));
    expect(byName.get(".git")).toMatchObject({ type: "dir", ignored: true });
    expect(byName.get(".gitignore")).toMatchObject({ type: "file", ignored: false });
    expect(byName.get("ignored.txt")).toMatchObject({ ignored: true });
    expect(byName.get("ignored.txt")?.git).toBeUndefined();
    expect(byName.get("a2.txt")).toMatchObject({ type: "file", size: 7, git: "modified" });
    expect(byName.get("b.txt")).toMatchObject({ size: 1 });
    expect(byName.get("b.txt")?.git).toBeUndefined();
    expect(byName.get("zdir")).toMatchObject({ type: "dir", git: "modified" });
    expect(byName.get("link.txt")).toMatchObject({ type: "symlink" });
    expect(byName.get("link.txt")?.size).toBeUndefined();

    const nested = await get<FileTreeResponse>("/api/files/tree", { cwd, path: "zdir" });
    expect(nested.path).toBe("zdir");
    expect(nested.entries.map((entry) => entry.path)).toEqual(["zdir/inner.txt"]);
    expect(nested.entries[0]).toMatchObject({ git: "modified" });
  });

  it("reports nothing as ignored or changed outside a repository", async () => {
    const root = await plainDir("tree-plain");
    await mkdir(join(root, "d"));
    await writeFile(join(root, ".env"), "SECRET=1");
    await writeFile(join(root, "x.txt"), "x");

    const tree = await get<FileTreeResponse>("/api/files/tree", { cwd: await realpath(root) });
    expect(tree.entries.map((entry) => entry.name)).toEqual(["d", ".env", "x.txt"]);
    for (const entry of tree.entries) {
      expect(entry.ignored).toBe(false);
      expect(entry.git).toBeUndefined();
    }

    expect((await request("/api/files/tree", { cwd: await realpath(root), path: "x.txt" })).status).toBe(400);
  });
});

describe("files read", () => {
  it("classifies text, empty, binary, image, oversized and languages", async () => {
    const root = await plainDir("read");
    await writeFile(join(root, "hello.ts"), "const a = 1;\n");
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, "bytes.bin"), Buffer.from([0x41, 0x00, 0x42]));
    await writeFile(join(root, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(join(root, "notes.py"), "print(1)\n");
    await writeFile(join(root, "notes.md"), "# t\n");
    await writeFile(join(root, "run.sh"), "echo hi\n");
    await writeFile(join(root, "Dockerfile"), "FROM node\n");
    await writeFile(join(root, "big.txt"), "a".repeat(1024 * 1024 - 1) + "中文");

    const cwd = await realpath(root);
    const read = (path: string) => get<FileReadResponse>("/api/files/read", { cwd, path });

    const text = await read("hello.ts");
    expect(text).toMatchObject({ path: "hello.ts", size: 13, kind: "text", text: "const a = 1;\n", language: "typescript" });
    expect(text.modified).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(text.truncated).toBeUndefined();

    expect(await read("empty.txt")).toMatchObject({ kind: "text", text: "", size: 0 });
    expect(await read("bytes.bin")).toMatchObject({ kind: "binary" });
    expect(await read("pixel.png")).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect((await read("pixel.png")).text).toBeUndefined();
    expect((await read("notes.py")).language).toBe("python");
    expect((await read("notes.md")).language).toBe("markdown");
    expect((await read("run.sh")).language).toBe("bash");
    expect((await read("Dockerfile")).language).toBe("dockerfile");

    const big = await read("big.txt");
    expect(big.kind).toBe("text");
    expect(big.truncated).toBe(true);
    expect(big.text?.endsWith("a")).toBe(true);
    expect(big.text).not.toContain("\uFFFD");
    expect(Buffer.byteLength(big.text ?? "", "utf8")).toBe(1024 * 1024 - 1);

    expect((await request("/api/files/read", { cwd, path: "" })).status).toBe(400);
    expect((await request("/api/files/read", { cwd, path: "missing.txt" })).status).toBe(404);
  });
});

describe("files raw", () => {
  it("streams bytes with content type and hardening headers", async () => {
    const root = await plainDir("raw");
    await writeFile(join(root, "page.html"), "<h1>hi</h1>");
    await writeFile(join(root, "中文 图.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const cwd = await realpath(root);

    const html = await request("/api/files/raw", { cwd, path: "page.html" });
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(html.headers.get("content-length")).toBe("11");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");
    expect(html.headers.get("content-security-policy")).toBe("sandbox");
    expect(html.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''page.html");
    expect(await html.text()).toBe("<h1>hi</h1>");

    const image = await request("/api/files/raw", { cwd, path: "中文 图.png" });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toBe(
      "inline; filename*=UTF-8''%E4%B8%AD%E6%96%87%20%E5%9B%BE.png",
    );

    expect((await request("/api/files/raw", { cwd, path: "" })).status).toBe(400);
    expect((await request("/api/files/raw", { cwd, path: "nope.bin" })).status).toBe(404);
  });
});
