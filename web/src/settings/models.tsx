/** Settings › 模型: default model, provider cards, API keys, enabled models. */
import { Brain, Eye, EyeOff, Image as ImageIcon, Plus, Search } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ModelInfo, ProviderView, ProvidersView, ThinkingLevel } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { Button } from "../ui/button.tsx";
import { ConfirmDialog } from "../ui/confirm.tsx";
import { toast } from "../ui/toasts.tsx";
import { SettingsRow, Select, Spinner } from "./controls.tsx";
import { authSourceLabel, errorText, formatContextWindow, groupProviders, matchesQuery, THINKING_LEVELS, thinkingLabel, toggleEnabledModel } from "./lib.ts";

const keyOf = (provider: string, model: string) => `${provider}/${model}`;

export function ModelsSection({ onModelsChanged }: { onModelsChanged: () => void }) {
  const [view, setView] = useState<ProvidersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ProviderView | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addQuery, setAddQuery] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      setView(await api.providers());
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setKeyValue("");
    setShowKey(false);
  }, [openId]);

  const apply = (next: ProvidersView) => {
    setView(next);
    onModelsChanged();
  };

  const setDefaultModel = async (modelKey: string) => {
    const slash = modelKey.indexOf("/");
    if (slash < 0) return;
    setBusy(true);
    try {
      apply(await api.setDefaultModel({ provider: modelKey.slice(0, slash), id: modelKey.slice(slash + 1) }));
    } catch (cause) {
      toast(errorText(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const setDefaultThinking = async (level: ThinkingLevel) => {
    if (!view?.defaultModel) return;
    setBusy(true);
    try {
      apply(await api.setDefaultModel({ ...view.defaultModel, thinkingLevel: level }));
    } catch (cause) {
      toast(errorText(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (provider: ProviderView) => {
    const value = keyValue.trim();
    if (!value) return;
    setBusy(true);
    try {
      apply(await api.setProviderKey(provider.id, value));
      setKeyValue("");
      toast(`已保存 ${provider.name} 的 API 密钥`);
    } catch (cause) {
      toast(errorText(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    const provider = removeTarget;
    setRemoveTarget(null);
    if (!provider) return;
    setBusy(true);
    try {
      apply(await api.removeProviderKey(provider.id));
      toast(`已移除 ${provider.name} 的 API 密钥`);
    } catch (cause) {
      toast(errorText(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const allKeys = view
    ? view.providers.filter((provider) => provider.configured).flatMap((provider) =>
        provider.models.map((model) => keyOf(provider.id, model.id)),
      )
    : [];

  const setModelEnabled = async (modelKey: string, enabled: boolean) => {
    if (!view) return;
    const next = toggleEnabledModel(view.enabledModels, allKeys, modelKey, enabled);
    if (next === view.enabledModels) return;
    const before = view;
    setView({ ...view, enabledModels: next });
    setBusy(true);
    try {
      apply(await api.setEnabledModels(next));
    } catch (cause) {
      setView(before);
      toast(errorText(cause), "error");
    } finally {
      setBusy(false);
    }
  };

  const renderModel = (provider: ProviderView, model: ModelInfo) => {
    const modelKey = keyOf(provider.id, model.id);
    const enabled = view?.enabledModels === null || view?.enabledModels?.includes(modelKey) === true;
    const isDefault = view?.defaultModel?.provider === provider.id && view?.defaultModel?.id === model.id;
    return (
      <div className="provider-model" key={modelKey}>
        <div className="provider-model-text">
          <span className="provider-model-name">{model.name}</span>
          <span className="provider-model-id">{model.id}</span>
        </div>
        <span className="provider-model-caps">
          {model.vision && (
            <span title="支持图片">
              <ImageIcon size={14} aria-hidden="true" />
            </span>
          )}
          {model.reasoning && (
            <span title="支持思考">
              <Brain size={14} aria-hidden="true" />
            </span>
          )}
        </span>
        <span className="provider-model-window" title={`${model.contextWindow.toLocaleString("en-US")} tokens`}>
          {formatContextWindow(model.contextWindow)}
        </span>
        <input
          type="checkbox"
          className="settings-check"
          checked={enabled}
          disabled={busy}
          aria-label={`启用 ${model.name}`}
          onChange={(event) => void setModelEnabled(modelKey, event.target.checked)}
        />
        {isDefault ? (
          <span className="provider-tag is-default">默认</span>
        ) : (
          <button
            type="button"
            className="settings-text-btn"
            disabled={busy}
            onClick={() => void setDefaultModel(modelKey)}
          >
            设为默认
          </button>
        )}
      </div>
    );
  };

  const renderProvider = (provider: ProviderView) => {
    const open = openId === provider.id;
    return (
      <div className="provider-card" key={provider.id}>
        <div className="provider-head">
          <span className="provider-name">{provider.name}</span>
          <span className={provider.configured ? "provider-dot is-on" : "provider-dot"} aria-hidden="true" />
          <span className="provider-tag">{authSourceLabel(provider.authSource)}</span>
          <Button
            className="provider-edit"
            aria-expanded={open}
            onClick={() => setOpenId(open ? null : provider.id)}
          >
            {open ? "收起" : "编辑"}
          </Button>
        </div>
        {open && (
          <div className="provider-body">
            {provider.supportsApiKey ? (
              <>
                <div className="provider-key-row">
                  <span className="provider-key-input">
                    <input
                      type={showKey ? "text" : "password"}
                      className="text-input"
                      value={keyValue}
                      placeholder={provider.configured ? "留空则保持已保存的密钥" : "API 密钥"}
                      aria-label={`${provider.name} API 密钥`}
                      autoComplete="off"
                      onChange={(event) => setKeyValue(event.target.value)}
                    />
                    <button
                      type="button"
                      className="icon-btn provider-eye"
                      aria-label={showKey ? "隐藏密钥" : "显示密钥"}
                      title={showKey ? "隐藏密钥" : "显示密钥"}
                      onClick={() => setShowKey((value) => !value)}
                    >
                      {showKey ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                    </button>
                  </span>
                  <Button
                    variant="primary"
                    disabled={busy || keyValue.trim() === ""}
                    onClick={() => void saveKey(provider)}
                  >
                    {busy && <Spinner />}
                    保存
                  </Button>
                  {provider.authSource === "stored" && (
                    <button
                      type="button"
                      className="settings-text-btn is-danger"
                      disabled={busy}
                      onClick={() => setRemoveTarget(provider)}
                    >
                      移除密钥
                    </button>
                  )}
                </div>
                {provider.envVars.length > 0 && (
                  <p className="provider-hint">也可以设置环境变量 {provider.envVars.join(" 或 ")}</p>
                )}
              </>
            ) : provider.supportsOAuth ? (
              <p className="provider-hint">
                该提供商使用 OAuth 登录，请在终端运行 <code>pi</code> 后输入 /login 完成。
              </p>
            ) : (
              <p className="provider-hint">该提供商暂不支持在网页中配置。</p>
            )}

            {provider.configured && provider.models.length > 0 && (
              <div className="provider-models">{provider.models.map((model) => renderModel(provider, model))}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (view === null) {
    return error !== null ? (
      <div className="settings-error">
        <span>{error}</span>
        <Button onClick={() => void load()}>重试</Button>
      </div>
    ) : (
      <div className="settings-loading">
        <Spinner />
        <span>正在加载模型…</span>
      </div>
    );
  }

  const configured = groupProviders(view.providers).filter((provider) => provider.configured);
  const defaultKey = view.defaultModel ? keyOf(view.defaultModel.provider, view.defaultModel.id) : "";
  const openProvider = view.providers.find((provider) => provider.id === openId);
  const pending = openProvider && !openProvider.configured ? openProvider : null;
  const candidates = view.providers.filter(
    (provider) => !provider.configured && matchesQuery([provider.name, provider.id], addQuery),
  );

  return (
    <>
      <div className="settings-page-head">
        <h3>模型</h3>
        <p>填入各提供商的 API 密钥即可使用其模型。</p>
      </div>

      <SettingsRow title="默认模型">
        <Select label="默认模型" value={defaultKey} disabled={busy} onChange={(value) => void setDefaultModel(value)}>
          {defaultKey === "" && (
            <option value="" disabled>
              未设置
            </option>
          )}
          {defaultKey !== "" && !configured.some((provider) => provider.models.some((model) => keyOf(provider.id, model.id) === defaultKey)) && (
            <option value={defaultKey}>{defaultKey}</option>
          )}
          {configured.map((provider) => (
            <optgroup key={provider.id} label={provider.name}>
              {provider.models.map((model) => (
                <option key={model.id} value={keyOf(provider.id, model.id)}>
                  {model.name}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <Select
          label="默认思考档位"
          value={view.defaultThinkingLevel}
          disabled={busy || !view.defaultModel}
          onChange={(value) => void setDefaultThinking(value as ThinkingLevel)}
        >
          {THINKING_LEVELS.map((level) => (
            <option key={level} value={level}>
              {thinkingLabel(level)}
            </option>
          ))}
        </Select>
      </SettingsRow>

      <div className="provider-list">
        {configured.map(renderProvider)}
        {pending && renderProvider(pending)}
      </div>

      {addOpen ? (
        <div className="provider-add-panel">
          <span className="provider-search">
            <Search size={14} aria-hidden="true" />
            <input
              className="text-input"
              autoFocus
              value={addQuery}
              placeholder="搜索提供商"
              aria-label="搜索提供商"
              onChange={(event) => setAddQuery(event.target.value)}
            />
          </span>
          <div className="provider-add-list">
            {candidates.length === 0 ? (
              <p className="provider-hint">没有可添加的提供商</p>
            ) : (
              candidates.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className="provider-add-item"
                  onClick={() => {
                    setOpenId(provider.id);
                    setAddOpen(false);
                    setAddQuery("");
                  }}
                >
                  <span className="provider-name">{provider.name}</span>
                  <span className="provider-tag">{authSourceLabel(provider.authSource)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : (
        <button type="button" className="settings-add-btn" onClick={() => setAddOpen(true)}>
          <Plus size={15} aria-hidden="true" />
          添加模型提供商
        </button>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        title="移除密钥"
        message={removeTarget ? `移除 ${removeTarget.name} 的 API 密钥？` : undefined}
        confirmLabel="移除"
        danger
        onConfirm={() => void removeKey()}
        onCancel={() => setRemoveTarget(null)}
      />
    </>
  );
}
