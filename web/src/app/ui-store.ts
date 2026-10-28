/**
 * App-level UI switches shared across directories.
 *
 * CONTRACT: the shell renders <SettingsModal/> from `settingsOpen`; anything
 * (account menu, composer "+" menu, plugins page) may call openSettings().
 * `view` is the conversation header's 对话/轨迹 segment.
 */
import { createStore, useStore } from "./store.ts";

export type SettingsSection = "general" | "motion" | "models" | "extensions" | "about";

export interface UiState {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** conversation view mode */
  view: "chat" | "trajectory";
}

export const uiStore = createStore<UiState>({ settingsOpen: false, settingsSection: "general", view: "chat" });

export function useUi(): UiState {
  return useStore(uiStore);
}

export function openSettings(section: SettingsSection = "general"): void {
  uiStore.set((prev) => ({ ...prev, settingsOpen: true, settingsSection: section }));
}

export function closeSettings(): void {
  uiStore.set((prev) => ({ ...prev, settingsOpen: false }));
}

export function setSettingsSection(section: SettingsSection): void {
  uiStore.set((prev) => ({ ...prev, settingsSection: section }));
}

export function setView(view: UiState["view"]): void {
  uiStore.set((prev) => ({ ...prev, view }));
}
