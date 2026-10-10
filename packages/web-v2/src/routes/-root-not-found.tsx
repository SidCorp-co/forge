
import { usePreferences } from "@/features/preferences/hooks";
import { NotFoundBody } from "@/features/shell/components/not-found-body";
import { InterfaceLanguageScope, resolveInterfaceLanguage } from "@/lib/i18n/interface-language";

/**
 * Global 404. Renders OUTSIDE the _workspace shell, so it is fully
 * self-contained (own centering + app background) and reads the person's own
 * interface language, else English, as the workspace does (REQ-13 BC-2).
 */
export function RootNotFound() {
  const language = resolveInterfaceLanguage(usePreferences().data?.language);
  return (
    <InterfaceLanguageScope language={language}>
      <NotFoundBody />
    </InterfaceLanguageScope>
  );
}
