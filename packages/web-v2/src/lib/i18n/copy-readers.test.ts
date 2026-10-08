import { SAID_ENTRIES } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { ETA_COPY, etaLangOf } from "@/lib/i18n/eta-copy";
import { copyLocale, PRODUCT_STRINGS as product, productCopy } from "./product-copy";

// One product copy, read by both readers: every key exists in en, and a vi key is one of them (what
// core says holds its English in `@forge/contracts/said`, so the copy files hold only its vi), a tag
// resolves by its base language, and the ETA words come from the same copy the rest of the product reads.
const keysOf = (lang: "vi" | "en") => Object.keys(product[lang]).sort();

describe("the locale readers", () => {
  it("holds no vi key without its English, the registry's English counted as en", () => {
    const english = new Set([...keysOf("en"), ...Object.keys(SAID_ENTRIES)]);
    expect(keysOf("vi").filter((k) => !english.has(k))).toEqual([]);
  });

  it("holds no key twice: what core says has its English in the registry, never in the file", () => {
    expect(keysOf("en").filter((k) => k in SAID_ENTRIES)).toEqual([]);
  });

  it("resolves a tag by its base language, and anything else to en", () => {
    for (const tag of ["vi", "vi-VN", "VI"]) {
      expect(etaLangOf(tag)).toBe("vi");
      expect(copyLocale(tag)).toBe(copyLocale("vi"));
    }
    for (const tag of ["en", "en-GB", "ja", "fr-CA", "", null, undefined]) {
      expect(etaLangOf(tag)).toBe("en");
      expect(copyLocale(tag)).toBe(copyLocale("en"));
    }
  });

  it("reads the ETA words from the product copy", () => {
    expect(ETA_COPY.vi.header).toBe(product.vi["eta.header"]);
    expect(ETA_COPY.en.header).toBe(product.en["eta.header"]);
    expect(ETA_COPY.vi.latestInline("T")).toBe("muộn nhất T"); // i18n-allow: asserts the vi copy itself
    expect(productCopy("vi-VN")("whatsNew.breakdown" as never, { new: 1 })).toBe(
      productCopy("vi")("whatsNew.breakdown" as never, { new: 1 }),
    );
  });
});
