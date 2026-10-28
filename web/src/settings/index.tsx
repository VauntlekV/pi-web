/**
 * SettingsModal — 设置 dialog (通用 / 动效 / 模型 / 扩展与技能 / 关于).
 * Open state and section come from the ui store (../app/ui-store.ts).
 *
 * CONTRACT: the shell renders <SettingsModal .../> once at the app root.
 * Implementations may add optional props but must not change these.
 */
import hljs from "highlight.js/lib/common";
import { ArrowLeft, Database, Info, Settings, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ConfigResponse } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { closeSettings, setSettingsSection, useUi, type SettingsSection } from "../app/ui-store.ts";
import { Button } from "../ui/button.tsx";
import { AboutSection } from "./about.tsx";
import { CopyButton, Spinner } from "./controls.tsx";
import { ExtensionsSection } from "./extensions.tsx";
import { GeneralSection } from "./general.tsx";
import { errorText } from "./lib.ts";
import { ModelsSection } from "./models.tsx";
import { MotionSection } from "./motion.tsx";
import "./settings.css";

export interface SettingsModalProps {
  config: ConfigResponse;
  /** cwd used for project-scoped resources (current session's or home's), if any */
  cwd: string | null;
  /** Called after model/provider changes so the shell can refetch model lists */
  onModelsChanged: () => void;
}

const FOCUSABLE = "input, textarea, select, button, [href], [tabindex]:not([tabindex='-1'])";

const SECTIONS: { id: SettingsSection; label: string; icon: typeof Settings }[] = [
  { id: "general", label: "通用设置", icon: Settings },
  { id: "motion", label: "动效", icon: Sparkles },
  { id: "models", label: "模型", icon: Database },
  { id: "extensions", label: "扩展与技能", icon: SlidersHorizontal },
  { id: "about", label: "关于", icon: Info },
];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function SettingsFileView({ onBack }: { onBack: () => void }) {
  const [file, setFile] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setFile(await api.settingsFile());
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const html = useMemo(() => {
    if (!file) return "";
    try {
      return hljs.highlight(file.text, { language: "json" }).value;
    } catch {
      return escapeHtml(file.text);
    }
  }, [file]);

  return (
    <div className="settings-file">
      <button type="button" className="settings-back" autoFocus onClick={onBack}>
        <ArrowLeft size={14} aria-hidden="true" />
        返回
      </button>

      {error !== null ? (
        <div className="settings-error">
          <span>{error}</span>
          <Button onClick={() => void load()}>重试</Button>
        </div>
      ) : file === null ? (
        <div className="settings-loading">
          <Spinner />
          <span>正在打开配置文件…</span>
        </div>
      ) : (
        <>
          <div className="settings-file-path">
            <code>{file.path}</code>
            <CopyButton text={file.path} label="复制配置文件路径" />
          </div>
          <pre className="settings-code">
            <code dangerouslySetInnerHTML={{ __html: html }} />
          </pre>
        </>
      )}
    </div>
  );
}

export function SettingsModal({ config, cwd, onModelsChanged }: SettingsModalProps) {
  const { settingsOpen, settingsSection } = useUi();
  const [fileView, setFileView] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!settingsOpen) setFileView(false);
  }, [settingsOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const onKeyDown = (event: KeyboardEvent) => {
      // A nested dialog (confirm / extension) is portalled outside this card and
      // owns the keyboard while it is open.
      if (document.querySelector(".modal")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSettings();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => !node.hasAttribute("disabled") && node.offsetParent !== null,
      );
      if (nodes.length === 0) {
        event.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [settingsOpen]);

  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [settingsSection, fileView]);

  if (!settingsOpen) return null;

  return createPortal(
    <div
      className="settings-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeSettings();
      }}
    >
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
      >
        <div className="settings-head">
          <h2 className="settings-title">设置</h2>
          {!fileView && <Button onClick={() => setFileView(true)}>打开配置文件</Button>}
          <button
            type="button"
            className="icon-btn settings-close"
            aria-label="关闭设置"
            title="关闭设置"
            onClick={closeSettings}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" aria-label="设置分区">
            {SECTIONS.map((section) => {
              const Icon = section.icon;
              const active = settingsSection === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  className={active ? "settings-nav-item is-active" : "settings-nav-item"}
                  aria-current={active ? "page" : undefined}
                  onClick={() => {
                    setFileView(false);
                    setSettingsSection(section.id);
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                  {section.label}
                </button>
              );
            })}
          </nav>

          <div className="settings-content" ref={contentRef}>
            {fileView ? (
              <SettingsFileView onBack={() => setFileView(false)} />
            ) : settingsSection === "motion" ? (
              <MotionSection />
            ) : settingsSection === "models" ? (
              <ModelsSection onModelsChanged={onModelsChanged} />
            ) : settingsSection === "extensions" ? (
              <ExtensionsSection cwd={cwd} />
            ) : settingsSection === "about" ? (
              <AboutSection config={config} />
            ) : (
              <GeneralSection />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
