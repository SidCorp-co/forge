import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ETA_COPY, etaLangOf } from "@/features/forecast/eta-copy";
import golden from "./copy-readers.golden.json";
import product from "./product-copy.json";
import { copyLocale, productCopy } from "./product-copy";

// Golden: every word both locale readers return today, vi and en, so folding the two readers into
// one cannot move a word. `copy-readers.golden.json` is the pre-merge output, recorded once.
const GOLDEN_PATH = "src/lib/i18n/copy-readers.golden.json";
const TAGS = ["vi", "vi-VN", "VI", "en", "en-GB", "ja", "fr-CA", "", null, undefined];

function etaDump() {
  const out: Record<string, unknown> = {};
  for (const lang of ["vi", "en"] as const) {
    const c = ETA_COPY[lang];
    out[lang] = {
      header: c.header, locale: c.locale, today: c.today, todayInline: c.todayInline, tomorrow: c.tomorrow,
      tomorrowInline: c.tomorrowInline, yesterday: c.yesterday, weekdays: c.weekdays,
      dates: [c.date(3, 1), c.date(14, 10), c.date(31, 12)],
      latest: c.latest("T"), latestInline: c.latestInline("T"), waitsOn: c.waitsOn("W"), thenCuts: c.thenCuts("W"),
      within: c.within("L", "H", "A"), notEnoughHistory: c.notEnoughHistory(3, 10), notForecast: c.notForecast("S"),
      nothingLinked: c.nothingLinked, landed: c.landed("T"), shipped: c.shipped("v1", "T"), shippedUnversioned: c.shipped(null, "T"),
      sortBy: c.sortBy,
    };
  }
  out.langs = TAGS.map((t) => etaLangOf(t));
  return out;
}

function productDump() {
  const vars = { count: 2, current: 1, new: 3, name: "N", total: 4, state: "S", days: 7, revision: 5, screens: 6, improved: 8, fixed: 9, date: "D" };
  const out: Record<string, unknown> = {};
  for (const tag of TAGS) {
    const t = productCopy(tag);
    out[String(tag)] = {
      locale: copyLocale(tag),
      words: Object.fromEntries(Object.keys(product.en).filter((k) => !k.startsWith("eta.")).map((k) => [k, [t(k as never), t(k as never, vars)]])),
      unfilled: t("whatsNew.breakdown" as never, { new: 1 }),
    };
  }
  return out;
}

const keysOf = (lang: "vi" | "en") => Object.keys(product[lang]).sort();

const dump = () => JSON.parse(JSON.stringify({ eta: etaDump(), product: productDump() }));

describe("the two locale readers, pinned", () => {
  it("holds the same keys in vi and en", () => {
    expect(keysOf("vi")).toEqual(keysOf("en"));
  });

  it("returns the recorded words in vi and en for every tag", () => {
    if (process.env.RECORD_COPY_GOLDEN) writeFileSync(GOLDEN_PATH, `${JSON.stringify(dump(), null, 2)}\n`);
    expect(dump()).toEqual(golden);
  });
});
