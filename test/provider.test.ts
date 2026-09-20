import { describe, expect, it } from "vitest";
import { resolveProvider, selectedProvider } from "../src/lib/provider";

describe("resolveProvider", () => {
  it("uses the selected provider when it has a key", () => {
    expect(resolveProvider({ provider: "openrouter", openaiApiKey: "a", openrouterApiKey: "b" })).toEqual({
      provider: "openrouter",
      apiKey: "b",
    });
  });

  it("falls back to the one provider that has a key when the selected one is empty", () => {
    // Storage written by an older build could hold this shape; the working key must not be stranded.
    expect(resolveProvider({ provider: "openai", openrouterApiKey: "b" })).toEqual({
      provider: "openrouter",
      apiKey: "b",
    });
    expect(resolveProvider({ openrouterApiKey: "b" })?.provider).toBe("openrouter");
  });

  it("returns null when no provider has a key, and treats an empty string as no key", () => {
    expect(resolveProvider({})).toBeNull();
    expect(resolveProvider({ provider: "openai", openaiApiKey: "", openrouterApiKey: "" })).toBeNull();
    expect(resolveProvider({ openaiApiKey: 42 })).toBeNull();
  });

  it("defaults the selection to OpenAI", () => {
    expect(selectedProvider({})).toBe("openai");
    expect(selectedProvider({ provider: "openrouter" })).toBe("openrouter");
    expect(selectedProvider({ provider: "nonsense" })).toBe("openai");
  });
});
