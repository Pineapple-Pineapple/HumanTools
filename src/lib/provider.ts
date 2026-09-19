export async function hasApiKey(): Promise<boolean> {
  const { provider, openaiApiKey, openrouterApiKey } = await chrome.storage.local.get([
    "provider",
    "openaiApiKey",
    "openrouterApiKey",
  ]);
  return Boolean(provider === "openrouter" ? openrouterApiKey : openaiApiKey);
}

/** The configured Source Tracer endpoint, or null when it's unset or not https. */
export async function getSourceTracerUrl(): Promise<string | null> {
  const { sourceTracerUrl } = await chrome.storage.local.get("sourceTracerUrl");
  return typeof sourceTracerUrl === "string" && sourceTracerUrl.startsWith("https://") ? sourceTracerUrl : null;
}
