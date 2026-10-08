"use client";

import type { ScopeForecast } from "@forge/contracts/forecast";
import { useCopy } from "@/lib/i18n/interface-language";
import { said } from "@/lib/i18n/said";
import { formatDateTime } from "@/lib/i18n/format";
import { honestyLine } from "../honesty";
import { useEtaClock } from "@/lib/i18n/eta-clock";
import { scopeText } from "../text";

export function ScopeForecastLine({ scope }: { scope: ScopeForecast }) {
  const clock = useEtaClock();
  const t = useCopy();
  const { line, detail } = scopeText(scope, clock);
  const honest = honestyLine(scope.delivery, scope.moved, t, clock.lang);
  const anchored = t("fc.anchoredHint", { at: formatDateTime(scope.anchor.at, clock.lang, clock.timeZone), event: said(scope.anchor.event, clock.lang) });
  return (
    <span className="fg-body-sm text-muted" title={`${detail}\n${anchored}`} data-testid="scope-forecast-line" data-kind={scope.forecast?.kind ?? "empty"}>
      {line}
      {honest ? <span className="block text-12-5" data-testid="forecast-honesty">{honest}</span> : null}
    </span>
  );
}
