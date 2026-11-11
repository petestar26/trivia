/**
 * The shared test setup stubs localStorage with inert vi.fn()s. Tests that need
 * real storage behaviour (launch intents shared between tabs) install this
 * in-memory Storage and restore the stub afterwards.
 */
export function installMemoryStorage() {
  const original = window.localStorage;
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  // A shared exclusive queue models the browser's cross-tab Web Locks contract.
  let queue: Promise<unknown> = Promise.resolve();
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, callback: () => unknown) => {
        const next = queue.catch(() => undefined).then(callback);
        queue = next;
        return next;
      },
    },
  });
  const memory = new Map<string, string>();
  const store: Storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, String(value)),
    removeItem: (key) => void memory.delete(key),
    clear: () => memory.clear(),
    key: (index) => [...memory.keys()][index] ?? null,
    get length() {
      return memory.size;
    },
  };
  window.localStorage = store;
  return {
    memory,
    restore: () => {
      window.localStorage = original;
      if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
      else Reflect.deleteProperty(navigator, 'locks');
    },
  };
}
