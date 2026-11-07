
import { createContext, use, useMemo } from "react";
import { formatAge, formatClock, formatClockSeconds, formatCompact, formatCountdown, formatDate, formatDateTime, formatDuration, formatElapsed, formatNumber, formatRelative, formatShortDateTime, formatUsd, formatWhen } from "./format";
import { labelCopy } from "./labels";
import { copyOr, type Copy, copyLocale, type InterfaceLanguage, productCopy } from "./product-copy";

// The language the product's chrome is written in: English, on every screen. Forge is English only
// (owner, 2026-10-08; ISS-1071): no person's choice and no project's content language turns it, so
// there is no choice to read and no scope to set. Content a person or an agent wrote stays in the
// language it was written in (`written.tsx`). Every reader below takes the one language, so a screen
// still says which language it formats in, and the readers refuse any other by name (`englishOnly`).

// Priced amnesty (ISS-1071): 122 files still thread the one language from this hook into the readers.
// Dropping the hook and the `language` parameters is a sweep across files ISS-1070 holds (the issue
// page, the shell's reads), so it waits for that batch to land; until then nothing provides this
// context and every screen reads its English default. It ends with the sweep that deletes the hook.
const InterfaceLanguageContext = createContext<InterfaceLanguage>("en");

/** The language chrome is written in on this screen: English. */
export function useInterfaceLanguage(): InterfaceLanguage {
  return use(InterfaceLanguageContext);
}

/** A reader of the chrome in the interface language. */
export function useCopy(): Copy {
  const language = useInterfaceLanguage();
  return useMemo(() => productCopy(language), [language]);
}

/** The BCP 47 locale dates, times and numbers are drawn in: en-GB (24h, day before month). */
export function useCopyLocale(): string {
  return copyLocale(useInterfaceLanguage());
}

/** A reader of the contracts' enum labels (a state, a phase, an area). */
export function useLabel() {
  const language = useInterfaceLanguage();
  return useMemo(() => labelCopy(language), [language]);
}

/** A navigation entry's label: the copy file's `nav.<key>` where the entry has one, else the label it was built with (a project's or ecosystem's own name). */
export function useNavLabel() {
  const language = useInterfaceLanguage();
  return (key: string, label: string): string => copyOr(language, `nav.${key}`, label);
}

/** The relative time, `5m ago`, and the absolute date and time; every screen formats through these. */
export function useTimeFormat() {
  const language = useInterfaceLanguage();
  return useMemo(
    () => ({
      relative: (iso: string | null | undefined, now?: number) => formatRelative(iso, language, now),
      age: (iso: string | null | undefined, now?: number) => formatAge(iso, language, now),
      elapsed: (ms: number) => formatElapsed(ms, language),
      countdown: (iso: string | null | undefined, now?: number) => formatCountdown(iso, language, now),
      number: (n: number) => formatNumber(n, language),
      dateTime: (at: string | number | Date) => formatDateTime(at, language),
      shortDateTime: (at: string | number | Date) => formatShortDateTime(at, language),
      date: (at: string | number | Date) => formatDate(at, language),
      clock: (at: string | number | Date) => formatClock(at, language),
      clockSeconds: (at: string | number | Date) => formatClockSeconds(at, language),
      compact: (n: number) => formatCompact(n, language),
      duration: (ms: number | null | undefined) => formatDuration(ms, language),
      usd: (usd: number | null | undefined) => formatUsd(usd, language),
      when: (at: string | number | null | undefined) => formatWhen(at, language),
    }),
    [language],
  );
}
