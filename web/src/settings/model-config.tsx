/**
 * models.json editors for Settings › 模型: a model's fields, a provider's
 * connection, model discovery from the provider's /models endpoint, a new
 * custom provider and the raw file. Each editor builds the next config with
 * ./model-config-lib.ts and hands it to `onSave`, which writes it (the server
 * has pi validate it first) and throws a readable message on failure.
 */
import { Check, ChevronRight, Eye, EyeOff, Plus, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  DiscoveredModel,
  ModelCatalogMatch,
  ModelInfo,
  ModelsConfigView,
  ModelsJson,
  ModelTestResult,
} from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { Button } from "../ui/button.tsx";
import { Select, Spinner } from "./controls.tsx";
import { errorText, formatContextWindow, thinkingLabel } from "./lib.ts";
import {
  API_TYPES,
  COST_KEYS,
  MAPPABLE_LEVELS,
  addModels,
  applyCatalogPreset,
  applyModelDraft,
  applyProviderDraft,
  hasOverride,
  modelDraft,
  modelSource,
  providerDraft,
  removeModel,
  removeProvider,
  renameProvider,
  type HeaderRow,
  type ModelDraft,
  type ProviderDraft,
} from "./model-config-lib.ts";

export type SaveConfig = (next: ModelsJson) => Promise<void>;

const COST_LABELS: Record<(typeof COST_KEYS)[number], string> = {
  input: "输入",
  output: "输出",
  cacheRead: "缓存读取",
  cacheWrite: "缓存写入",
};

function Field({ label, hint, wide, children }: { label: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <label className={wide ? "mc-field is-wide" : "mc-field"}>
      <span className="mc-label">{label}</span>
      {children}
      {hint !== undefined && <span className="mc-hint">{hint}</span>}
    </label>
  );
}

function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="mc-check">
      <input type="checkbox" className="settings-check" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  );
}

export function Disclosure({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" className="mc-disclosure" aria-expanded={open} onClick={onToggle}>
      <ChevronRight size={14} aria-hidden="true" className={open ? "mc-chevron is-open" : "mc-chevron"} />
      {label}
    </button>
  );
}

