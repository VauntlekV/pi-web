/**
 * Per-browser UI preferences (Settings › 通用, the web-only part). Persisted in
 * localStorage under `pi-web-prefs`; pi's own settings live on the server
 * (api.settings / api.updateSettings).
 *
 * CONTRACT: field names and value sets are used by the shell, transcript and
 * settings directories.
 */
import { readStorage, writeStorage } from "./storage.ts";
import { createStore, useStore } from "./store.ts";

export interface Prefs {
  theme: "system" | "light" | "dark";
  /** conversation content font size in px (13–20) */
  fontSize: number;
  /** 工作步骤展示: detailed = thinking + every tool step; compact = tool steps only, no thinking rows */
  stepDisplay: "detailed" | "compact";
  /** 工作步骤收起时机: afterAnswer = steps visible while running, folded once the answer arrives; always = folded even while running; never = stay open */
  stepCollapse: "afterAnswer" | "always" | "never";
  /** 繁忙时的发送行为: what Enter does while the agent runs; Ctrl/Cmd+Enter does the other */
  busySend: "followUp" | "steer";
  /** show the right-edge turn navigator */
  turnNav: boolean;
  /** 动画效果: system follows prefers-reduced-motion; reduced stills every animation; full always animates */
  motion: "system" | "reduced" | "full";
  /** 聊天区滚动动画: following the stream glides instead of jumping; back-to-end button over the composer */
  chatFollow: boolean;
  /** 状态行动画: the live turn's status line (loader, swapping wording, clock, paint) */
  statusLine: boolean;
  /** 精确状态行: the status line names what is being done (正在读取 a.ts) instead of the bare state */
  statusDetail: boolean;
  /** the status line's paint: a highlight band sweeping, or a colour wash */
  statusPaint: "sweep" | "wash";
  /** 光标动画: the composer caret glides to each new insertion point */
  caretMotion: boolean;
  /** 新文字淡入: streamed characters arrive faint and settle */
  chatReveal: boolean;
  /** 消息气泡动画: a sent message enters with an animation */
  messageEnter: boolean;
  /** grow = scales up in its own place; flight = flies up from the composer */
  messageEnterStyle: "grow" | "flight";
}

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  fontSize: 15,
  stepDisplay: "detailed",
  stepCollapse: "afterAnswer",
  busySend: "followUp",
  turnNav: true,
  motion: "system",
  chatFollow: true,
  statusLine: true,
  statusDetail: true,
  statusPaint: "sweep",
  caretMotion: true,
  chatReveal: true,
  messageEnter: true,
  messageEnterStyle: "grow",
};

const KEY = "pi-web-prefs";

function load(): Prefs {
  const raw = readStorage(KEY);
  // Older builds stored the theme on its own key.
  const legacyTheme = readStorage("pi-web-theme");
  let parsed: Partial<Prefs> = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as Partial<Prefs>;
    } catch {
      parsed = {};
    }
  }
  const merged = { ...DEFAULT_PREFS, ...parsed };
  if (!raw && (legacyTheme === "light" || legacyTheme === "dark" || legacyTheme === "system")) merged.theme = legacyTheme;
  merged.fontSize = Math.min(20, Math.max(13, Math.round(Number(merged.fontSize) || DEFAULT_PREFS.fontSize)));
  return merged;
}

export const prefsStore = createStore<Prefs>(load());

export function setPrefs(patch: Partial<Prefs>): void {
  prefsStore.set((prev) => ({ ...prev, ...patch }));
  writeStorage(KEY, JSON.stringify(prefsStore.get()));
  applyDocumentPrefs();
}

export function usePrefs(): Prefs {
  return useStore(prefsStore);
}

const reducedQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
let watchingMotion = false;

/** Whether animations are stilled now: the 动画效果 choice, with 随系统 resolved against the OS. */
export function motionReduced(): boolean {
  const { motion } = prefsStore.get();
  return motion === "reduced" || (motion === "system" && (reducedQuery?.matches ?? false));
}

/**
 * Reflect theme, font size and the motion choice on <html>; call once at
 * startup and after each change. `data-motion="reduced"` is what every
 * stylesheet and script reads, so 「总是」 overrides the OS setting and
 * 「减弱」 overrides an OS that allows motion.
 */
export function applyDocumentPrefs(): void {
  const prefs = prefsStore.get();
  const root = document.documentElement;
  if (prefs.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = prefs.theme;
  root.style.setProperty("--content-font-size", `${prefs.fontSize}px`);
  root.dataset.motion = motionReduced() ? "reduced" : "full";
  root.dataset.statusPaint = prefs.statusPaint;
  if (!watchingMotion && reducedQuery) {
    watchingMotion = true;
    reducedQuery.addEventListener("change", () => {
      applyDocumentPrefs();
      // Subscribers re-read motionReduced(); the store value itself is unchanged.
      prefsStore.set((prev) => ({ ...prev }));
    });
  }
}
