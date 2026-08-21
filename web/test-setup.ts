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

// happy-dom registers each MutationObserver's callback behind a WeakRef and keeps no strong
// reference to it, so once the collector runs the observer silently stops reporting. Bun's
// collector is prompt enough to hit this within a single test, which makes any component that
// repaints on a DOM mutation look frozen. Retaining every WeakRef target for the life of the test
// process restores the observer contract; a test run is short and single-purpose, so holding these
// alive costs nothing.
{
  const NativeWeakRef = globalThis.WeakRef;
  const retained = new Set<object>();
  class RetainingWeakRef<T extends object> extends NativeWeakRef<T> {
    constructor(target: T) {
      super(target);
      retained.add(target);
    }
  }
  globalThis.WeakRef = RetainingWeakRef as typeof globalThis.WeakRef;
}
