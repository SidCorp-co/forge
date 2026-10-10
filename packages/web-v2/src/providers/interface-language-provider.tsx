
import type { ReactNode } from "react";
import { usePreferences } from "@/features/preferences";
import { InterfaceLanguageScope, resolveInterfaceLanguage } from "@/lib/i18n/interface-language";

/** Resolves the workspace's chrome language from the person's preference alone. */
export function WorkspaceInterfaceLanguage({ children }: { children: ReactNode }) {
  const language = resolveInterfaceLanguage(usePreferences().data?.language);
  return <InterfaceLanguageScope language={language}>{children}</InterfaceLanguageScope>;
}
