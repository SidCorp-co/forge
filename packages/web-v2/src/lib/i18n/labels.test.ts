// A contract enum gaining a value, or a copy file losing a label, selects this test (ISS-600's
// `mockup` feedback target landed with no label and the merge check never ran it).
// @direct-test-of packages/contracts/src/
// @direct-test-of packages/web-v2/src/lib/i18n/copy/
import { describe, expect, it } from "vitest";
import { LABEL_GROUPS, labelCopy, labelKey } from "./labels";
import { PRODUCT_STRINGS as product } from "./product-copy";

// Every value of every contract enum has its English label, the contract's own word, so the locale
// file and the contracts cannot drift apart unseen.
const en: Record<string, string> = product.en;

describe("the enum labels of the contracts", () => {
  for (const [group, labels] of Object.entries(LABEL_GROUPS)) {
    it(`${group}: each value reads in en as the contract says it`, () => {
      for (const [value, label] of Object.entries(labels)) {
        const key = labelKey(group as keyof typeof LABEL_GROUPS, value);
        expect(en[key], key).toBe(label);
      }
    });
  }

  it("reads the word the file has, and the value itself for one no file names", () => {
    expect(labelCopy("en")("requirementState", "in_delivery")).toBe("In delivery");
    expect(labelCopy("en")("requirementState", "a_new_state")).toBe("a_new_state");
  });
});
