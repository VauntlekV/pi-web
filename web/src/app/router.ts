/**
 * Tiny history-based router. No library: the app has exactly two routes.
 */
import { useSyncExternalStore } from "react";

export type Route = { name: "home" } | { name: "plugins" } | { name: "session"; id: string };

const listeners = new Set<() => void>();

/** Deploy prefix without the trailing slash: "" normally, "/pi-web" for the GitHub Pages demo. */
const BASE = (import.meta.env?.BASE_URL ?? "/").replace(/\/+$/, "");

function notify() {
  for (const listener of listeners) listener();
}

/** Parse a pathname (query/hash tolerated) into a route. */
export function parseRoute(pathname: string): Route {
  const path = pathname.split(/[?#]/)[0] ?? "";
  if (path === "/plugins" || path === "/plugins/") return { name: "plugins" };
  if (path.startsWith("/s/")) {
    const raw = path.slice(3).replace(/\/+$/, "");
    if (raw) {
      try {
        return { name: "session", id: decodeURIComponent(raw) };
      } catch {
        return { name: "home" };
      }
    }
  }
  return { name: "home" };
}

export function navigate(path: string): void {
  if (typeof window === "undefined") return;
  window.history.pushState(null, "", BASE + path);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getPathname(): string {
  const path = window.location.pathname;
  return BASE && path.startsWith(BASE) ? path.slice(BASE.length) || "/" : path;
}

function getServerPathname(): string {
  return "/";
}

if (typeof window !== "undefined") {
  window.addEventListener("popstate", notify);
}

export function useRoute(): Route {
  return parseRoute(useSyncExternalStore(subscribe, getPathname, getServerPathname));
}
