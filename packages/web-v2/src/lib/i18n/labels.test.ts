import { describe, expect, it } from "vitest";
import { LABEL_GROUPS, labelCopy, labelKey } from "./labels";
import product from "./product-copy.json";

// Every value of every contract enum has its label in both languages, and the English one is the
// contract's own word, so the locale file and the contracts cannot drift apart unseen.
const en = product.en as Record<string, string>;
const vi = product.vi as Record<string, string>;

describe("the enum labels of the contracts", () => {
  for (const [group, labels] of Object.entries(LABEL_GROUPS)) {
    it(`${group}: each value reads in en as the contract says it and has a vi word`, () => {
      for (const [value, label] of Object.entries(labels)) {
        const key = labelKey(group as keyof typeof LABEL_GROUPS, value);
        expect(en[key], key).toBe(label);
        expect(vi[key], key).toBeTruthy();
      }
    });
  }

  it("reads vi where the language has the word, and the contract's English for a value no file names", () => {
    expect(labelCopy("vi")("requirementState", "in_delivery")).toBe(vi["label.requirementState.in_delivery"]);
    expect(labelCopy("en")("requirementState", "in_delivery")).toBe("In delivery");
    expect(labelCopy("vi")("requirementState", "a_new_state")).toBe("a_new_state");
  });
});
