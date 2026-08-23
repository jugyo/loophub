import { Window } from "happy-dom";

import "../test-compat.ts";

const window = new Window();
for (const name of Object.getOwnPropertyNames(window)) {
  if (name in globalThis) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: (window as unknown as Record<string, unknown>)[name],
    writable: true,
  });
}
Object.assign(globalThis, { window, document: window.document });

if (typeof globalThis.localStorage === "undefined") {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
}

// happy-dom stores MutationObserver callbacks behind WeakRef. Bun can collect the callback while
// a React test is waiting for a DOM update, so retain callback functions for the test process.
{
  const NativeWeakRef = globalThis.WeakRef;
  const retained = new Set<object>();
  class RetainingWeakRef<T extends object> extends NativeWeakRef<T> {
    constructor(target: T) {
      super(target);
      if (typeof target === "function") retained.add(target);
    }
  }
  globalThis.WeakRef = RetainingWeakRef as typeof globalThis.WeakRef;
}

// happy-dom registers each MutationObserver's callback behind a WeakRef and keeps no strong
// reference to it, so once the collector runs the observer silently stops reporting. Bun's
// collector is prompt enough to hit this within a single test, which makes any component that
// repaints on a DOM mutation look frozen. Retain only callback functions; retaining every WeakRef
// target would keep the entire rendered DOM alive and make long SPA suites exhaust memory.
