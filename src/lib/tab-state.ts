/**
 * Which tab the side panel is looking at, and what each panel has computed per tab.
 *
 * A side panel outlives the tab it was opened over: the reader switches tabs and the panel keeps
 * showing results belonging to a page that is no longer in front of them. This module owns that
 * invariant so every panel answers it the same way — results are keyed by tab, swapped when the
 * reader switches, and dropped when a tab navigates away or closes.
 */

type TabListener = (tabId: number) => void;

interface Evictable {
  forget(tabId: number): void;
}

const stores: Evictable[] = [];
const activatedListeners: TabListener[] = [];
const navigatedListeners: TabListener[] = [];
const loadedListeners: TabListener[] = [];

let currentTabId: number | null = null;
/** The window this panel belongs to. Tab events fire for every window; only ours matter. */
let panelWindowId: number | null = null;

export function getCurrentTabId(): number | null {
  return currentTabId;
}

/** Fires when the reader switches to a different tab in this panel's window. */
export function onTabActivated(listener: TabListener): void {
  activatedListeners.push(listener);
}

/** Fires when the tab in front of the reader navigates to a different page. */
export function onTabNavigated(listener: TabListener): void {
  navigatedListeners.push(listener);
}

/**
 * Fires when the tab in front of the reader finishes loading a document — the point at which any
 * script a panel injected into it is gone for good and has to be put back.
 */
export function onTabLoaded(listener: TabListener): void {
  loadedListeners.push(listener);
}

export interface TabStore<T> {
  get(tabId: number | null): T | undefined;
  set(tabId: number, value: T): void;
  forget(tabId: number): void;
}

/**
 * A panel's results, keyed by tab. Entries are evicted automatically when their tab navigates or
 * closes, so a panel can never render a result that belongs to a page the tab has left.
 */
export function createTabStore<T>(): TabStore<T> {
  const byTab = new Map<number, T>();
  const store: TabStore<T> = {
    get: (tabId) => (tabId === null ? undefined : byTab.get(tabId)),
    set: (tabId, value) => void byTab.set(tabId, value),
    forget: (tabId) => void byTab.delete(tabId),
  };
  stores.push(store);
  return store;
}

function evict(tabId: number): void {
  for (const store of stores) store.forget(tabId);
}

chrome.windows.getCurrent().then((window) => {
  panelWindowId = window.id ?? null;
});

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  if (tab?.id !== undefined) currentTabId = tab.id;
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (panelWindowId !== null && windowId !== panelWindowId) return;
  currentTabId = tabId;
  for (const listener of activatedListeners) listener(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete" && tabId === currentTabId) {
    for (const listener of loadedListeners) listener(tabId);
  }
  // Only a real navigation invalidates a result; title and favicon changes do not.
  if (!changeInfo.url) return;
  evict(tabId);
  if (tabId !== currentTabId) return;
  for (const listener of navigatedListeners) listener(tabId);
});

chrome.tabs.onRemoved.addListener(evict);
