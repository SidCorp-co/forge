import { describe, expect, it } from "vitest";
import { ETA_COPY, etaLangOf } from "@/features/forecast/eta-copy";
import product from "./product-copy.json";
import { copyLocale, productCopy } from "./product-copy";

// One locale file, read by both readers: every key exists in vi and en, a tag resolves by its base
// language, and the ETA words come from the same file the product copy does.
const keysOf = (lang: "vi" | "en") => Object.keys(product[lang]).sort();

describe("the locale readers", () => {
  it("holds the same keys in vi and en", () => {
    expect(keysOf("vi")).toEqual(keysOf("en"));
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

  it("reads the ETA words from the product copy file", () => {
    expect(ETA_COPY.vi.header).toBe(product.vi["eta.header" as keyof typeof product.vi]);
    expect(ETA_COPY.en.header).toBe(product.en["eta.header" as keyof typeof product.en]);
    expect(ETA_COPY.vi.latestInline("T")).toBe("muộn nhất T"); // i18n-allow: asserts the vi copy itself
    expect(productCopy("vi-VN")("whatsNew.breakdown" as never, { new: 1 })).toBe(
      productCopy("vi")("whatsNew.breakdown" as never, { new: 1 }),
    );
  });
});
