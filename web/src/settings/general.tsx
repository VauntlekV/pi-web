/** Settings › 通用设置: browser prefs (instant) and pi's settings.json (saved). */
import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { GeneralSettings, SettingsView } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { setPrefs, usePrefs, type Prefs } from "../app/prefs.ts";
import { Button } from "../ui/button.tsx";
import { SettingsGroup, SettingsRow, Select, Spinner, Switch } from "./controls.tsx";
import { errorText, THINKING_LEVELS, thinkingLabel } from "./lib.ts";

const THEMES: { value: Prefs["theme"]; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "system", label: "跟随系统", icon: Monitor },
];

const STEP_DISPLAY: { value: Prefs["stepDisplay"]; label: string }[] = [
  { value: "detailed", label: "详细" },
  { value: "compact", label: "简洁" },
];

const STEP_COLLAPSE: { value: Prefs["stepCollapse"]; label: string }[] = [
  { value: "afterAnswer", label: "回答结束后" },
  { value: "always", label: "始终收起" },
  { value: "never", label: "从不收起" },
];

const BUSY_SEND: { value: Prefs["busySend"]; label: string }[] = [
  { value: "followUp", label: "排队发送" },
  { value: "steer", label: "插话" },
];

const DELIVERY: { value: GeneralSettings["steeringMode"]; label: string }[] = [
  { value: "one-at-a-time", label: "逐条" },
  { value: "all", label: "全部" },
];

const TRUST: { value: GeneralSettings["defaultProjectTrust"]; label: string }[] = [
  { value: "ask", label: "询问" },
  { value: "always", label: "总是信任" },
  { value: "never", label: "从不" },
];

