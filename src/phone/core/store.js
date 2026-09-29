import { useSyncExternalStore, useRef } from "react";

/** A small observable state object: set() merges, subscribers re-render. */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  return {
    get: () => state,
    set(partial) {
      const next = typeof partial === "function" ? partial(state) : partial;
      let changed = false;
      for (const key in next) if (!Object.is(state[key], next[key])) changed = true;
      if (!changed) return;
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const shallowEqual = (a, b) => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
};

/** The store's state, or a slice of it (re-renders only when the slice changes). */
export function useStore(store, select = (s) => s) {
  const last = useRef();
  return useSyncExternalStore(store.subscribe, () => {
    const value = select(store.get());
    if (last.current !== undefined && shallowEqual(last.current, value)) return last.current;
    last.current = value;
    return value;
  });
}
