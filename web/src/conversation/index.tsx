import {
  ArrowDown,
  ArrowUpRight,
  ChevronDown,
  Copy,
  Download,
  Files,
  GitBranch,
  Minimize2,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  CommandInfo,
  ImageContent,
  ModelInfo,
  ModelRef,
  SessionState,
  ThinkingLevel,
  TranscriptItem,
} from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { DockToggle } from "../app/dock-toggle.tsx";
import { errorText, isStatus } from "../app/errors.ts";
import { motionReduced, prefsStore, usePrefs } from "../app/prefs.ts";
import { navigate } from "../app/router.ts";
import { setView, useUi } from "../app/ui-store.ts";
import { firstLine } from "../app/text.ts";
import { Composer } from "../composer/index.tsx";
import { ExtensionDialog } from "../dialogs/ExtensionDialog.tsx";
import { dock } from "../dock/store.ts";
import { useSessionStream } from "../state/useSessionStream.ts";
import { Trajectory } from "../trajectory/index.tsx";
import { Transcript, TurnNav } from "../transcript/index.tsx";
import { useReveal } from "../transcript/reveal.ts";
import { ConfirmDialog } from "../ui/confirm.tsx";
import { Menu, type MenuEntry } from "../ui/menu.tsx";
import { Segmented } from "../ui/segmented.tsx";
import { toast } from "../ui/toasts.tsx";
import "./conversation.css";

export interface ConversationProps {
  id: string;
  models: ModelInfo[];
  /** Bumped by the shell after model/provider settings change */
  modelsVersion?: number;
  leading?: ReactNode;
  /** Reload the sidebar workspace list (renamed / settled / deleted) */
  onRefresh: () => void;
}

function firstUserLine(items: TranscriptItem[]): string {
  for (const item of items) {
    const message = item.message;
    if (message.role !== "user") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(" ");
    const line = firstLine(text, 60);
    if (line) return line;
  }
  return "";
}

const NEAR_BOTTOM_PX = 80;

