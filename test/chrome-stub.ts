/**
 * A minimal `chrome` for tests.
 *
 * Side-panel modules reach the extension APIs the moment they are imported — `src/lib/tab-state.ts`
 * asks which window it belongs to and which tab is active as soon as it loads — so importing one to
 * test a pure function in it would otherwise throw "chrome is not defined". This stands in for the
 * browser the panel always has in front of it. It answers with nothing and records no listeners:
 * anything that needs real tab behaviour should be tested against a purpose-built fake, not this.
 */

const noop = (): void => {};
const event = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });

(globalThis as unknown as { chrome: unknown }).chrome = {
  windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
  tabs: {
    query: () => Promise.resolve([]),
    get: () => Promise.resolve({}),
    onActivated: event(),
    onUpdated: event(),
    onRemoved: event(),
  },
  storage: {
    local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve(), remove: () => Promise.resolve() },
    onChanged: event(),
  },
  runtime: { id: "test", onMessage: event() },
  scripting: { executeScript: () => Promise.resolve([]) },
};
