"use client";

import type { Forecast, ScopeForecast } from "@forge/contracts/forecast";
import { forecastText, scopeText } from "../text";

/** The forecast as one flat line, its reasons on hover. */
export function ForecastLine({ forecast }: { forecast: Forecast }) {
  const { line, detail } = forecastText(forecast);
  return (
    <span className="fg-body-sm text-muted" title={detail} data-testid="forecast-line" data-kind={forecast.kind}>
      {line}
    </span>
  );
}

export function ScopeForecastLine({ scope }: { scope: ScopeForecast }) {
  const { line, detail } = scopeText(scope);
  return (
    <span className="fg-body-sm text-muted" title={detail} data-testid="scope-forecast-line" data-kind={scope.forecast?.kind ?? "empty"}>
      {line}
    </span>
  );
}
