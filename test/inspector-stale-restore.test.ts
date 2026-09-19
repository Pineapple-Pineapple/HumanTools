import { describe, expect, it } from "vitest";
import { isSameDocument } from "../src/sidepanel/inspector-panel";

/**
 * An inspection is only shown again while its tab is still on the page it was taken from. This is
 * the check that decides that, for results coming back out of session storage after the side panel
 * was closed and reopened — the one path where nothing else has already dropped them.
 */
describe("Inspector stale-restore check", () => {
  it("keeps an inspection when the tab is on the page it was taken from", () => {
    expect(isSameDocument("https://example.com/a", "https://example.com/a")).toBe(true);
  });

  it("keeps it when the reader has only moved within the page", () => {
    expect(isSameDocument("https://example.com/a#notes", "https://example.com/a")).toBe(true);
    expect(isSameDocument("https://example.com/a", "https://example.com/a#notes")).toBe(true);
  });

  it("drops it once the tab is on a different page", () => {
    expect(isSameDocument("https://example.com/b", "https://example.com/a")).toBe(false);
    expect(isSameDocument("https://evil.example/a", "https://example.com/a")).toBe(false);
  });

  it("drops it when the tab's URL can't be read at all", () => {
    // chrome:// and the Web Store report no URL; unknowable is not the same as unchanged.
    expect(isSameDocument(undefined, "https://example.com/a")).toBe(false);
    expect(isSameDocument("https://example.com/a", undefined)).toBe(false);
    expect(isSameDocument("", "")).toBe(false);
  });
});
