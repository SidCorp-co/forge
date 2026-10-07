"use client";

import type { ScopeForecast } from "@forge/contracts/forecast";
import { useEtaClock } from "../hooks";
import { scopeText } from "../text";

export function ScopeForecastLine({ scope }: { scope: ScopeForecast }) {
  const { line, detail } = scopeText(scope, useEtaClock());
  return (
    <span className="fg-body-sm text-muted" title={detail} data-testid="scope-forecast-line" data-kind={scope.forecast?.kind ?? "empty"}>
      {line}
    </span>
  );
}
