"use client";

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useContentLanguage } from "@/lib/api/content-language";
import { useCurrentProject } from "@/features/projects/current-project";
import { usePreferences } from "@/features/preferences/hooks";
import { labelCopy } from "./labels";
import { baseOf, type Copy, copyLocale, productCopy } from "./product-copy";

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
  const project = useCurrentProject();
  const choice = usePreferences().data?.language;
  const content = useContentLanguage(project?.id).data?.contentLanguage;
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
