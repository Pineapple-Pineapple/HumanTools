import { describe, expect, it } from "vitest";

async function loadInspector(): Promise<typeof import("../src/sidepanel/inspector-panel") | null> {
  try {
    return await import("../src/sidepanel/inspector-panel");
  } catch {
    return null;
  }
}

describe("Inspector source context copy", () => {
  it("explains same-page and non-factual context without calling it evidence", async () => {
    const module = await loadInspector();
    expect(module).not.toBeNull();
    const message = (module as unknown as {
      sourceContextMessage?: (reasons: string[]) => string;
    } | null)?.sourceContextMessage;

    expect(message).toBeTypeOf("function");
    expect(message?.(["page_context", "non_factual_context"])).toBe(
      "This is the inspected page and a known satire/non-factual publisher — not evidence for this claim.",
    );
  });

  it("labels unassessed external publishers without calling them trustworthy", async () => {
    const module = await loadInspector();
    expect(module).not.toBeNull();
    const label = (module as unknown as {
      sourceQualityMessage?: (quality: string) => string;
    } | null)?.sourceQualityMessage;

    expect(label).toBeTypeOf("function");
    expect(label?.("credibility_unassessed")).toBe("Credibility not established");
  });
});
