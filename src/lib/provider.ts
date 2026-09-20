import type { Provider } from "./types";

/** Where each provider's key lives in `chrome.storage.local`; the options page writes these. */
export const PROVIDER_KEY_NAMES = { openai: "openaiApiKey", openrouter: "openrouterApiKey" } as const satisfies Record<
  Provider,
  string
>;

export const PROVIDER_STORAGE_KEYS = ["provider", ...Object.values(PROVIDER_KEY_NAMES)] as const;

/** The provider picked in Settings — OpenAI until the reader chooses otherwise. */
export function selectedProvider(stored: { provider?: unknown }): Provider {
  return stored.provider === "openrouter" ? "openrouter" : "openai";
}

export interface ResolvedProvider {
  provider: Provider;
  apiKey: string;
}

/**
 * The provider a call should use, and its key: the selected one when it has a key, otherwise the
 * one provider that does. Settings can no longer save a key behind the wrong radio, but storage
 * written by an older build can still hold that shape, and a working key must not be stranded
 * behind a stale choice. Null when no provider has a key at all. The service worker and the panels
 * both answer "is there a key?" through this, so they can never disagree.
 */
export function resolveProvider(stored: Record<string, unknown>): ResolvedProvider | null {
  const selected = selectedProvider(stored);
  const other: Provider = selected === "openai" ? "openrouter" : "openai";
  for (const provider of [selected, other]) {
    const apiKey = stored[PROVIDER_KEY_NAMES[provider]];
    if (typeof apiKey === "string" && apiKey) return { provider, apiKey };
  }
  return null;
}

/** Presence only: the key itself is used in the service worker and nowhere else. */
export async function hasApiKey(): Promise<boolean> {
  const stored = await chrome.storage.local.get([...PROVIDER_STORAGE_KEYS]);
  return resolveProvider(stored) !== null;
}
