export async function getActiveTabId(): Promise<number> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return tab.id;
}

/** Whether `tabId` is still the tab the user is looking at — panels hold results per tab. */
export async function isActiveTab(tabId: number): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id === tabId;
}
