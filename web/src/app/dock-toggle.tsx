/** The right-dock toggle shown by the conversation, home and plugins headers. */
import { PanelRight } from "lucide-react";
import { dock, useDock } from "../dock/store.ts";

export function DockToggle() {
  const { open } = useDock();
  return (
    <button
      type="button"
      className={open ? "icon-btn is-on" : "icon-btn"}
      aria-label={open ? "收起右侧栏" : "打开右侧栏"}
      title={open ? "收起右侧栏" : "打开右侧栏"}
      aria-pressed={open}
      onClick={() => dock.toggle()}
    >
      <PanelRight size={16} />
    </button>
  );
}
