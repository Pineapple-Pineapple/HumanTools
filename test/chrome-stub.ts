/**
 * A minimal `chrome` for tests.
 *
 * Side-panel modules reach the extension APIs the moment they are imported — `src/lib/tab-state.ts`
 * asks which window it belongs to and which tab is active as soon as it loads — so importing one to
 * test a pure function in it would otherwise throw "chrome is not defined". This stands in for the
 * browser the panel always has in front of it. It answers with nothing and records no listeners:
 * anything that needs real tab behaviour should be tested against a purpose-built fake, built by
 * passing `installChromeStub` the tab events it wants to drive.
 */

const noop = (): void => {};
const event = () => ({ addListener: noop, removeListener: noop, hasListener: () => false });

export function installChromeStub(tabs: Record<string, unknown> = {}): void {
  (globalThis as { chrome?: unknown }).chrome = {
    windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
    tabs: {
      query: () => Promise.resolve([]),
      onActivated: event(),
      onUpdated: event(),
      onRemoved: event(),
      ...tabs,
    },
  };
}

installChromeStub();
