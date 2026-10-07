import words from "./eta-copy.json";

// The ETA column's words, in the project's content language (contracts `content-language.ts`): vi
// where the project writes Vietnamese, English for every other tag. The words live in one locale
// file, `eta-copy.json`, both languages side by side under the same keys; a `{name}` in a word is
// filled here, and a key missing from either language is a type error.

export const ETA_LANGS = ["vi", "en"] as const;
export type EtaLang = (typeof ETA_LANGS)[number];

/** The ETA copy for a project's content language tag: vi for any vi tag, else English. */
export const etaLangOf = (contentLanguage: string | null | undefined): EtaLang =>
  contentLanguage?.toLowerCase().startsWith("vi") ? "vi" : "en";

type Words = (typeof words)["en"];

export interface EtaCopy {
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
  /** A release a person still cuts after the landing. */
  thenCuts: (who: string) => string;
  /** Tooltip heads: the durations and the as-of stay here, never in the cell. */
  within: (low: string, high: string, asOf: string) => string;
  notEnoughHistory: (n: number, floor: number) => string;
  notForecast: (status: string) => string;
  nothingLinked: string;
  landed: (when: string) => string;
  shipped: (version: string | null, when: string) => string;
  sortBy: string;
}

const fill = (word: string, values: Record<string, string | number>) =>
  word.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = values[k];
    if (v === undefined) throw new Error(`eta-copy: "${word}" names {${k}}, which nothing fills`);
    return String(v);
  });

function copyOf(w: Words): EtaCopy {
  return {
    header: w.header,
    locale: w.locale,
    today: w.today,
    todayInline: w.todayInline,
    tomorrow: w.tomorrow,
    tomorrowInline: w.tomorrowInline,
    yesterday: w.yesterday,
    weekdays: w.weekdays,
    date: (day, month) => fill(w.date, { d: day, dd: String(day).padStart(2, "0"), month: w.months[month - 1] ?? String(month) }),
    latest: (when) => fill(w.latest, { when }),
    latestInline: (when) => fill(w.latestInline, { when }),
    waitsOn: (who) => fill(w.waitsOn, { who }),
    thenCuts: (who) => fill(w.thenCuts, { who }),
    within: (low, high, asOf) => fill(w.within, { low, high, asOf }),
    notEnoughHistory: (n, floor) => fill(w.notEnoughHistory, { n, floor }),
    notForecast: (status) => fill(w.notForecast, { status }),
    nothingLinked: w.nothingLinked,
    landed: (when) => fill(w.landed, { when }),
    shipped: (version, when) => (version ? fill(w.shipped, { version, when }) : fill(w.shippedUnversioned, { when })).replace(/ \.$/, "."),
    sortBy: w.sortBy,
  };
}

export const ETA_COPY: Record<EtaLang, EtaCopy> = { vi: copyOf(words.vi), en: copyOf(words.en) };
