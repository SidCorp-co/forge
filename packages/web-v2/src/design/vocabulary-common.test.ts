import { ENUM_LABELS, STATE_READINGS } from "@forge/contracts/ui-vocabulary";
import { describe, expect, it } from "vitest";
import { PRODUCT_STRINGS as product } from "@/lib/i18n/product-copy";
import { ENUM_COMMON, STATUS_COMMON, enumLabel, statusReading } from "./vocabulary";

// A family with no label group reads its words from `common.*`: every value the contract names has
// an English key spelled as the contract spells it. A Vietnamese one is not owed (Forge is not
// multilingual, the owner's ruling of 2026-10-08); a value with none reads in English on a vi page.

const en = product.en as Record<string, string>;
const vi = product.vi as Record<string, string>;

describe("enum and state families read from common words", () => {
  it("names every value of each family it reads, in en as the contract", () => {
    for (const [family, prefix] of Object.entries(ENUM_COMMON)) {
      for (const [value, label] of Object.entries(ENUM_LABELS[family as keyof typeof ENUM_LABELS])) {
        expect(en[`${prefix}.${value}`], `${prefix}.${value}`).toBe(label);
      }
    }
    for (const family of STATUS_COMMON) {
      for (const [value, [label]] of Object.entries(STATE_READINGS[family as keyof typeof STATE_READINGS])) {
        expect(en[`common.state.${family}.${value}`], `common.state.${family}.${value}`).toBe(label);
      }
    }
  });

  it("reads them in vi, and a value no family names sentence-cased", () => {
    expect(enumLabel("jobType", "code", "vi")).toBe(vi["common.jobType.code"]);
    expect(enumLabel("jobType", "code", "en")).toBe("Code");
    expect(statusReading("pipelineRun", "running", "vi").label).toBe(vi["common.state.pipelineRun.running"]);
    expect(enumLabel("jobType", "brand_new", "vi")).toBe("Brand new");
  });
});
