import { describe, expect, it } from "vitest";
import { upsertTrace } from "../src/sidepanel/inspector-panel";
import type { TraceEntry } from "../src/sidepanel/inspector-panel";

/**
 * The trace lives on the tab's inspection record, not in the DOM, so that returning to a tab
 * mid-run (or reopening the panel) shows the same steps the reader would have watched arrive.
 * A step that reports twice — "running" then "done" — must stay one row, in its original place.
 */
describe("Inspector trace record", () => {
  it("appends new steps in arrival order", () => {
    const list: TraceEntry[] = [];
    upsertTrace(list, { step: "Capture (page)", state: "done" });
    upsertTrace(list, { step: "Claim extraction", state: "running" });
    expect(list.map((e) => e.step)).toEqual(["Capture (page)", "Claim extraction"]);
  });

  it("replaces a step's entry in place when it reports again", () => {
    const list: TraceEntry[] = [
      { step: "Claim extraction", state: "running" },
      { step: "Slop Check (GPTZero)", state: "running" },
    ];
    upsertTrace(list, { step: "Claim extraction", state: "done", detail: "gpt-4o", ms: 1200 });
    expect(list).toEqual([
      { step: "Claim extraction", state: "done", detail: "gpt-4o", ms: 1200 },
      { step: "Slop Check (GPTZero)", state: "running" },
    ]);
  });
});
