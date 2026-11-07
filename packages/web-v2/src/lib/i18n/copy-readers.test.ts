import { SAID_ENTRIES } from "@forge/contracts/said";
import { say } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { ETA_COPY } from "@/lib/i18n/eta-copy";
import { labelCopy } from "./labels";
import { copyLocale, copyOr, PRODUCT_STRINGS as product, productCopy, productCopyTemplate } from "./product-copy";
import { said } from "./said";

// One product copy, in English (owner, 2026-10-08, ISS-1071): every key exists once, what core says
// holds its English in `@forge/contracts/said` and never in a file, the ETA words come from the same
// copy, and a reader asked for any other language refuses it by name rather than drawing English.

describe("the copy readers", () => {
  it("holds no key twice: what core says has its English in the registry, never in the file", () => {
    expect(Object.keys(product.en).filter((k) => k in SAID_ENTRIES)).toEqual([]);
    expect(Object.keys(product)).toEqual(["en"]);
  });

  it("reads English for English and an unnamed language, in the en-GB locale", () => {
    for (const tag of ["en", "en-GB", "EN", null, undefined]) {
      expect(copyLocale(tag)).toBe("en-GB");
      expect(productCopy(tag)("eta.header")).toBe(product.en["eta.header"]);
    }
  });

  it("refuses every other language by name, in each reader", () => {
    const refused = /No product copy is written in "vi": Forge is English only/;
    expect(() => productCopy("vi")).toThrow(refused);
    expect(() => copyLocale("vi")).toThrow(refused);
    expect(() => copyOr("vi", "eta.header", "x")).toThrow(refused);
    expect(() => productCopyTemplate("vi", "eta.header")).toThrow(refused);
    expect(() => labelCopy("vi")("requirementState", "in_delivery")).toThrow(refused);
    expect(() => said(say("standing.who.master"), "vi")).toThrow(refused);
    expect(() => productCopy("vi-VN")).toThrow('No product copy is written in "vi-VN"');
  });

  it("reads the ETA words from the product copy", () => {
    expect(Object.keys(ETA_COPY)).toEqual(["en"]);
    expect(ETA_COPY.en.header).toBe(product.en["eta.header"]);
  });
});
