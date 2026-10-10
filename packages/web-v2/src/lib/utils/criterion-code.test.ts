import { describe, expect, it } from "vitest";
import { withoutCriterionCode } from "./criterion-code";

describe("withoutCriterionCode", () => {
  it("drops a bracketed trace code at the head", () => {
    expect(withoutCriterionCode("(REQ-43 BC-1) Every web copy string is at most 12 words.")).toBe("Every web copy string is at most 12 words.");
    expect(withoutCriterionCode("[BC-3] A record page shows 300 words.")).toBe("A record page shows 300 words.");
    expect(withoutCriterionCode("(REQ-7 r2 BC-2, BC-4) Both hold.")).toBe("Both hold.");
  });

  it("drops a code that leads the statement with a colon or a dash", () => {
    expect(withoutCriterionCode("REQ-34 BC-16: the field is named.")).toBe("the field is named.");
    expect(withoutCriterionCode("BC-5 — each fact once.")).toBe("each fact once.");
  });

  it("keeps a statement that leads with no code, and a code inside the sentence", () => {
    expect(withoutCriterionCode("Every page reads REQ-43 BC-1 as its rule.")).toBe("Every page reads REQ-43 BC-1 as its rule.");
    expect(withoutCriterionCode("BC-5 holds on the page")).toBe("BC-5 holds on the page");
  });

  it("keeps a statement that is nothing but a code", () => {
    expect(withoutCriterionCode("(REQ-43 BC-1)")).toBe("(REQ-43 BC-1)");
  });
});