function HeaderRows({ rows, onChange }: { rows: HeaderRow[]; onChange: (rows: HeaderRow[]) => void }) {
  const update = (index: number, change: Partial<HeaderRow>) => onChange(rows.map((row, at) => (at === index ? { ...row, ...change } : row)));
  return (
    <div className="mc-headers">
      {rows.map((row, index) => (
        <div className="mc-header-row" key={index}>
          <input className="text-input" value={row.name} placeholder="名称" aria-label="请求头名称" onChange={(event) => update(index, { name: event.target.value })} />
          <input className="text-input" value={row.value} placeholder="值（可用 $ENV 或 !命令）" aria-label="请求头的值" onChange={(event) => update(index, { value: event.target.value })} />
          <button type="button" className="icon-btn" aria-label="删除请求头" title="删除请求头" onClick={() => onChange(rows.filter((_, at) => at !== index))}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button type="button" className="settings-text-btn mc-add-row" onClick={() => onChange([...rows, { name: "", value: "" }])}>
        <Plus size={13} aria-hidden="true" />
        添加请求头
      </button>
    </div>
  );
}

function SecretInput({ value, onChange, label, placeholder }: { value: string; onChange: (value: string) => void; label: string; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="provider-key-input">
      <input
        type={shown ? "text" : "password"}
        className="text-input"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      <button type="button" className="icon-btn provider-eye" aria-label={shown ? "隐藏" : "显示"} title={shown ? "隐藏" : "显示"} onClick={() => setShown(!shown)}>
        {shown ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </span>
  );
}

/** Save/test plumbing shared by the editors: one busy flag, one inline error. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, run };
}

// ------------------------------------------------------------------- model

export function ModelEditor({
  config,
  providerId,
  modelId,
  info,
  onSave,
  onClose,
}: {
  config: ModelsJson;
  providerId: string;
  modelId: string;
  /** what pi reports for the model now (absent for a model not loaded yet) */
  info?: ModelInfo;
  onSave: SaveConfig;
  onClose: () => void;
}) {
  // The form compares against the values it opened with, so keep them fixed.
  const [initial] = useState(() => modelDraft(config, providerId, modelId, info));
  const [draft, setDraft] = useState<ModelDraft>(initial);
  const [more, setMore] = useState(initial.headers.length > 0 || initial.compat !== "" || Object.values(initial.thinking).some((row) => row.value || row.unsupported));
  const [test, setTest] = useState<ModelTestResult | "running" | null>(null);
  const { busy, error, setError, run } = useAction();
  const source = modelSource(config, providerId, modelId);
  const overridden = hasOverride(config, providerId, modelId);
  const set = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const build = (): ModelsJson | null => {
    try {
      return applyModelDraft(config, providerId, modelId, draft, initial);
    } catch (cause) {
      setError(errorText(cause));
      return null;
    }
  };

  const save = () => {
    const next = build();
    if (next) void run(async () => {
      await onSave(next);
      onClose();
    });
  };

  const [catalog, setCatalog] = useState<{ match: ModelCatalogMatch; filled: string[]; differing: string[] } | "loading" | { error: string } | null>(null);
  const [beforeFill, setBeforeFill] = useState<ModelDraft | null>(null);

  const fillFromCatalog = async (overwrite: boolean) => {
    const id = (source === "entry" ? draft.id : modelId).trim();
    const entry = config.providers?.[providerId];
    const baseUrl = entry?.models?.find((model) => model.id === modelId)?.baseUrl ?? entry?.baseUrl;
    setCatalog("loading");
    try {
      const match = await api.modelCatalog(id, providerId, baseUrl);
      const result = applyCatalogPreset(draft, match.preset, overwrite);
      if (result.filled.length > 0) {
        setBeforeFill(draft);
        setDraft(result.draft);
      }
      setCatalog({ match, filled: result.filled, differing: result.differing });
    } catch (cause) {
      setCatalog({ error: errorText(cause) });
    }
  };

  const runTest = async () => {
    const next = build();
    if (!next) return;
    setTest("running");
    try {
      setTest(await api.testModel(next, providerId, source === "entry" ? draft.id.trim() || modelId : modelId));
    } catch (cause) {
      setTest({ ok: false, error: errorText(cause) });
    }
  };

  return (
    <div className="mc-form" role="group" aria-label={`编辑 ${modelId}`}>
      <div className="mc-catalog">
        <Button disabled={catalog === "loading"} onClick={() => void fillFromCatalog(false)}>
          {catalog === "loading" ? <Spinner /> : <Sparkles size={14} aria-hidden="true" />}
          从 models.dev 填充
        </Button>
        {beforeFill && (
          <button
            type="button"
            className="settings-text-btn"
            onClick={() => {
              setDraft(beforeFill);
              setBeforeFill(null);
              setCatalog(null);
            }}
          >
            撤销
          </button>
        )}
        {catalog && catalog !== "loading" && <CatalogSummary result={catalog} onOverwrite={() => void fillFromCatalog(true)} />}
      </div>
      <div className="mc-grid">
        {source === "entry" ? (
          <Field label="模型 ID" hint="发送给接口的模型名">
            <input className="text-input mc-mono" value={draft.id} aria-label="模型 ID" onChange={(event) => set("id", event.target.value)} />
          </Field>
        ) : (
          <Field label="模型 ID" hint="内置模型，修改会写入 modelOverrides">
            <input className="text-input mc-mono" value={modelId} aria-label="模型 ID" readOnly />
          </Field>
        )}
        <Field label="显示名称">
          <input className="text-input" value={draft.name} placeholder={modelId} aria-label="显示名称" onChange={(event) => set("name", event.target.value)} />
        </Field>
        <div className="mc-checks is-wide">
          <CheckField label="支持思考" checked={draft.reasoning} onChange={(value) => set("reasoning", value)} />
          <CheckField label="支持图片输入" checked={draft.image} onChange={(value) => set("image", value)} />
        </div>
        <Field label="上下文窗口" hint={draft.contextWindow ? `${formatContextWindow(Number(draft.contextWindow.replace(/\D/g, "")) || 0)} tokens` : "默认 128K"}>
          <input className="text-input" inputMode="numeric" value={draft.contextWindow} placeholder="128000" aria-label="上下文窗口" onChange={(event) => set("contextWindow", event.target.value)} />
        </Field>
        <Field label="最大输出" hint="单次回复的 token 上限，默认 16384">
          <input className="text-input" inputMode="numeric" value={draft.maxTokens} placeholder="16384" aria-label="最大输出" onChange={(event) => set("maxTokens", event.target.value)} />
        </Field>
        <div className="mc-field is-wide">
          <span className="mc-label">价格（美元 / 百万 token，空着算 0）</span>
          <div className="mc-cost">
            {COST_KEYS.map((key) => (
              <label key={key} className="mc-cost-cell">
                <span>{COST_LABELS[key]}</span>
                <input
                  className="text-input"
                  inputMode="decimal"
                  value={draft.cost[key]}
                  aria-label={`${COST_LABELS[key]}价格`}
                  onChange={(event) => set("cost", { ...draft.cost, [key]: event.target.value })}
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      <Disclosure label="更多设置：思考档位映射、请求头、兼容性" open={more} onToggle={() => setMore(!more)} />
      {more && (
        <div className="mc-grid">
          {draft.reasoning && (
            <div className="mc-field is-wide">
              <span className="mc-label">思考档位映射</span>
              <span className="mc-hint">每个档位发给接口的值；留空用 pi 的默认（xhigh、max 默认不支持）</span>
              <div className="mc-levels">
                {MAPPABLE_LEVELS.map((level) => {
                  const row = draft.thinking[level] ?? { value: "", unsupported: false };
                  const update = (change: Partial<typeof row>) => set("thinking", { ...draft.thinking, [level]: { ...row, ...change } });
                  return (
                    <div key={level} className="mc-level">
                      <code>{thinkingLabel(level)}</code>
                      <input
                        className="text-input mc-mono"
                        value={row.value}
                        disabled={row.unsupported}
                        placeholder="默认"
                        aria-label={`${level} 的值`}
                        onChange={(event) => update({ value: event.target.value })}
                      />
                      <CheckField label="不支持" checked={row.unsupported} onChange={(value) => update({ unsupported: value })} />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="mc-field is-wide">
            <span className="mc-label">请求头</span>
            <HeaderRows rows={draft.headers} onChange={(rows) => set("headers", rows)} />
          </div>
          <Field label="兼容性（compat，JSON）" hint="如 {&quot;supportsDeveloperRole&quot;: false}，字段见 pi 文档 models-configuration.md" wide>
            <textarea className="text-input mc-json" value={draft.compat} spellCheck={false} placeholder="{}" aria-label="兼容性 JSON" onChange={(event) => set("compat", event.target.value)} />
          </Field>
        </div>
      )}

      <div className="mc-foot">
        <Button disabled={busy || test === "running"} onClick={() => void runTest()}>
          {test === "running" ? <Spinner /> : <RefreshCw size={14} aria-hidden="true" />}
          测试
        </Button>
        {test && test !== "running" && (
          <span className={test.ok ? "mc-test is-ok" : "mc-test is-error"} title={test.error ?? test.text}>
            {test.ok ? `可用 · ${test.latencyMs ?? 0} ms${test.text ? ` · “${test.text.trim()}”` : ""}` : test.error}
          </span>
        )}
        <span className="mc-grow" />
        {source === "entry" ? (
          <button type="button" className="settings-text-btn is-danger" disabled={busy} onClick={() => void run(async () => onSave(removeModel(config, providerId, modelId)))}>
            删除模型
          </button>
        ) : overridden ? (
          <button type="button" className="settings-text-btn" disabled={busy} onClick={() => void run(async () => { await onSave(removeModel(config, providerId, modelId)); onClose(); })}>
            还原默认
          </button>
        ) : null}
        <Button disabled={busy} onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy && <Spinner />}
          保存
        </Button>
      </div>
      {error && (
        <p className="mc-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const PRICE_NOTES = {
  "no-match": "",
  "no-price": "models.dev 没有它的价格",
  single: "只有一家第三方列出价格，未填写",
  conflict: "各家价格不一致，未填写",
} as const;

/** What a models.dev lookup did, where the numbers came from, and how to apply the rest. */
function CatalogSummary({
  result,
  onOverwrite,
}: {
  result: { match: ModelCatalogMatch; filled: string[]; differing: string[] } | { error: string };
  onOverwrite: () => void;
}) {
  if ("error" in result) return <span className="mc-catalog-note is-error">{result.error}</span>;
  const { match, filled, differing } = result;
  if (match.matches === 0) return <span className="mc-catalog-note">models.dev 里没有这个模型 ID</span>;

  const origin =
    match.matchedBy === "consensus"
      ? `${match.matches} 家提供商列出了它，取多数一致的值`
      : `数据来自 ${match.providerName ?? "同一提供商"}`;
  const price = match.price.reliable
    ? match.price.by === "consensus"
      ? `价格 ${match.price.support}/${match.price.total} 家一致`
      : ""
    : PRICE_NOTES[match.price.reason];
  const done = filled.length > 0 ? `已填充${filled.join("、")}` : differing.length > 0 ? "表单已有值，未改动" : "表单已与 models.dev 一致";

  return (
    <span className="mc-catalog-note" role="status">
      {[done, origin, price].filter(Boolean).join(" · ")}
      {differing.length > 0 && (
        <button type="button" className="settings-text-btn" onClick={onOverwrite}>
          也覆盖{differing.join("、")}
        </button>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- provider

export function ProviderSettings({
  config,
  providerId,
  custom,
  onSave,
}: {
  config: ModelsJson;
  providerId: string;
  /** not a built-in provider: needs baseUrl and api, and can be renamed or deleted */
  custom: boolean;
  /** `id` is the provider's id after the save (a rename moves it) */
  onSave: (next: ModelsJson, id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProviderDraft>(() => providerDraft(config, providerId));
  const [more, setMore] = useState(draft.compat !== "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { busy, error, setError, run } = useAction();
  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const save = () => {
    let next: ModelsJson;
    const id = draft.id.trim();
    try {
      next = custom && id !== providerId ? renameProvider(config, providerId, id) : config;
      next = applyProviderDraft(next, { ...draft, id }, custom);
    } catch (cause) {
      setError(errorText(cause));
      return;
    }
    void run(() => onSave(next, id));
  };

  return (
    <div className="mc-form">
      <div className="mc-grid">
        {custom && (
          <>
            <Field label="提供商 ID" hint="在 models.json 和 --model 里使用">
              <input className="text-input mc-mono" value={draft.id} aria-label="提供商 ID" onChange={(event) => set("id", event.target.value)} />
            </Field>
            <Field label="显示名称">
              <input className="text-input" value={draft.name} placeholder={draft.id} aria-label="提供商显示名称" onChange={(event) => set("name", event.target.value)} />
            </Field>
          </>
        )}
        <Field label="Base URL" hint={custom ? undefined : "留空使用默认地址；填写后内置模型也走这个地址（如代理）"} wide>
          <input
            className="text-input mc-mono"
            value={draft.baseUrl}
            placeholder={custom ? "https://api.example.com/v1" : "默认"}
            aria-label="Base URL"
            onChange={(event) => set("baseUrl", event.target.value)}
          />
        </Field>
        <Field label="API 类型">
          <Select label="API 类型" value={draft.api} onChange={(value) => set("api", value)}>
            {!custom && <option value="">默认</option>}
            {custom && draft.api === "" && (
              <option value="" disabled>
                请选择
              </option>
            )}
            {[...API_TYPES, ...(draft.api && !API_TYPES.includes(draft.api) ? [draft.api] : [])].map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Select>
        </Field>
        {custom && (
          <Field label="API 密钥" hint="可填密钥本身、$环境变量名 或 !命令（取其输出）">
            <SecretInput value={draft.apiKey} label="API 密钥" placeholder="sk-… / $MY_KEY" onChange={(value) => set("apiKey", value)} />
          </Field>
        )}
        <div className="mc-field is-wide">
          <span className="mc-label">请求头</span>
          <HeaderRows rows={draft.headers} onChange={(rows) => set("headers", rows)} />
        </div>
      </div>
      <Disclosure label="兼容性（compat）" open={more} onToggle={() => setMore(!more)} />
      {more && (
        <Field label="兼容性（compat，JSON）" hint="对该提供商的所有模型生效，模型自己的设置优先" wide>
          <textarea className="text-input mc-json" value={draft.compat} spellCheck={false} placeholder="{}" aria-label="提供商兼容性 JSON" onChange={(event) => set("compat", event.target.value)} />
        </Field>
      )}
      <div className="mc-foot">
        {custom &&
          (confirmDelete ? (
            <>
              <span className="mc-test is-error">删除 {providerId} 及其全部模型？</span>
              <button type="button" className="settings-text-btn is-danger" disabled={busy} onClick={() => void run(() => onSave(removeProvider(config, providerId), ""))}>
                确认删除
              </button>
              <button type="button" className="settings-text-btn" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </>
          ) : (
            <button type="button" className="settings-text-btn is-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              删除提供商
            </button>
          ))}
        <span className="mc-grow" />
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy && <Spinner />}
          保存接口设置
        </Button>
      </div>
      {error && (
        <p className="mc-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------- add / discover

export function AddModels({
  config,
  providerId,
  known,
  onSave,
}: {
  config: ModelsJson;
  providerId: string;
  /** model ids the provider already has */
  known: string[];
  onSave: SaveConfig;
}) {
  const [mode, setMode] = useState<"closed" | "discover" | "manual">("closed");
  const [manualId, setManualId] = useState("");
  const [result, setResult] = useState<{ endpoint: string; models: DiscoveredModel[] } | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { busy, error, setError, run } = useAction();

  const discover = () => {
    setMode("discover");
    setResult(null);
    setSelected(new Set());
    void run(async () => setResult(await api.discoverModels(config, providerId)));
  };

  const add = (models: DiscoveredModel[]) =>
    void run(async () => {
      await onSave(addModels(config, providerId, models));
      setMode("closed");
      setManualId("");
    });

  const fresh = result?.models.filter((model) => !known.includes(model.id)) ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = fresh.filter((model) => !needle || model.id.toLowerCase().includes(needle) || model.name?.toLowerCase().includes(needle));

  return (
    <div className="mc-add">
      {mode === "closed" && (
        <div className="mc-foot">
          <Button onClick={discover}>
            <Search size={14} aria-hidden="true" />
            从接口获取模型
          </Button>
          <Button onClick={() => setMode("manual")}>
            <Plus size={14} aria-hidden="true" />
            手动添加模型
          </Button>
        </div>
      )}

      {mode === "manual" && (
        <div className="mc-foot">
          <input
            className="text-input mc-mono"
            autoFocus
            value={manualId}
            placeholder="模型 ID，如 qwen3-coder"
            aria-label="新模型 ID"
            onChange={(event) => setManualId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing && manualId.trim()) add([{ id: manualId.trim() }]);
            }}
          />
          <Button variant="primary" disabled={busy || !manualId.trim()} onClick={() => add([{ id: manualId.trim() }])}>
            添加
          </Button>
          <Button onClick={() => setMode("closed")}>取消</Button>
        </div>
      )}

      {mode === "discover" && (
        <div className="mc-discover">
          {busy && !result ? (
            <p className="provider-hint">
              <Spinner /> 正在获取模型列表…
            </p>
          ) : result ? (
            <>
              <p className="provider-hint">
                {result.endpoint} 返回 {result.models.length} 个模型，其中 {fresh.length} 个尚未添加
              </p>
              {fresh.length > 0 && (
                <>
                  <span className="provider-search">
                    <Search size={14} aria-hidden="true" />
                    <input className="text-input" value={filter} placeholder="筛选" aria-label="筛选模型" onChange={(event) => setFilter(event.target.value)} />
                  </span>
                  <div className="mc-discover-list" role="group" aria-label="可添加的模型">
                    {shown.map((model) => (
                      <label key={model.id} className="mc-discover-item">
                        <input
                          type="checkbox"
                          className="settings-check"
                          checked={selected.has(model.id)}
                          onChange={(event) => {
                            const next = new Set(selected);
                            if (event.target.checked) next.add(model.id);
                            else next.delete(model.id);
                            setSelected(next);
                          }}
                        />
                        <span className="provider-model-id">{model.id}</span>
                        {model.name && <span className="mc-discover-name">{model.name}</span>}
                        {model.contextWindow && <span className="provider-model-window">{formatContextWindow(model.contextWindow)}</span>}
                      </label>
                    ))}
                    {shown.length === 0 && <p className="provider-hint">没有匹配的模型</p>}
                  </div>
                </>
              )}
            </>
          ) : null}
          <div className="mc-foot">
            {result && shown.length > 0 && (
              <button type="button" className="settings-text-btn" onClick={() => setSelected(new Set([...selected, ...shown.map((model) => model.id)]))}>
                全选
              </button>
            )}
            <span className="mc-grow" />
            <Button onClick={() => setMode("closed")}>关闭</Button>
            {result && fresh.length > 0 && (
              <Button variant="primary" disabled={busy || selected.size === 0} onClick={() => add(fresh.filter((model) => selected.has(model.id)))}>
                {busy && <Spinner />}
                添加所选（{selected.size}）
              </Button>
            )}
          </div>
        </div>
      )}
      {error && (
        <p className="mc-error" role="alert">
          {error}
          {mode === "discover" && (
            <button type="button" className="settings-text-btn" onClick={() => { setError(null); discover(); }}>
              重试
            </button>
          )}
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------ new provider

export function NewProviderForm({
  config,
  builtins,
  onCreate,
  onCancel,
}: {
  config: ModelsJson;
  builtins: string[];
  onCreate: (next: ModelsJson, id: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ProviderDraft>({ id: "", name: "", baseUrl: "", api: "openai-completions", apiKey: "", headers: [], compat: "" });
  const { busy, error, setError, run } = useAction();
  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const create = () => {
    const id = draft.id.trim();
    if (builtins.includes(id) || config.providers?.[id]) {
      setError(`提供商 ${id} 已存在${builtins.includes(id) ? "（内置提供商请在上面的列表里编辑）" : ""}`);
      return;
    }
    let next: ModelsJson;
    try {
      next = applyProviderDraft(config, { ...draft, id }, true);
    } catch (cause) {
      setError(errorText(cause));
      return;
    }
    void run(() => onCreate(next, id));
  };

  return (
    <div className="provider-add-panel">
      <p className="provider-hint">添加一个 OpenAI / Anthropic / Google 兼容的接口（本地模型、代理或第三方服务），保存后可以从接口获取模型列表。</p>
      <div className="mc-grid">
        <Field label="提供商 ID">
          <input className="text-input mc-mono" autoFocus value={draft.id} placeholder="my-provider" aria-label="提供商 ID" onChange={(event) => set("id", event.target.value)} />
        </Field>
        <Field label="显示名称">
          <input className="text-input" value={draft.name} placeholder="可选" aria-label="提供商显示名称" onChange={(event) => set("name", event.target.value)} />
        </Field>
        <Field label="Base URL" wide>
          <input className="text-input mc-mono" value={draft.baseUrl} placeholder="http://localhost:11434/v1" aria-label="Base URL" onChange={(event) => set("baseUrl", event.target.value)} />
        </Field>
        <Field label="API 类型">
          <Select label="API 类型" value={draft.api} onChange={(value) => set("api", value)}>
            {API_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="API 密钥" hint="密钥本身、$环境变量名 或 !命令；本地服务可留空">
          <SecretInput value={draft.apiKey} label="API 密钥" placeholder="sk-… / $MY_KEY" onChange={(value) => set("apiKey", value)} />
        </Field>
      </div>
      <div className="mc-foot">
        <span className="mc-grow" />
        <Button onClick={onCancel}>取消</Button>
        <Button variant="primary" disabled={busy || !draft.id.trim()} onClick={create}>
          {busy && <Spinner />}
          创建
        </Button>
      </div>
      {error && (
        <p className="mc-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- raw file

export function RawModelsJson({ view, onSave }: { view: ModelsConfigView; onSave: SaveConfig }) {
  const original = view.text ?? `${JSON.stringify(view.config, null, 2)}\n`;
  const [text, setText] = useState(original);
  const { busy, error, setError, run } = useAction();

  // Follow saves made by the other editors while this one has no edits.
  const lastOriginal = useRef(original);
  useEffect(() => {
    if (text === lastOriginal.current) setText(original);
    lastOriginal.current = original;
  }, [original]);

  const save = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      setError(`不是有效的 JSON：${errorText(cause)}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setError("顶层必须是 JSON 对象");
      return;
    }
    void run(() => onSave(parsed as ModelsJson));
  };

  return (
    <div className="mc-form">
      <p className="provider-hint">
        {view.path} · 保存前会先让 pi 加载校验，字段说明见 pi 文档 models-configuration.md
      </p>
      <textarea className="text-input mc-json mc-raw" value={text} spellCheck={false} aria-label="models.json" onChange={(event) => setText(event.target.value)} />
      <div className="mc-foot">
        {text !== original && (
          <button type="button" className="settings-text-btn" onClick={() => setText(original)}>
            放弃修改
          </button>
        )}
        <span className="mc-grow" />
        <Button variant="primary" disabled={busy || text === original} onClick={save}>
          {busy ? <Spinner /> : <Check size={14} aria-hidden="true" />}
          保存
        </Button>
      </div>
      {error && (
        <p className="mc-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
