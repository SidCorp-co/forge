"use client";

import { usePreferences } from "@/features/preferences/hooks";
import { NotFoundBody } from "@/features/shell/components/not-found-body";
import { InterfaceLanguageScope, resolveInterfaceLanguage } from "@/lib/i18n/interface-language";

/**
 * Global 404. Renders OUTSIDE the (workspace) shell, so it is fully
 * self-contained (own centering + app background) and reads the person's own
 * interface language: there is no open project to fall back on. `next/link`
 * auto-prefixes the basePath; web-v2 serves at root (ISS-397) so Home resolves to `/`.
 */
export default function NotFound() {
  const language = resolveInterfaceLanguage(usePreferences().data?.language, null);
  return (
    <InterfaceLanguageScope language={language}>
      <NotFoundBody />
    </InterfaceLanguageScope>
  );
}
