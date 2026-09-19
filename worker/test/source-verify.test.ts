import { describe, expect, it } from "vitest";

async function loadVerifier(): Promise<typeof import("../src/source-verify") | null> {
  try {
    return await import("../src/source-verify");
  } catch {
    return null;
  }
}

describe("verifySourceExcerpt", () => {
  it("returns the containing sentence for a contiguous claim quote", async () => {
    const module = await loadVerifier();
    expect(module).not.toBeNull();

    const result = module?.verifySourceExcerpt(
      "The filing states that revenue increased from $1 million to $4 million in 2025. The company expects growth to continue.",
      "revenue increased from $1 million to $4 million",
    );

    expect(result?.excerpt).toBe("The filing states that revenue increased from $1 million to $4 million in 2025.");
  });

  it("rejects a source that contains only disjoint keywords", async () => {
    const module = await loadVerifier();
    expect(module).not.toBeNull();

    expect(module?.verifySourceExcerpt("Revenue was $4 million. The increase was discussed later.", "revenue increased to $4 million")).toBeNull();
  });

  it("matches case and whitespace differences without permitting paraphrases", async () => {
    const module = await loadVerifier();
    expect(module).not.toBeNull();

    expect(module?.verifySourceExcerpt("Revenue\n\nINCREASED from $1 million to $4 million.", "revenue increased from $1 million to $4 million")).not.toBeNull();
    expect(module?.verifySourceExcerpt("Revenue climbed from $1 million to $4 million.", "revenue increased from $1 million to $4 million")).toBeNull();
  });
});
