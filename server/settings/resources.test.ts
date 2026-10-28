import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResourceItem, ResourceType, ResourcesView } from "../../shared/protocol.ts";
import { createSettingsHarness, type SettingsHarness } from "./testing.ts";

async function seedResources(h: SettingsHarness): Promise<Record<"extension" | "skill" | "prompt", string>> {
  const extension = join(h.agentDir, "extensions", "tool.ts");
  const skill = join(h.agentDir, "skills", "demo", "SKILL.md");
  const prompt = join(h.agentDir, "prompts", "review.md");
  await mkdir(join(h.agentDir, "extensions"), { recursive: true });
  await mkdir(join(h.agentDir, "skills", "demo"), { recursive: true });
  await mkdir(join(h.agentDir, "prompts"), { recursive: true });
  await writeFile(extension, "export default {};\n");
  await writeFile(skill, "---\nname: demo\ndescription: A demo skill\n---\nBody\n");
  await writeFile(prompt, "---\ndescription: Review code\n---\nReview\n");
  return { extension, skill, prompt };
}

const item = (view: ResourcesView, id: string, type?: ResourceType): ResourceItem => {
  const found = view.items.find((entry) => entry.id === id && (type === undefined || entry.type === type));
  if (!found) throw new Error(`resource ${id} missing`);
  return found;
};

