// What a forecast owes its reader beside the date (journey walk F2): how far it last moved and the
// event that moved it ("moved 2 h later because ISS-88 moved to awaiting release"), how far it can be leaned on,
// and the release it lands in. Every part is core's (`ForecastMove`, `ForecastConfidence`, the
// release leg's version); this only says it in the reader's language.

import type { DeliveryForecast, ForecastMove } from "@forge/contracts/forecast";
import type { Copy } from "@/lib/i18n/product-copy";
import { said } from "@/lib/i18n/said";
import type { EtaClock } from "./clock";
import { spanText } from "./text";

type Lang = EtaClock["lang"];

/** "moved 2 h later because …", or null where the dates have not moved. */
export function movedText(m: ForecastMove | null | undefined, t: Copy, lang: Lang): string | null {
  if (!m || m.byMinutes === 0) return null;
  const vars = { by: spanText(Math.abs(m.byMinutes), lang), because: said(m.because, lang) };
  return t(m.byMinutes > 0 ? "fc.moved.later" : "fc.moved.earlier", vars);
}

/** The confidence and target release a delivery's forecast carries, each where core gave one. */
export function forecastFacts(d: DeliveryForecast | null | undefined, t: Copy): string[] {
  if (!d) return [];
  const out: string[] = [];
  if (d.landing.kind === "forecast") out.push(t(`fc.confidence.${d.landing.confidence.level}`));
  if (d.release?.kind === "person" && d.release.version) out.push(t("fc.inRelease", { v: d.release.version }));
  return out;
}

/** Everything above as one line, the move first. */
export function honestyLine(d: DeliveryForecast | null | undefined, m: ForecastMove | null | undefined, t: Copy, lang: Lang): string | null {
  const parts = [movedText(m, t, lang), ...forecastFacts(d, t)].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(" · ") : null;
}
