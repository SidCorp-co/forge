"use client";

import type { DeliveryForecast, Forecast, ScopeForecast } from "@forge/contracts/forecast";
import { deliveryText, forecastText, scopeText } from "../text";

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

/** When it is in people's hands, or who owes the release, as one flat line. */
export function DeliveryLine({ delivery }: { delivery: DeliveryForecast }) {
  const { line, detail } = deliveryText(delivery);
  return (
    <span className="fg-body-sm text-muted" title={detail} data-testid="delivery-line" data-kind={delivery.shipped ? "shipped" : delivery.landing.kind}>
      {line}
    </span>
  );
}
