"use client";

import { createContext, type ReactNode, use, useMemo } from "react";
import { formatAge, formatClock, formatClockSeconds, formatCompact, formatCountdown, formatDate, formatDateTime, formatDuration, formatElapsed, formatNumber, formatRelative, formatUsd, formatWhen } from "./format";
import { labelCopy } from "./labels";
import { baseOf, copyOr, type Copy, copyLocale, productCopy } from "./product-copy";

// The language the product's chrome is written in, one answer for every screen: the person's own
// choice (Account > Preferences > Interface language), else English. Forge is English only (owner,
// 2026-10-08; REQ-13 BC-2): a project's content language governs what agents write and the product's
// own content, never Forge's chrome, so a Vietnamese project no longer turns the menus Vietnamese.
// Content a person or an agent wrote stays in the language it was written in.

export const INTERFACE_LANGUAGES = ["en", "vi"] as const;
export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];

/**
 * The chosen language, else English; never the project's content language. The second parameter is
 * not read: it stays only so interface-language.test.tsx, which the POC room may not edit (owner,
 * 2026-10-10), still compiles. Amnesty, priced: the signature lies about an input it ignores; it ends
 * when the review issue rewrites that test, and the parameter is deleted with it.
 */
export function resolveInterfaceLanguage(choice: string | null | undefined, _unread?: string | null): InterfaceLanguage {
  return choice && baseOf(choice) === "vi" ? "vi" : "en";
}

const InterfaceLanguageContext = createContext<InterfaceLanguage>("en");

/** Pins the language for a subtree; the workspace shell and tests use it. */
export function InterfaceLanguageScope({ language, children }: { language: InterfaceLanguage; children: ReactNode }) {
  return <InterfaceLanguageContext value={language}>{children}</InterfaceLanguageContext>;
}

/** The language chrome is written in on this screen. */
export function useInterfaceLanguage(): InterfaceLanguage {
  return use(InterfaceLanguageContext);
}

/** A reader of the chrome in the interface language. */
export function useCopy(): Copy {
  const language = useInterfaceLanguage();
  return useMemo(() => productCopy(language), [language]);
}

/** The BCP 47 locale dates, times and numbers are drawn in: vi-VN (24h, dd/MM/yyyy) or en-GB (24h). */
export function useCopyLocale(): string {
  return copyLocale(useInterfaceLanguage());
}

/** A reader of the contracts' enum labels (a state, a phase, an area) in the interface language. */
export function useLabel() {
  const language = useInterfaceLanguage();
  return useMemo(() => labelCopy(language), [language]);
}

/** A navigation entry's label: the locale file's `nav.<key>` where the entry has one, else the label it was built with (a project's or ecosystem's own name). */
export function useNavLabel() {
  const language = useInterfaceLanguage();
  return (key: string, label: string): string => copyOr(language, `nav.${key}`, label);
}

/** The language-aware relative time, `5m ago` and its Vietnamese reading, and the absolute date and time; every screen formats through these. */
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
