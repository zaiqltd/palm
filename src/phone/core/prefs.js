// The iPhone app's @AppStorage settings, kept in this browser (localStorage
// is per site and per Home Screen app). Same keys, same defaults.
import { useSyncExternalStore } from "react";

const listeners = new Set();
const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};

export const prefs = {
  get: read,
  set(key, value) {
    try {
      if (value === undefined || value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
    for (const l of listeners) l(key);
  },
};

/** A saved setting as React state: [value, setValue]. */
export function usePref(key, fallback) {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      const onStorage = (e) => e.key === key && listener();
      window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener("storage", onStorage);
      };
    },
    () => JSON.stringify(read(key, fallback)),
  );
  return [JSON.parse(value), (next) => prefs.set(key, typeof next === "function" ? next(JSON.parse(value)) : next)];
}

export const KEYS = {
  remoteMode: "palm.remote.mode",
  railSide: "palm.remote.railSide",
  railCollapsed: "palm.remote.railCollapsed",
  invertScroll: "palm.remote.invertScroll",
  agentAccess: "palm.assistant.agentAccess",
  sendFolder: "palm.send.lastFolder",
};