export function Conversation(props: ConversationProps) {
  const { id } = props;
  const ui = useUi();
  const [initial, setInitial] = useState<{ state: SessionState; transcript: TranscriptItem[] } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>(props.models);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [navRoot, setNavRoot] = useState<HTMLElement | null>(null);
  const [answeredUi, setAnsweredUi] = useState<Set<string>>(() => new Set());
  // `POST /model` and `/thinking` return the new state without a matching SSE
  // event in every case, so keep it until the stream produces a newer one.
  const [localState, setLocalState] = useState<{ state: SessionState; base: SessionState | null } | null>(null);
  const viewStateRef = useRef<SessionState | null>(null);

  const stickRef = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  /** rAF id of the follow glide (设置 › 动效 › 聊天区滚动动画); 0 when idle */
  const glideRef = useRef(0);
  const prefs = usePrefs();
  const titleInputRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<string | undefined>(undefined);

  const view = useSessionStream(id, {
    onNotify: (message, level) => toast(message, level),
    onError: (message) => toast(message, "error"),
    onSettled: () => props.onRefresh(),
  });

  useEffect(() => {
    viewStateRef.current = view.state;
  }, [view.state]);

  const state =
    localState !== null && localState.base === view.state
      ? localState.state
      : view.state ?? initial?.state ?? null;
  const items = view.state !== null ? view.items : initial?.transcript ?? [];
  const running = Boolean(state?.isStreaming || state?.isCompacting);
  const title = state?.name?.trim() || firstUserLine(items) || "新会话";

  useEffect(() => {
    let cancelled = false;
    api
      .getSession(id)
      .then((data) => {
        if (!cancelled) setInitial(data);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isStatus(error, 404)) {
          toast("会话不存在", "error");
          navigate("/");
        } else {
          toast(errorText(error), "error");
        }
      });
    api
      .models(id)
      .then((data) => {
        if (!cancelled) setModels(data.models);
      })
      .catch(() => {});
    api
      .commands(id)
      .then((data) => {
        if (!cancelled) setCommands(data.commands);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id, props.modelsVersion]);

  useEffect(() => {
    document.title = running ? `● ${title} · pi` : `${title} · pi`;
  }, [running, title]);

  // The right dock follows the session's workspace.
  useEffect(() => {
    if (state?.cwd) dock.setCwd(state.cwd);
  }, [state?.cwd]);

  // Renames (by the user or an extension) refresh the sidebar right away.
  useEffect(() => {
    const name = view.state?.name;
    if (name === nameRef.current) return;
    nameRef.current = name;
    props.onRefresh();
  }, [view.state?.name, props.onRefresh]);

  useEffect(() => {
    setNavRoot(scrollRef.current);
  }, []);

  const isNearBottom = (element: HTMLDivElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;

  const scrollToBottom = useCallback((smooth: boolean) => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const stopGlide = useCallback(() => {
    if (glideRef.current !== 0) cancelAnimationFrame(glideRef.current);
    glideRef.current = 0;
  }, []);

  // Keep the end in view while following. With the chat-area animation on, the
  // position eases toward the end (each frame closes ~22% of the gap, re-reading
  // the target as content keeps arriving) instead of jumping per update.
  const followBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (!prefsStore.get().chatFollow || motionReduced()) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    if (glideRef.current !== 0) return;
    const step = () => {
      const target = element.scrollHeight - element.clientHeight;
      const gap = target - element.scrollTop;
      if (Math.abs(gap) < 1) {
        element.scrollTop = target;
        glideRef.current = 0;
        return;
      }
      element.scrollTop += Math.sign(gap) * Math.max(1, Math.abs(gap) * 0.22);
      glideRef.current = requestAnimationFrame(step);
    };
    glideRef.current = requestAnimationFrame(step);
  }, []);

  useEffect(() => stopGlide, [stopGlide]);

  /** The reader taking the scroll over ends a glide, so their scroll decides the follow. */
  const onScrollIntent = (event: { type: string; deltaY?: number; key?: string }) => {
    if (glideRef.current === 0) return;
    if (event.type === "wheel" && (event.deltaY ?? 0) >= 0) return;
    if (event.type === "keydown" && !["ArrowUp", "PageUp", "Home", " "].includes(event.key ?? "")) return;
    stopGlide();
  };

  const syncScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    // The glide's own steps are not the reader leaving the end.
    if (glideRef.current !== 0) {
      setScrolled(element.scrollTop > 0);
      return;
    }
    const near = isNearBottom(element);
    stickRef.current = near;
    setShowJump(!near);
    setScrolled(element.scrollTop > 0);
  }, []);

  useLayoutEffect(() => {
    if (stickRef.current) followBottom();
  }, [items, view.streaming, state?.isCompacting, state?.workingMessage, followBottom]);

  useLayoutEffect(() => {
    stickRef.current = true;
    setShowJump(false);
    scrollToBottom(false);
  }, [scrollToBottom]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      const element = scrollRef.current;
      if (!element) return;
      if (stickRef.current) {
        followBottom();
        setShowJump(false);
      } else {
        setShowJump(true);
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [followBottom]);

  useReveal(contentRef, prefs.chatReveal && ui.view === "chat");

  useEffect(() => {
    if (!editing) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    setDraft(title);
    setEditing(true);
  };

  const commitRename = async () => {
    const name = draft.trim();
    setEditing(false);
    if (!name || name === title) return;
    try {
      await api.renameSession(id, name);
      props.onRefresh();
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  const deleteSession = async () => {
    setConfirmDelete(false);
    try {
      await api.deleteSession(id);
      props.onRefresh();
      navigate("/");
    } catch (error) {
      if (isStatus(error, 409)) toast("会话运行中，无法删除", "warning");
      else toast(errorText(error), "error");
    }
  };

  const compact = async () => {
    try {
      await api.compact(id);
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  const reload = async () => {
    try {
      await api.reloadSession(id);
      toast("已重新加载");
      props.onRefresh();
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(id);
      toast("已复制会话 ID");
    } catch {
      toast("复制失败", "error");
    }
  };

  const copyPath = async () => {
    const cwd = state?.cwd;
    if (!cwd) return;
    try {
      await navigator.clipboard.writeText(cwd);
      toast("已复制路径");
    } catch {
      toast("复制失败", "error");
    }
  };

  const submit = async (text: string, images: ImageContent[], behavior?: "steer" | "followUp") => {
    try {
      await api.prompt(id, { text, images, behavior });
    } catch (error) {
      toast(errorText(error), "error");
      throw error;
    }
  };

  const changeModel = (ref: ModelRef) => {
    api
      .setModel(id, ref)
      .then((data) => setLocalState({ state: data.state, base: viewStateRef.current }))
      .catch((error: unknown) => toast(errorText(error), "error"));
  };

  const changeThinking = (level: ThinkingLevel) => {
    api
      .setThinking(id, level)
      .then((data) => setLocalState({ state: data.state, base: viewStateRef.current }))
      .catch((error: unknown) => toast(errorText(error), "error"));
  };

  const abort = () => {
    api.abort(id).catch((error: unknown) => toast(errorText(error), "error"));
  };

  const jumpToBottom = () => {
    stickRef.current = true;
    setShowJump(false);
    scrollToBottom(true);
  };

  const sessionMenu: MenuEntry[] = [
    { kind: "item", label: "重命名", icon: <Pencil size={14} />, onSelect: startEditing },
    { kind: "item", label: "压缩上下文", icon: <Minimize2 size={14} />, onSelect: () => void compact() },
    { kind: "item", label: "重新加载扩展", icon: <RefreshCw size={14} />, onSelect: () => void reload() },
    {
      kind: "item",
      label: "下载会话日志",
      icon: <Download size={14} />,
      onSelect: () => window.open(api.exportUrl(id), "_blank"),
    },
    { kind: "item", label: "复制会话 ID", icon: <Copy size={14} />, onSelect: () => void copyId() },
    { kind: "separator" },
    {
      kind: "item",
      label: "删除会话",
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => setConfirmDelete(true),
    },
  ];

  const openMenu: MenuEntry[] = [
    {
      kind: "item",
      label: "工作区文件",
      icon: <Files size={14} />,
      onSelect: () => dock.openFiles(),
    },
    { kind: "item", label: "Git 变更", icon: <GitBranch size={14} />, onSelect: () => dock.openGit() },
    { kind: "item", label: "复制工作区路径", icon: <Copy size={14} />, onSelect: () => void copyPath() },
  ];

  const composerActions = [
    { id: "compact", label: "压缩上下文", hint: "compact", run: () => void compact() },
    {
      id: "export",
      label: "下载会话日志",
      hint: "export",
      run: () => window.open(api.exportUrl(id), "_blank"),
    },
    { id: "reload", label: "重新加载扩展", hint: "reload", run: () => void reload() },
  ];

  const modelName = models.find(
    (entry) => entry.provider === state?.model?.provider && entry.id === state?.model?.id,
  )?.name;

  // The server drops an answered request without a state event, so the client
  // hides it itself and moves on to the next one.
  const pending = state?.pendingUi.find((request) => !answeredUi.has(request.id));

  return (
    <div className="conv">
      <header className={scrolled ? "conv-head scrolled" : "conv-head"}>
        {props.leading}

        <div className="conv-title-wrap">
          {editing ? (
            <input
              ref={titleInputRef}
              className="conv-title-input"
              value={draft}
              aria-label="会话标题"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
              onBlur={() => setEditing(false)}
            />
          ) : (
            <>
              <h1 className="conv-title" title={title} onDoubleClick={startEditing}>
                {title}
              </h1>
              <button
                type="button"
                className="icon-btn title-edit"
                aria-label="重命名会话"
                title="重命名会话"
                onClick={startEditing}
              >
                <Pencil size={13} />
              </button>
            </>
          )}
          {state?.model && <span className="conv-model">{modelName ?? state.model.id}</span>}
        </div>

        {!view.connected && <span className="conv-reconnecting">重连中…</span>}

        <div className="conv-head-spacer" />

        <div className="conv-actions">
          <div className="conv-split">
            <button
              type="button"
              className="conv-split-main"
              aria-label="打开右侧栏文件"
              title="工作区文件"
              onClick={() => dock.openFiles()}
            >
              <ArrowUpRight size={15} />
            </button>
            <Menu
              label="打开方式"
              trigger={<ChevronDown size={14} />}
              triggerClassName="conv-split-more"
              items={openMenu}
            />
          </div>
          <Menu label="会话菜单" icon={<MoreHorizontal size={16} />} items={sessionMenu} />
          <DockToggle />
        </div>

        <div className="view-tabs">
          <Segmented
            label="视图"
            value={ui.view}
            options={[
              { value: "chat", label: "对话" },
              { value: "trajectory", label: "轨迹" },
            ]}
            onChange={setView}
          />
        </div>
      </header>

      <div
        className="conv-scroll"
        ref={scrollRef}
        onScroll={syncScroll}
        onWheel={onScrollIntent}
        onTouchStart={onScrollIntent}
        onPointerDown={onScrollIntent}
        onKeyDown={onScrollIntent}
      >
        <div className="conv-column" ref={contentRef}>
          {ui.view === "trajectory" ? (
            <Trajectory items={items} streaming={view.streaming} cwd={state?.cwd} />
          ) : (
            <Transcript
              items={items}
              streaming={view.streaming}
              tools={view.tools}
              running={running}
              workingMessage={state?.workingMessage}
              cwd={state?.cwd}
            />
          )}
          {state?.isCompacting && <div className="conv-compacting">正在压缩上下文…</div>}
        </div>
      </div>

      {items.length > 0 && <TurnNav items={items} scrollRoot={navRoot} />}

      {showJump && (
        <button
          type="button"
          className={prefs.chatFollow ? "conv-jump is-centered" : "conv-jump"}
          aria-label="回到底部"
          title="回到底部"
          onClick={jumpToBottom}
        >
          <ArrowDown size={16} />
        </button>
      )}

      {state && (
        <div className="conv-foot">
          <Composer
            cwd={state.cwd}
            running={running}
            models={models}
            model={state.model}
            thinkingLevel={state.thinkingLevel}
            availableThinkingLevels={state.availableThinkingLevels}
            onModelChange={changeModel}
            onThinkingChange={changeThinking}
            commands={commands}
            actions={composerActions}
            stats={state.stats}
            queued={{ steering: state.steering, followUp: state.followUp }}
            widgets={state.widgets}
            statuses={state.statuses}
            onSubmit={submit}
            onAbort={abort}
          />
        </div>
      )}

      {pending && (
        <ExtensionDialog
          key={pending.id}
          sessionId={id}
          request={pending}
          onAnswered={(requestId) =>
            setAnsweredUi((previous) => {
              const next = new Set(previous);
              next.add(requestId);
              return next;
            })
          }
        />
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="删除会话？"
        message="此操作不可撤销。"
        confirmLabel="删除"
        danger
        onConfirm={deleteSession}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
