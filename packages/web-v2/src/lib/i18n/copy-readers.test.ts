import { SAID_ENTRIES } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { ETA_COPY, etaLangOf } from "@/features/forecast/eta-copy";
import { copyLocale, PRODUCT_STRINGS as product, productCopy } from "./product-copy";

// One product copy, read by both readers: every key exists in vi and en (what core says holds its
// English in `@forge/contracts/said`, so the copy files hold only its vi), a tag resolves by its base
// language, and the ETA words come from the same copy the rest of the product reads.
const keysOf = (lang: "vi" | "en") => Object.keys(product[lang]).sort();

describe("the locale readers", () => {
  it("holds the same keys in vi and en, the registry's English counted as en", () => {
    expect(keysOf("vi")).toEqual([...keysOf("en"), ...Object.keys(SAID_ENTRIES)].sort());
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
