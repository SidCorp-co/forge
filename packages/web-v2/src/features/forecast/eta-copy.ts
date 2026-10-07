import { baseOf, copyLocale, type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";

// The ETA column's words, in the project's content language (contracts `content-language.ts`): vi
// where the project writes Vietnamese, English for every other tag. The words are the `eta.*` keys
// of the one locale file, `lib/i18n/product-copy.json`, read through `productCopy`.

const ETA_LANGS = ["vi", "en"] as const;
export type EtaLang = (typeof ETA_LANGS)[number];

/** The ETA copy for a project's content language tag: vi for any vi tag, else English. */
export const etaLangOf = (contentLanguage: string | null | undefined): EtaLang =>
  baseOf(contentLanguage) === "vi" ? "vi" : "en";

interface EtaCopy {
  /** The column header and the rail's label. */
  header: string;
  /** BCP 47 tag the full dates in a tooltip are drawn in. */
  locale: string;
  /** Day words where they start a cell, and where they follow a clock or `latest` mid-line. */
  today: string;
  todayInline: string;
  tomorrow: string;
  tomorrowInline: string;
  yesterday: string;
  /** Sunday first, as `Date.getDay()` counts. */
  weekdays: readonly string[];
  /** A date beyond a week, from its day and its month (1–12). */
  date: (day: number, month: number) => string;
  /** The p85 as the cell's quiet second line, and mid-line on the rail. */
  latest: (when: string) => string;
  latestInline: (when: string) => string;
  /** A paused row: whom it waits on. */
  waitsOn: (who: string) => string;
  /** A release a person still cuts after the landing, and the same where the viewer cuts it. */
  thenCuts: (who: string) => string;
  thenYouCut: string;
  /** Tooltip heads: the durations and the as-of stay here, never in the cell. */
  within: (low: string, high: string, asOf: string) => string;
  notEnoughHistory: (n: number, floor: number) => string;
  notForecast: (status: string) => string;
  nothingLinked: string;
  landed: (when: string) => string;
  /** The cell of a change landed and not yet in people's hands, which carries no date. */
  awaitingRelease: string;
  shipped: (version: string | null, when: string) => string;
  sortBy: string;
}

const WEEKDAYS = ["eta.weekday.0", "eta.weekday.1", "eta.weekday.2", "eta.weekday.3", "eta.weekday.4", "eta.weekday.5", "eta.weekday.6"] as const;
const MONTHS = [
  "eta.month.1", "eta.month.2", "eta.month.3", "eta.month.4", "eta.month.5", "eta.month.6",
  "eta.month.7", "eta.month.8", "eta.month.9", "eta.month.10", "eta.month.11", "eta.month.12",
] as const satisfies readonly ProductCopyKey[];

function copyOf(lang: EtaLang): EtaCopy {
  const t = productCopy(lang);
  return {
    header: t("eta.header"),
    locale: copyLocale(lang),
    today: t("eta.today"),
    todayInline: t("eta.todayInline"),
    tomorrow: t("eta.tomorrow"),
    tomorrowInline: t("eta.tomorrowInline"),
    yesterday: t("eta.yesterday"),
    weekdays: WEEKDAYS.map((k) => t(k)),
    date: (day, month) => t("eta.date", { d: day, dd: String(day).padStart(2, "0"), month: MONTHS[month - 1] ? t(MONTHS[month - 1] as ProductCopyKey) : String(month) }),
    latest: (when) => t("eta.latest", { when }),
    latestInline: (when) => t("eta.latestInline", { when }),
    waitsOn: (who) => t("eta.waitsOn", { who }),
    thenCuts: (who) => t("eta.thenCuts", { who }),
    thenYouCut: t("eta.thenYouCut"),
    within: (low, high, asOf) => t("eta.within", { low, high, asOf }),
    notEnoughHistory: (n, floor) => t("eta.notEnoughHistory", { n, floor }),
    notForecast: (status) => t("eta.notForecast", { status }),
    nothingLinked: t("eta.nothingLinked"),
    landed: (when) => t("eta.landed", { when }),
    awaitingRelease: t("eta.awaitingRelease"),
    shipped: (version, when) => (version ? t("eta.shipped", { version, when }) : t("eta.shippedUnversioned", { when })).replace(/ \.$/, "."),
    sortBy: t("eta.sortBy"),
  };
}

export const ETA_COPY: Record<EtaLang, EtaCopy> = { vi: copyOf("vi"), en: copyOf("en") };
