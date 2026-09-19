export async function hasApiKey(): Promise<boolean> {
  const { provider, openaiApiKey, openrouterApiKey } = await chrome.storage.local.get([
    "provider",
    "openaiApiKey",
    "openrouterApiKey",
  ]);
  return Boolean(provider === "openrouter" ? openrouterApiKey : openaiApiKey);
}