export function GeneralSection() {
  const prefs = usePrefs();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [fontDraft, setFontDraft] = useState(String(prefs.fontSize));

  useEffect(() => setFontDraft(String(prefs.fontSize)), [prefs.fontSize]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setSettings(await api.settings());
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (change: Partial<GeneralSettings>) => {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, general: { ...settings.general, ...change } });
    setSaveError(null);
    setSaving(true);
    try {
      setSettings(await api.updateSettings(change));
    } catch (error) {
      setSettings(before);
      setSaveError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const commitFontSize = () => {
    const parsed = Number(fontDraft);
    const clamped = Math.min(20, Math.max(13, Math.round(Number.isFinite(parsed) && parsed > 0 ? parsed : prefs.fontSize)));
    setFontDraft(String(clamped));
    if (clamped !== prefs.fontSize) setPrefs({ fontSize: clamped });
  };

  return (
    <>
      <SettingsGroup title="界面">
        <SettingsRow title="外观" block>
          <div className="settings-choices" role="radiogroup" aria-label="外观">
            {THEMES.map((theme) => {
              const Icon = theme.icon;
              const active = prefs.theme === theme.value;
              return (
                <button
                  key={theme.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={active ? "settings-choice is-active" : "settings-choice"}
                  onClick={() => setPrefs({ theme: theme.value })}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{theme.label}</span>
                </button>
              );
            })}
          </div>
        </SettingsRow>

        <SettingsRow title="字号大小" description="仅影响会话内容的字号">
          <span className="settings-number">
            <input
              type="number"
              min={13}
              max={20}
              value={fontDraft}
              aria-label="字号大小"
              onChange={(event) => setFontDraft(event.target.value)}
              onBlur={commitFontSize}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitFontSize();
                }
              }}
            />
            <span>px</span>
          </span>
        </SettingsRow>

        <SettingsRow title="工作步骤展示" description="选择希望看到多少工具调用细节">
          <Select
            label="工作步骤展示"
            value={prefs.stepDisplay}
            onChange={(value) => setPrefs({ stepDisplay: value as Prefs["stepDisplay"] })}
          >
            {STEP_DISPLAY.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </SettingsRow>

        <SettingsRow title="工作步骤收起时机" description="选择何时自动收起工作步骤">
          <Select
            label="工作步骤收起时机"
            value={prefs.stepCollapse}
            onChange={(value) => setPrefs({ stepCollapse: value as Prefs["stepCollapse"] })}
          >
            {STEP_COLLAPSE.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </SettingsRow>

        <SettingsRow
          title="繁忙时的发送行为"
          description="智能体运行时 Enter 键和发送按钮的行为；Cmd/Ctrl+Enter 使用另一种"
        >
          <Select
            label="繁忙时的发送行为"
            value={prefs.busySend}
            onChange={(value) => setPrefs({ busySend: value as Prefs["busySend"] })}
          >
            {BUSY_SEND.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </SettingsRow>

        <SettingsRow title="对话导航" description="在对话右侧显示每一轮的导航">
          <Switch label="对话导航" checked={prefs.turnNav} onChange={(turnNav) => setPrefs({ turnNav })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title="代理行为">
        {loadError ? (
          <div className="settings-error">
            <span>{loadError}</span>
            <Button onClick={() => void load()}>重试</Button>
          </div>
        ) : settings === null ? (
          <div className="settings-loading">
            <Spinner />
            <span>正在加载设置…</span>
          </div>
        ) : (
          <>
            {saveError !== null && <p className="settings-error-line">{saveError}</p>}

            <SettingsRow title="默认思考档位">
              <Select
                label="默认思考档位"
                value={settings.general.defaultThinkingLevel}
                disabled={saving}
                onChange={(value) => void patch({ defaultThinkingLevel: value as GeneralSettings["defaultThinkingLevel"] })}
              >
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {thinkingLabel(level)}
                  </option>
                ))}
              </Select>
            </SettingsRow>

            <SettingsRow title="插话消息投递">
              <Select
                label="插话消息投递"
                value={settings.general.steeringMode}
                disabled={saving}
                onChange={(value) => void patch({ steeringMode: value as GeneralSettings["steeringMode"] })}
              >
                {DELIVERY.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </SettingsRow>

            <SettingsRow title="排队消息投递">
              <Select
                label="排队消息投递"
                value={settings.general.followUpMode}
                disabled={saving}
                onChange={(value) => void patch({ followUpMode: value as GeneralSettings["followUpMode"] })}
              >
                {DELIVERY.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </SettingsRow>

            <SettingsRow title="自动压缩上下文">
              <Switch
                label="自动压缩上下文"
                checked={settings.general.compactionEnabled}
                disabled={saving}
                onChange={(compactionEnabled) => void patch({ compactionEnabled })}
              />
            </SettingsRow>

            <SettingsRow title="出错自动重试">
              <Switch
                label="出错自动重试"
                checked={settings.general.retryEnabled}
                disabled={saving}
                onChange={(retryEnabled) => void patch({ retryEnabled })}
              />
            </SettingsRow>

            <SettingsRow title="技能命令 /skill:name">
              <Switch
                label="技能命令 /skill:name"
                checked={settings.general.enableSkillCommands}
                disabled={saving}
                onChange={(enableSkillCommands) => void patch({ enableSkillCommands })}
              />
            </SettingsRow>

            <SettingsRow title="隐藏思考内容">
              <Switch
                label="隐藏思考内容"
                checked={settings.general.hideThinkingBlock}
                disabled={saving}
                onChange={(hideThinkingBlock) => void patch({ hideThinkingBlock })}
              />
            </SettingsRow>

            <SettingsRow title="项目信任默认" description="打开新项目时是否加载其 .pi 下的扩展与设置">
              <Select
                label="项目信任默认"
                value={settings.general.defaultProjectTrust}
                disabled={saving}
                onChange={(value) => void patch({ defaultProjectTrust: value as GeneralSettings["defaultProjectTrust"] })}
              >
                {TRUST.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </SettingsRow>

            <p className="settings-note">
              这些设置写入 <code>{settings.settingsFile}</code>，与 pi CLI 共用；新会话生效，已打开的会话需重新加载。
            </p>
          </>
        )}
      </SettingsGroup>
    </>
  );
}
