import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { useSyncExternalStore } from "react";
import "./ui.css";

export type ToastLevel = "info" | "warning" | "error";

export interface ToastItem {
  id: number;
  message: string;
  level: ToastLevel;
}

const MAX_VISIBLE = 4;
const LIFETIME_MS: Record<ToastLevel, number> = { info: 4000, warning: 4000, error: 8000 };

let items: ToastItem[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toast(message: string, level: ToastLevel = "info"): number {
  const id = ++nextId;
  items = [...items, { id, message, level }].slice(-MAX_VISIBLE);
  emit();
  window.setTimeout(() => {
    items = items.filter((item) => item.id !== id);
    emit();
  }, LIFETIME_MS[level]);
  return id;
}

const ICONS = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;

export function Toasts() {
  const list = useSyncExternalStore(subscribe, () => items);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((item) => {
        const Icon = ICONS[item.level];
        return (
          <div key={item.id} className={`toast toast-${item.level}`}>
            <Icon size={16} aria-hidden="true" />
            <span className="toast-text">{item.message}</span>
          </div>
        );
      })}
    </div>
  );
}
