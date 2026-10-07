"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useContentLanguage } from "@/lib/api/content-language";
import { useCurrentProjectRef } from "@/features/projects/current-project";
import { usePreferences } from "@/features/preferences/hooks";
import { formatAge, formatClock, formatClockSeconds, formatCompact, formatCountdown, formatDate, formatDateTime, formatElapsed, formatNumber, formatRelative } from "./format";
import { labelCopy } from "./labels";
import { baseOf, copyOr, type Copy, copyLocale, productCopy } from "./product-copy";

// The language the product's chrome is written in, one answer for every screen. The person's own
// choice wins (Account > Preferences > Interface language); with none, the open project's content
// language; with neither, English. Content a person or an agent wrote stays in the language it was
// written in: only chrome reads through here.

export const INTERFACE_LANGUAGES = ["en", "vi"] as const;
export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];

/** The chosen language, else the project's content language, else English. */
export function resolveInterfaceLanguage(
  choice: string | null | undefined,
  contentLanguage: string | null | undefined,
): InterfaceLanguage {
  const picked = choice ?? contentLanguage;
  return picked && baseOf(picked) === "vi" ? "vi" : "en";
}

const InterfaceLanguageContext = createContext<InterfaceLanguage>("en");

/** Pins the language for a subtree; the workspace shell and tests use it. */
export function InterfaceLanguageScope({ language, children }: { language: InterfaceLanguage; children: ReactNode }) {
  return <InterfaceLanguageContext.Provider value={language}>{children}</InterfaceLanguageContext.Provider>;
}

/** Resolves the language for the open project from the person's preference and the project's content language. */
export function WorkspaceInterfaceLanguage({ children }: { children: ReactNode }) {
  const projectRef = useCurrentProjectRef();
  const choice = usePreferences().data?.language;
  const content = useContentLanguage(projectRef).data?.contentLanguage;
  const language = resolveInterfaceLanguage(choice, content);
  return <InterfaceLanguageScope language={language}>{children}</InterfaceLanguageScope>;
}

/** The language chrome is written in on this screen. */
export function useInterfaceLanguage(): InterfaceLanguage {
  return useContext(InterfaceLanguageContext);
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
    }),
    [language],
  );
}