describe("resources", () => {
  it("lists extensions, skills, prompts, and built-ins with metadata", async () => {
    const h = await createSettingsHarness();
    try {
      const paths = await seedResources(h);
      const response = await h.json<ResourcesView>(`/api/resources?cwd=${encodeURIComponent(h.cwd)}`);
      expect(response.status).toBe(200);
      expect(response.body.cwd).toBe(h.cwd);
      expect(response.body.diagnostics).toEqual([]);

      const extension = item(response.body, paths.extension, "extension");
      expect(extension.enabled).toBe(true);
      expect(extension.name).toBe("tool");
      expect(extension.origin).toBe("user");
      expect(extension.path).toBe(paths.extension);

      const skill = item(response.body, paths.skill, "skill");
      expect(skill.name).toBe("demo");
      expect(skill.description).toBe("A demo skill");

      const prompt = item(response.body, paths.prompt, "prompt");
      expect(prompt.name).toBe("review");
      expect(prompt.description).toBe("Review code");

      const builtins = response.body.items.filter((entry) => entry.origin === "builtin");
      expect(builtins.map((entry) => entry.name).sort()).toEqual(["codemode", "mcp", "tool-search"]);
      for (const builtin of builtins) {
        expect(builtin.type).toBe("extension");
        expect(builtin.enabled).toBe(true);
        expect(builtin.path).toBeUndefined();
      }
    } finally {
      await h.close();
    }
  });

  it("names folder extensions after the folder but plain files without their extension", async () => {
    const h = await createSettingsHarness();
    try {
      const plain = join(h.agentDir, "extensions", "herdr-agent-state.ts");
      const indexed = join(h.agentDir, "extensions", "header", "index.ts");
      await mkdir(join(h.agentDir, "extensions", "header"), { recursive: true });
      await writeFile(plain, "export default {};\n");
      await writeFile(indexed, "export default {};\n");

      const response = await h.json<ResourcesView>(`/api/resources?cwd=${encodeURIComponent(h.cwd)}`);
      expect(item(response.body, plain, "extension").name).toBe("herdr-agent-state");
      expect(item(response.body, indexed, "extension").name).toBe("header");
    } finally {
      await h.close();
    }
  });

  it("toggles a resource off, keeps listing it, then turns it back on", async () => {
    const h = await createSettingsHarness();
    try {
      const paths = await seedResources(h);
      const cases: { type: ResourceType; id: string }[] = [
        { type: "extension", id: paths.extension },
        { type: "skill", id: paths.skill },
        { type: "prompt", id: paths.prompt },
      ];

      for (const entry of cases) {
        const off = await h.json<ResourcesView>("/api/resources/toggle", {
          method: "POST",
          body: JSON.stringify({ ...entry, cwd: h.cwd, enabled: false }),
        });
        expect(off.status, entry.type).toBe(200);
        expect(item(off.body, entry.id, entry.type).enabled).toBe(false);

        const listed = await h.json<ResourcesView>(`/api/resources?cwd=${encodeURIComponent(h.cwd)}`);
        expect(item(listed.body, entry.id, entry.type).enabled).toBe(false);

        const on = await h.json<ResourcesView>("/api/resources/toggle", {
          method: "POST",
          body: JSON.stringify({ ...entry, cwd: h.cwd, enabled: true }),
        });
        expect(item(on.body, entry.id, entry.type).enabled).toBe(true);
      }

      const settings = JSON.parse(await readFile(join(h.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
      expect(settings.extensions).toContain("+extensions/tool.ts");
      expect(settings.skills).toContain("+skills/demo/SKILL.md");
      expect(settings.prompts).toContain("+prompts/review.md");
    } finally {
      await h.close();
    }
  });

  it("writes -builtin:mcp when a built-in extension is disabled", async () => {
    const h = await createSettingsHarness();
    try {
      const off = await h.json<ResourcesView>("/api/resources/toggle", {
        method: "POST",
        body: JSON.stringify({ type: "extension", id: "builtin:mcp", enabled: false }),
      });
      expect(off.status).toBe(200);
      expect(item(off.body, "builtin:mcp", "extension").enabled).toBe(false);

      const settings = JSON.parse(await readFile(join(h.agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
      expect(settings.extensions).toEqual(["-builtin:mcp"]);

      const on = await h.json<ResourcesView>("/api/resources/toggle", {
        method: "POST",
        body: JSON.stringify({ type: "extension", id: "builtin:mcp", enabled: true }),
      });
      expect(item(on.body, "builtin:mcp", "extension").enabled).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("toggles a package resource through the package filter object", async () => {
    const h = await createSettingsHarness();
    try {
      const packageDir = join(h.root, "local-package");
      await mkdir(join(packageDir, "extensions"), { recursive: true });
      await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "local-package" }));
      const extension = join(packageDir, "extensions", "pkg-tool.ts");
      await writeFile(extension, "export default {};\n");
      const source = relative(h.agentDir, packageDir);
      await writeFile(join(h.agentDir, "settings.json"), `${JSON.stringify({ packages: [source] }, null, 2)}\n`);

      const listed = await h.json<ResourcesView>(`/api/resources?cwd=${encodeURIComponent(h.cwd)}`);
      const plugin = item(listed.body, extension, "extension");
      expect(plugin.origin).toBe("package");
      expect(plugin.packageSource).toBe(source);
      expect(plugin.enabled).toBe(true);
      expect(listed.body.packages).toEqual([
        expect.objectContaining({ source, scope: "user", filtered: false, counts: { extension: 1 } }),
      ]);

      const off = await h.json<ResourcesView>("/api/resources/toggle", {
        method: "POST",
        body: JSON.stringify({ type: "extension", id: extension, enabled: false }),
      });
      expect(off.status).toBe(200);
      expect(item(off.body, extension, "extension").enabled).toBe(false);
      expect(off.body.packages[0]).toMatchObject({ filtered: true });

      const settings = JSON.parse(await readFile(join(h.agentDir, "settings.json"), "utf8")) as {
        packages: unknown[];
      };
      expect(settings.packages).toEqual([{ source, extensions: ["-extensions/pkg-tool.ts"] }]);

      const on = await h.json<ResourcesView>("/api/resources/toggle", {
        method: "POST",
        body: JSON.stringify({ type: "extension", id: extension, enabled: true }),
      });
      expect(item(on.body, extension, "extension").enabled).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("rejects unknown resources and invalid requests", async () => {
    const h = await createSettingsHarness();
    try {
      const unknown = await h.json("/api/resources/toggle", {
        method: "POST",
        body: JSON.stringify({ type: "skill", id: join(h.agentDir, "skills", "missing", "SKILL.md"), enabled: false }),
      });
      expect(unknown.status).toBe(404);

      for (const body of [
        { type: "banana", id: "x", enabled: false },
        { type: "skill", id: "", enabled: false },
        { type: "skill", id: "x", enabled: "no" },
      ]) {
        const response = await h.json("/api/resources/toggle", { method: "POST", body: JSON.stringify(body) });
        expect(response.status).toBe(400);
      }

      const badCwd = await h.json<ResourcesView>("/api/resources?cwd=/definitely/not/a/real/directory");
      expect(badCwd.status).toBe(400);
    } finally {
      await h.close();
    }
  });
});
