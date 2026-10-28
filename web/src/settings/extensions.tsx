/** Settings › 扩展与技能: a summary of what is loaded, with a link to the plugins page. */
import { useCallback, useEffect, useState } from "react";
import type { ResourcesView } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { navigate } from "../app/router.ts";
import { closeSettings } from "../app/ui-store.ts";
import { Button } from "../ui/button.tsx";
import { Spinner } from "./controls.tsx";
import { errorText } from "./lib.ts";

export function ExtensionsSection({ cwd }: { cwd: string | null }) {
  const [view, setView] = useState<ResourcesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setView(await api.resources(cwd ?? undefined));
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const count = (type: "extension" | "skill" | "prompt") =>
    view === null ? "…" : String(view.items.filter((item) => item.type === type && item.enabled).length);

  const openPlugins = () => {
    closeSettings();
    navigate("/plugins");
  };

  return (
    <>
      <div className="settings-summary">
        <div className="settings-summary-counts">
          <span>
            已启用扩展 <b>{count("extension")}</b>
          </span>
          <span>
            技能 <b>{count("skill")}</b>
          </span>
          <span>
            提示模板 <b>{count("prompt")}</b>
          </span>
        </div>
        <Button onClick={openPlugins}>打开插件页管理</Button>
      </div>

      {error !== null && (
        <div className="settings-error">
          <span>{error}</span>
          <Button onClick={() => void load()}>重试</Button>
        </div>
      )}
      {error === null && view === null && (
        <div className="settings-loading">
          <Spinner />
          <span>正在加载扩展与技能…</span>
        </div>
      )}
    </>
  );
}
