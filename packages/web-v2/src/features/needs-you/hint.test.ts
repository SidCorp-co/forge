import { describe, expect, it } from "vitest";
import { needsYouHint } from "./hint";

describe("needsYouHint", () => {
  it("reads the label first, then the count, then each act with its number", () => {
    expect(
      needsYouHint("Requirements", {
        you: 3,
        acts: [
          { act: "accept r2", count: 2 },
          { act: "break down", count: 1 },
        ],
      }),
    ).toBe("Requirements · waiting on you 3: accept r2 (2), break down");
  });

  it("says nothing waits when the count is zero", () => {
    expect(needsYouHint("Feedback", { you: 0, acts: [] })).toBe("Feedback · nothing waits on you");
  });

  it("names an act core left empty rather than drawing a blank", () => {
    expect(needsYouHint("Issues", { you: 1, acts: [{ act: "", count: 1 }] })).toBe(
      "Issues · waiting on you 1: act",
    );
  });
});
