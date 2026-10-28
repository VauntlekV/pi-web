import { readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  DefaultPackageManager,
  parseFrontmatter,
  SettingsManager,
  type PackageSource,
  type PathMetadata,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import type { PackageView, ResourceItem, ResourceToggleRequest, ResourceType, ResourcesView } from "../../shared/protocol.ts";
import type { AppDeps } from "../app.ts";
import { HttpError } from "../http-error.ts";

/** The built-in extensions pi-web sessions load; llama.cpp is not loaded by pi-web sessions. */
const BUILTIN_EXTENSION_NAMES = ["codemode", "tool-search", "mcp"];

const RESOURCE_TYPES: ResourceType[] = ["extension", "skill", "prompt", "theme"];
const ARRAY_KEYS: Record<ResourceType, "extensions" | "skills" | "prompts" | "themes"> = {
  extension: "extensions",
  skill: "skills",
  prompt: "prompts",
  theme: "themes",
};

interface Entry {
  item: ResourceItem;
  metadata: PathMetadata;
}

interface ResolvedResources {
  manager: SettingsManager;
  cwd: string;
  view: ResourcesView;
  entries: Map<string, Entry>;
}

export async function readResources(deps: AppDeps, cwdParam?: string): Promise<ResourcesView> {
  return (await resolveResources(deps, cwdParam)).view;
}

export async function toggleResource(deps: AppDeps, body: Record<string, unknown>): Promise<ResourcesView> {
  const request: ResourceToggleRequest = {
    type: body.type as ResourceType,
    id: body.id as string,
    enabled: body.enabled as boolean,
    ...(body.cwd === undefined ? {} : { cwd: body.cwd as string }),
  };
  if (!RESOURCE_TYPES.includes(request.type)) throw new HttpError(400, "type 必须是 extension、skill、prompt 或 theme");
  if (typeof request.id !== "string" || request.id.trim() === "" || request.id.length > 4096) {
    throw new HttpError(400, "id 必须是非空字符串");
  }
  if (typeof request.enabled !== "boolean") throw new HttpError(400, "enabled 必须是布尔值");

  const { manager, cwd, entries } = await resolveResources(deps, request.cwd);
  const entry = entries.get(`${request.type}:${request.id}`);
  if (!entry) throw new HttpError(404, "资源不存在");

  if (entry.metadata.origin === "package") togglePackageResource(manager, cwd, deps.agentDir, entry, request.enabled);
  else toggleTopLevelResource(manager, cwd, deps.agentDir, entry, request.enabled);
  await manager.flush();

  return (await resolveResources(deps, cwd)).view;
}

// ------------------------------------------------------------------ resolve

async function resolveResources(deps: AppDeps, cwdParam?: string): Promise<ResolvedResources> {
  const cwd = resolveCwd(deps, cwdParam);
  const manager = SettingsManager.create(cwd, deps.agentDir);
  const packageManager = new DefaultPackageManager({
    cwd,
    agentDir: deps.agentDir,
    settingsManager: manager,
    builtinExtensions: BUILTIN_EXTENSION_NAMES,
  });
  // Skip (do not install) packages that are configured but not installed; a GET must not run npm.
  const resolved = await packageManager.resolve(async () => "skip");

  const diagnostics: string[] = [];
  const entries = new Map<string, Entry>();
  const items: ResourceItem[] = [];

  for (const type of RESOURCE_TYPES) {
    const resources: ResolvedResource[] = resolved[ARRAY_KEYS[type]];
    for (const resource of resources) {
      const described = describeResource(type, resource.path, diagnostics);
      const origin = resourceOrigin(resource.metadata);
      const item: ResourceItem = {
        type,
        id: resource.path,
        name: described.name,
        ...(described.description === undefined ? {} : { description: described.description }),
        ...(resource.path.startsWith("builtin:") ? {} : { path: resource.path }),
        origin,
        ...(origin === "package" ? { packageSource: resource.metadata.source } : {}),
        enabled: resource.enabled,
      };
      entries.set(`${type}:${resource.path}`, { item, metadata: resource.metadata });
      items.push(item);
    }
  }

  const packages: PackageView[] = packageManager.listConfiguredPackages().map((pkg) => {
    const baseDir = packageBaseDir(pkg.scope, cwd, deps.agentDir);
    const counts: PackageView["counts"] = {};
    for (const entry of entries.values()) {
      if (entry.item.origin !== "package") continue;
      const sourceBase = packageBaseDir(entry.metadata.scope === "project" ? "project" : "user", cwd, deps.agentDir);
      if (!sameSource(pkg.source, baseDir, entry.metadata.source, sourceBase)) continue;
      counts[entry.item.type] = (counts[entry.item.type] ?? 0) + 1;
    }
    return {
      source: pkg.source,
      scope: pkg.scope,
      ...(pkg.installedPath === undefined ? {} : { installedPath: pkg.installedPath }),
      filtered: pkg.filtered,
      counts,
    };
  });

  return { manager, cwd, entries, view: { cwd, packages, items, diagnostics } };
}

function resolveCwd(deps: AppDeps, value: unknown): string {
  if (value !== undefined && typeof value !== "string") throw new HttpError(400, "cwd 必须是字符串");
  const requested = (typeof value === "string" ? value.trim() : "") || deps.defaultCwd;
  const resolved = isAbsolute(requested) ? requested : resolve(deps.defaultCwd, requested);
  try {
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new HttpError(400, "目录不存在");
  }
  return resolved;
}

function resourceOrigin(metadata: PathMetadata): ResourceItem["origin"] {
  if (metadata.origin === "package") return "package";
  if (metadata.source === "builtin") return "builtin";
  if (metadata.scope === "project") return "project";
  return "user";
}

// ----------------------------------------------------------------- describe

function describeResource(
  type: ResourceType,
  path: string,
  diagnostics: string[],
): { name: string; description?: string } {
  switch (type) {
    case "extension":
      return { name: extensionName(path) };
    case "skill":
      return describeSkill(path, diagnostics);
    case "prompt":
      return describePrompt(path, diagnostics);
    case "theme":
      return { name: basename(path).replace(/\.json$/i, "") };
  }
}

/** `builtin:name`; `index.ts` in a folder is named after the folder; other files lose their extension. */
function extensionName(path: string): string {
  if (path.startsWith("builtin:")) return path.slice("builtin:".length);
  const fileName = basename(path);
  if (/^index\.(?:ts|js|mjs|cjs)$/i.test(fileName)) return basename(dirname(path));
  return fileName.replace(/\.[^.]+$/, "");
}

/** Mirrors the SDK skill loader: name from frontmatter or the skill folder, description required. */
function describeSkill(path: string, diagnostics: string[]): { name: string; description?: string } {
  const fallback = { name: basename(dirname(path)) };
  const text = readResourceText(path, diagnostics);
  if (text === undefined) return fallback;
  try {
    const { frontmatter } = parseFrontmatter(text);
    const name = typeof frontmatter.name === "string" && frontmatter.name.trim() !== ""
      ? frontmatter.name
      : fallback.name;
    const description = typeof frontmatter.description === "string" ? frontmatter.description : undefined;
    return description === undefined || description.trim() === "" ? { name } : { name, description };
  } catch (error) {
    diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return fallback;
  }
}

/** Mirrors the SDK prompt loader: file name is the command name. */
function describePrompt(path: string, diagnostics: string[]): { name: string; description?: string } {
  const name = basename(path).replace(/\.md$/, "");
  const text = readResourceText(path, diagnostics);
  if (text === undefined) return { name };
  try {
    const { frontmatter, body } = parseFrontmatter(text);
    if (typeof frontmatter.description === "string" && frontmatter.description.trim() !== "") {
      return { name, description: frontmatter.description };
    }
    const firstLine = body.split("\n").find((line) => line.trim() !== "");
    if (!firstLine) return { name };
    const trimmed = firstLine.trim();
    return { name, description: trimmed.length > 60 ? `${trimmed.slice(0, 60)}...` : trimmed };
  } catch (error) {
    diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { name };
  }
}

function readResourceText(path: string, diagnostics: string[]): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    diagnostics.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// ------------------------------------------------------------------- toggle

function toggleTopLevelResource(
  manager: SettingsManager,
  cwd: string,
  agentDir: string,
  entry: Entry,
  enabled: boolean,
): void {
  const type = entry.item.type;
  const current = readResourcePaths(manager, type);
  const pattern = topLevelPattern(entry, cwd, agentDir);
  const updated = current.filter((path) => stripModifier(path) !== pattern);
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  writeResourcePaths(manager, type, updated);
}

/** Same patterns as `pi config`: `builtin:<name>`, a path relative to the settings base dir, or an absolute project path. */
function topLevelPattern(entry: Entry, cwd: string, agentDir: string): string {
  if (entry.metadata.source === "builtin") return entry.item.id;
  const scope = entry.metadata.scope === "project" ? "project" : "user";
  if (scope === "project") return entry.item.id;
  const baseDir = entry.metadata.baseDir ?? agentDir;
  return relative(baseDir, entry.item.id);
}

function togglePackageResource(
  manager: SettingsManager,
  cwd: string,
  agentDir: string,
  entry: Entry,
  enabled: boolean,
): void {
  const packages: PackageSource[] = [...(manager.getGlobalSettings().packages ?? [])];
  const itemScope = entry.metadata.scope === "project" ? "project" : "user";
  const index = packages.findIndex((pkg) =>
    sameSource(
      typeof pkg === "string" ? pkg : pkg.source,
      agentDir,
      entry.metadata.source,
      packageBaseDir(itemScope, cwd, agentDir),
    ));
  if (index === -1) throw new HttpError(400, "该资源来自项目设置中的包，无法在用户设置中切换");

  let pkg = packages[index];
  if (typeof pkg === "string") pkg = { source: pkg };
  const key = ARRAY_KEYS[entry.item.type];
  const pattern = relative(entry.metadata.baseDir ?? dirname(entry.item.id), entry.item.id);
  const updated = (pkg[key] ?? []).filter((path) => stripModifier(path) !== pattern);
  updated.push(`${enabled ? "+" : "-"}${pattern}`);
  pkg[key] = updated.length > 0 ? updated : undefined;
  const hasFilters = (Object.values(ARRAY_KEYS) as string[]).some((name) => (pkg as Record<string, unknown>)[name] !== undefined);
  packages[index] = hasFilters ? pkg : pkg.source;
  manager.setPackages(packages);
}

function readResourcePaths(manager: SettingsManager, type: ResourceType): string[] {
  switch (type) {
    case "extension":
      return manager.getExtensionPaths();
    case "skill":
      return manager.getSkillPaths();
    case "prompt":
      return manager.getPromptTemplatePaths();
    case "theme":
      return manager.getThemePaths();
  }
}

function writeResourcePaths(manager: SettingsManager, type: ResourceType, paths: string[]): void {
  switch (type) {
    case "extension":
      manager.setExtensionPaths(paths);
      return;
    case "skill":
      manager.setSkillPaths(paths);
      return;
    case "prompt":
      manager.setPromptTemplatePaths(paths);
      return;
    case "theme":
      manager.setThemePaths(paths);
      return;
  }
}

function stripModifier(path: string): string {
  return path.startsWith("!") || path.startsWith("+") || path.startsWith("-") ? path.slice(1) : path;
}

// ------------------------------------------------------------------ sources

function packageBaseDir(scope: "user" | "project", cwd: string, agentDir: string): string {
  return scope === "project" ? join(cwd, ".pi") : agentDir;
}

function sameSource(leftSource: string, leftBase: string, rightSource: string, rightBase: string): boolean {
  if (leftSource === rightSource) return true;
  if (!isLocalSource(leftSource) || !isLocalSource(rightSource)) return false;
  return resolve(leftBase, leftSource) === resolve(rightBase, rightSource);
}

function isLocalSource(source: string): boolean {
  return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../") ||
    source.startsWith("/") || source.startsWith("~/");
}
