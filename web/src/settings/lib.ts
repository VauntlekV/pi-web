/**
 * Pure helpers for the settings dialog and the plugins page. No React, no DOM.
 */
import type {
  ProviderView,
  ResourceItem,
  ResourcesView,
  ThinkingLevel,
} from "../../../shared/protocol.ts";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export { thinkingLabel } from "../composer/lib.ts";

export function authSourceLabel(source: ProviderView["authSource"]): string {
  switch (source) {
    case "stored":
      return "已保存密钥";
    case "env":
      return "环境变量";
    case "config":
      return "配置文件";
    case "oauth":
      return "OAuth";
    default:
      return "未配置";
  }
}

export const ORIGIN_LABELS: Record<ResourceItem["origin"], string> = {
  builtin: "内置",
  package: "包",
  user: "用户",
  project: "项目",
};

/**
 * Enabled-model patterns as stored by pi (`enabledModels`), where `null` means
 * every available model. Turning a model off expands `null` into an explicit
 * list; turning the last missing model back on collapses to `null` again.
 */
export function toggleEnabledModel(
  enabled: string[] | null,
  all: string[],
  key: string,
  on: boolean,
): string[] | null {
  const every = [...new Set(all)];
  const current = enabled === null ? every : [...new Set(enabled)];
  // A key that is not part of the available set cannot change the answer.
  if (!every.includes(key)) return enabled === null ? null : current;
  const next = new Set(current);
  if (on) next.add(key);
  else next.delete(key);
  return every.every((candidate) => next.has(candidate)) ? null : [...next];
}

/** 200000 → "200K", 1048576 → "1M", 0 → "—". */
export function formatContextWindow(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "—";
  if (tokens >= 1_000_000) {
    const millions = Math.round((tokens / 1_000_000) * 10) / 10;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(Math.round(tokens));
}

/** Configured providers first; relative order inside each group is kept. */
export function groupProviders(providers: ProviderView[]): ProviderView[] {
  return [...providers].sort((a, b) => Number(b.configured) - Number(a.configured));
}

export function matchesQuery(texts: (string | undefined)[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return texts.some((text) => (text ?? "").toLowerCase().includes(needle));
}

function matchResource(item: ResourceItem, query: string): boolean {
  return matchesQuery(
    [item.name, item.description, item.path, item.packageSource, ORIGIN_LABELS[item.origin], item.id],
    query,
  );
}

/** Filter the resources view by a free-text query (name / description / source). */
export function filterResources(view: ResourcesView, query: string): ResourcesView {
  if (!query.trim()) return view;
  return {
    ...view,
    items: view.items.filter((item) => matchResource(item, query)),
    packages: view.packages.filter((pkg) =>
      matchesQuery([pkg.source, pkg.scope === "user" ? "用户" : "项目", pkg.installedPath], query),
    ),
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
