import { useMemo } from "react";
import { useNow } from "@/design";
import type { EtaClock } from "./eta-clock-words";
import { useInterfaceLanguage } from "./interface-language";

/** The ETA column's language and clock: the interface language, the viewer's timezone, now. Every feature that draws a date as the Requirements list does reads it here. */
export function useEtaClock(): EtaClock {
  const lang = useInterfaceLanguage();
  const now = useNow(60_000);
  return useMemo(() => ({ lang, now }), [lang, now]);
}
