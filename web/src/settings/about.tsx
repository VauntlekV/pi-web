/** Settings › 关于: versions, directories and the settings.json path. */
import { useCallback, useEffect, useState } from "react";
import type { ConfigResponse, SettingsView } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { Button } from "../ui/button.tsx";
import { CopyButton, SettingsRow } from "./controls.tsx";
import { errorText } from "./lib.ts";

export function AboutSection({ config }: { config: ConfigResponse }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setSettings(await api.settings());
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <SettingsRow title="pi-web 版本">
        <span className="settings-value">{config.version}</span>
      </SettingsRow>
      <SettingsRow title="pi 版本">
        <span className="settings-value">{config.piVersion}</span>
      </SettingsRow>
      <SettingsRow title="数据目录">
        <span className="settings-path">{settings?.agentDir ?? (error === null ? "…" : "—")}</span>
      </SettingsRow>
      <SettingsRow title="settings.json">
        {settings ? (
          <>
            <span className="settings-path">{settings.settingsFile}</span>
            <CopyButton text={settings.settingsFile} label="复制 settings.json 路径" />
          </>
        ) : (
          <span className="settings-path">{error === null ? "…" : "—"}</span>
        )}
      </SettingsRow>
      <SettingsRow title="默认工作区">
        <span className="settings-path">{config.defaultCwd}</span>
      </SettingsRow>

      {error !== null && (
        <div className="settings-error">
          <span>{error}</span>
          <Button onClick={() => void load()}>重试</Button>
        </div>
      )}
    </>
  );
}
