import { describe, expect, it, vi } from "vitest";

/**
 * What a closing tab takes with it.
 *
 * `tab-state` registers its listeners the moment it loads, so this builds a fake `chrome` that
 * records them, then imports the module against it — the shared stub in chrome-stub.ts answers with
 * nothing on purpose and says to do exactly this for anything needing real tab behaviour.
 */
type RemovedListener = (tabId: number) => void;

async function loadTabState(): Promise<{
  module: typeof import("../src/lib/tab-state");
  close: (tabId: number) => void;
}> {
  const removed: RemovedListener[] = [];
  const event = () => ({ addListener: () => {}, removeListener: () => {}, hasListener: () => false });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
    tabs: {
      query: () => Promise.resolve([]),
      get: () => Promise.resolve({}),
      onActivated: event(),
      onUpdated: event(),
      onRemoved: {
        addListener: (listener: RemovedListener) => void removed.push(listener),
        removeListener: () => {},
        hasListener: () => false,
      },
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
      onChanged: event(),
    },
    runtime: { id: "test", onMessage: event() },
    scripting: { executeScript: () => Promise.resolve([]) },
  };

  vi.resetModules();
  const module = await import("../src/lib/tab-state");
  return {
    module,
    close: (tabId) => {
      for (const listener of removed) listener(tabId);
    },
  };
}

describe("closing a tab", () => {
  it("drops that tab's stored result and leaves every other tab alone", async () => {
    const { module, close } = await loadTabState();
    const store = module.createTabStore<string>();
    store.set(1, "tab one");
    store.set(2, "tab two");

    close(1);

    expect(store.get(1)).toBeUndefined();
    expect(store.get(2)).toBe("tab two");
  });

  it("tells listeners which tab closed", async () => {
    const { module, close } = await loadTabState();
    const closed: number[] = [];
    module.onTabClosed((tabId) => void closed.push(tabId));

    close(7);

    expect(closed).toEqual([7]);
  });

  /**
   * The contract a panel's own cleanup depends on: by the time it hears about the close, nothing
   * is left holding that tab's result, so its own copy is the only one it has to think about.
   */
  it("has already dropped the stored result by the time listeners run", async () => {
    const { module, close } = await loadTabState();
    const store = module.createTabStore<string>();
    store.set(3, "tab three");
    let seenDuringCallback: string | undefined = "not run";
    module.onTabClosed((tabId) => {
      seenDuringCallback = store.get(tabId);
    });

    close(3);

    expect(seenDuringCallback).toBeUndefined();
  });

  it("says nothing about a tab that never had a result", async () => {
    const { module, close } = await loadTabState();
    const store = module.createTabStore<string>();
    store.set(1, "tab one");
    const closed: number[] = [];
    module.onTabClosed((tabId) => void closed.push(tabId));

    close(99);

    expect(closed).toEqual([99]);
    expect(store.get(1)).toBe("tab one");
  });
});
