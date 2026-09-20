import type { Provider } from "./types";

/** Where each provider's key lives in `chrome.storage.local`; the options page writes these. */
export const PROVIDER_KEY_NAMES = { openai: "openaiApiKey", openrouter: "openrouterApiKey" } as const satisfies Record<
  Provider,
  string
>;

/** The provider picked in Settings — OpenAI until the reader chooses otherwise. */
export function selectedProvider(stored: { provider?: unknown }): Provider {
  return stored.provider === "openrouter" ? "openrouter" : "openai";
}

/**
 * Whether the selected provider has a key. Presence only: the key itself is read in the service
 * worker and nowhere else.
 */
export async function hasApiKey(): Promise<boolean> {
  const stored = await chrome.storage.local.get(["provider", ...Object.values(PROVIDER_KEY_NAMES)]);
  return Boolean(stored[PROVIDER_KEY_NAMES[selectedProvider(stored)]]);
}

/** The configured Source Tracer endpoint, or null when it's unset or not https. */
export async function getSourceTracerUrl(): Promise<string | null> {
  const { sourceTracerUrl } = await chrome.storage.local.get("sourceTracerUrl");
  return typeof sourceTracerUrl === "string" && sourceTracerUrl.startsWith("https://") ? sourceTracerUrl : null;
}
