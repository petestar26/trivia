/**
 * The shared test setup stubs localStorage with inert vi.fn()s. Tests that need
 * real storage behaviour (launch intents shared between tabs) install this
 * in-memory Storage and restore the stub afterwards.
 */
export function installMemoryStorage() {
  const original = window.localStorage;
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
    },
  };
}
