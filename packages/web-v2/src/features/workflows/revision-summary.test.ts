import { describe, expect, it } from "vitest";
import { revisionSummary } from "./revision-summary";

const none = { steps: { added: [], removed: [], changed: [] }, edges: { added: 0, removed: 0, changed: 0 } };

describe("revision summary", () => {
  it("says what a revision adds, removes and rewords in one line", () => {
    expect(
      revisionSummary({ steps: { added: ["Sign in", "Pick a shift", "Confirm", "Done"], removed: ["Old"], changed: ["Home"] }, edges: { added: 1, removed: 0, changed: 2 } }, false),
    ).toBe("Adds Sign in, Pick a shift, Confirm and 1 more; removes Old; rewords Home; adds 1 line; changes 2 lines.");
  });
  it("says when nothing changed, and when it is the first draft", () => {
    expect(revisionSummary(none, false)).toBe("No change to the steps or lines.");
    expect(revisionSummary(null, true)).toBe("First draft of the design.");
    expect(revisionSummary(null, false)).toBeNull();
  });
});
