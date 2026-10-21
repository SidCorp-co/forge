// What a decision's button posts with the words a person typed (REQ-48 BC-5): a steward decision's
// keep or drop carries its reason as the option's `note`, a free answer as `text`, and every other
// act as `reason`, each the field its route reads.

import type { DecisionAnswer } from "@forge/contracts/needs-you-decisions";
import { describe, expect, it } from "vitest";
import { pressBody } from "./api";

const button = (over: Partial<DecisionAnswer>): DecisionAnswer => ({
  id: "x",
  label: "x",
  act: "question.answer",
  path: "/api/questions/q/answer",
  body: null,
  needsReason: true,
  effect: null,
  recommended: false,
  ...over,
});

describe("the body a decision's button posts", () => {
  it("carries a steward decision's reason as the option's note", () => {
    const keep = button({ body: { round: 1, optionId: "steward.keep" } });
    expect(pressBody(keep, "Until REQ-50 is agreed.")).toEqual({
      round: 1,
      optionId: "steward.keep",
      note: "Until REQ-50 is agreed.",
    });
  });

  it("carries a free answer as text, and another act's words as its reason", () => {
    expect(pressBody(button({ body: { round: 2 } }), "Saved board")).toEqual({ round: 2, text: "Saved board" });
    expect(pressBody(button({ act: "requirement.defer", body: {} }), "later")).toEqual({ reason: "later" });
  });

  it("adds nothing to a button that takes no words", () => {
    const open = button({ needsReason: false, body: { round: 1, optionId: "steward.open" } });
    expect(pressBody(open, null)).toEqual({ round: 1, optionId: "steward.open" });
  });
});
