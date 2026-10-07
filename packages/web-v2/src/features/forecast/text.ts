import type { DeliveryForecast, FeedbackForecast, Forecast, ForecastPaused, ForecastSpan, ReleaseLeg, ScopeForecast } from "@forge/contracts/forecast";
import { rangeText } from "./clock";

/** "40 min", "2.6 h", "3 d": a span read as a range bound in a tooltip, never as a promise. */
export function spanText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = m / 60;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

const until = (iso: string, now: number) => (new Date(iso).getTime() - now) / 60_000;

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

/** A range as clock times in the viewer's timezone: "14:10 – 18:50 today". */
const when = (span: ForecastSpan, now: number) => rangeText(span.p50At, span.p85At, { lang: "en", now });

/** The durations and the as-of a line no longer carries: "Within 2.4 h – 31 h · as of 11:48." */
const within = (span: ForecastSpan, asOf: string, now: number) => {
  const low = Math.max(0, until(span.p50At, now));
  const high = Math.max(low, until(span.p85At, now));
  return `Within ${spanText(low)} – ${spanText(high)} · as of ${clock(asOf)}.`;
};

const pausedText = (p: ForecastPaused) => `Paused — waiting on ${p.who}${p.act ? ` to ${p.act}` : ""}`;

/** Whether a tooltip opens on the durations and the as-of; the ETA column writes its own, in the content language. */
interface TextOpts {
  within?: boolean;
}

/**
 * One line and its tooltip. A range is always two clock times and always says it is a forecast, its
 * durations and as-of in the tooltip; a pause names who owes the move instead of a date.
 */
export function forecastText(f: Forecast, now: number = Date.now(), opts: TextOpts = {}): { line: string; detail: string } {
  switch (f.kind) {
    case "forecast": {
      const b = f.basis;
      const ahead = f.ahead > 0 ? ` ${f.ahead} ahead of it${f.aheadKeys.length ? ` (${f.aheadKeys.join(", ")}${f.ahead > f.aheadKeys.length ? ", …" : ""})` : ""}.` : " Nothing ahead of it.";
      const waits = f.waitsOn.length ? ` Waits on ${f.waitsOn.join(", ")} to land first.` : "";
      return {
        line: `Forecast ${when(f, now)}`,
        detail:
          `${opts.within === false ? "" : `${within(f, f.asOf, now)} `}A forecast, not a promise: half the simulated runs land it by ${new Date(f.p50At).toLocaleString()}, 85% by ${new Date(f.p85At).toLocaleString()}.` +
          ahead +
          waits +
          ` Read from ${b.n} issues landed in the last ${b.windowDays} days${b.complexity ? ` at complexity ${b.complexity}` : ""} (p50 ${spanText(b.cycleP50Minutes)}, p85 ${spanText(b.cycleP85Minutes)}), ${b.concurrency} at a time: ${b.concurrencyBasis}.`,
      };
    }
    case "paused":
      return { line: pausedText(f), detail: f.reason };
    case "not_enough_history":
      return {
        line: `Not enough history to forecast · ${f.n} of ${f.floor} landings`,
        detail: `A forecast needs at least ${f.floor} issues landed in the window; this project has ${f.n}.`,
      };
    case "landed":
      return {
        line: f.landedAt ? `Landed ${day(f.landedAt)}` : "Landed",
        detail: f.landedAt ? `Landed ${new Date(f.landedAt).toLocaleString()}` : "Past the landing, with no merge time recorded",
      };
    case "ended":
      return { line: `Not forecast · ${f.status}`, detail: `The issue is ${f.status}; nothing is forecast for it.` };
  }
}

/** A requirement's or a draft release's line: how many have landed, then when the last will. */
export function scopeText(s: ScopeForecast, now: number = Date.now(), opts: { next?: boolean } = {}): { line: string; detail: string } {
  if (!s.forecast) return { line: "No issues to forecast", detail: "Nothing is linked to it yet." };
  const own = forecastText(s.forecast, now);
  const head = `${s.landed}/${s.total} landed`;
  if (s.forecast.kind === "landed") {
    const inHands = s.delivery?.inHands;
    const next =
      s.next && opts.next !== false
        ? ` · then ${pausedText(s.next).replace(/^Paused — w/, "w")}`
        : inHands
          ? ` · forecast live ${when(inHands, now)}`
          : "";
    const detail = s.next?.reason ?? (s.delivery ? deliveryText(s.delivery, now).detail : own.detail);
    return { line: `All ${s.total} landed${s.forecast.landedAt ? ` by ${day(s.forecast.landedAt)}` : ""}${next}`, detail };
  }
  if (s.forecast.kind === "forecast") return { line: `${head} · forecast all landed ${when(s.forecast, now)}`, detail: own.detail };
  return { line: `${head} · ${own.line}`, detail: own.detail };
}

const legDetail = (leg: ReleaseLeg): string => {
  switch (leg.kind) {
    case "automatic":
      return ` Production releases on its own: the release lag is sampled from ${leg.basis.n} releases in the last ${leg.basis.windowDays} days (p50 ${spanText(leg.basis.lagP50Minutes)}, p85 ${spanText(leg.basis.lagP85Minutes)}).`;
    case "not_enough_history":
      return ` Production releases on its own, but only ${leg.n} of the ${leg.floor} releases a release lag needs are on record, so no in-hands range is given.`;
    case "person":
      return ` Then ${leg.who} owes the release: ${leg.act}. No date is forecast for a person's act — ${leg.reason}.`;
  }
};

const waitsOnText = (leg: Extract<ReleaseLeg, { kind: "person" }>) => `waits on ${leg.who} to ${leg.act}`;

/**
 * Done as a person means it — in their hands, not merged — as one line and its tooltip: shipped in a
 * version; a range to people's hands where production releases on its own; else the landing and the
 * person who owes the release, never a date for their act.
 */
export function deliveryText(d: DeliveryForecast, now: number = Date.now(), opts: TextOpts = {}): { line: string; detail: string } {
  if (d.shipped) {
    const when = d.shipped.at ? ` · ${day(d.shipped.at)}` : "";
    return {
      line: d.shipped.version ? `Shipped in ${d.shipped.version}${when}` : `Shipped${when}`,
      detail: d.shipped.at ? `Shipped ${new Date(d.shipped.at).toLocaleString()}` : "Shipped, with no release run on record",
    };
  }
  const landing = forecastText(d.landing, now, opts);
  const leg = d.release;
  if (!leg || (d.landing.kind !== "forecast" && d.landing.kind !== "landed")) return landing;
  const lead = d.landing.kind === "landed" ? `${landing.detail}.` : landing.detail;
  const hands = d.inHands && opts.within !== false ? `In people's hands ${within(d.inHands, d.asOf, now).replace(/^W/, "w")} ` : "";
  const detail = `${hands}${lead}${legDetail(leg)}`;
  if (d.landing.kind === "landed") {
    if (d.inHands) return { line: `Fixed · forecast live ${when(d.inHands, now)}`, detail };
    if (leg.kind === "person") return { line: `Fixed · ${waitsOnText(leg)}`, detail };
    return { line: "Fixed · waits on the automatic release", detail };
  }
  const lands = `Forecast lands ${when(d.landing, now)}`;
  if (d.inHands) return { line: `Forecast live ${when(d.inHands, now)}`, detail };
  if (leg.kind === "person") return { line: `${lands} · then ${waitsOnText(leg)}`, detail };
  return { line: `${lands} · release time not known yet`, detail };
}

/** A feedback item's line: untriaged, who triages it; else its linked work's delivery; null where nothing ships. */
export function feedbackForecastText(f: FeedbackForecast, now: number = Date.now()): { line: string; detail: string } | null {
  if (f.triage) return { line: `Waiting on triage — ${f.triage.who} to ${f.triage.act}`, detail: f.triage.reason };
  return f.delivery ? deliveryText(f.delivery, now) : null;
}

/** A requirement's detail line: how many criteria are proven, then when the rest is in people's hands. */
export function criteriaRestText(
  proven: number,
  criteria: number,
  s: ScopeForecast | undefined,
  now: number = Date.now(),
): { line: string; detail: string } | null {
  if (criteria === 0) return s?.delivery ? deliveryText(s.delivery, now) : null;
  const head = proven >= criteria ? `All ${criteria} criteria proven` : `${proven} of ${criteria} criteria proven`;
  if (proven >= criteria || !s?.delivery) return { line: head, detail: "Business criteria with a passing verdict." };
  const rest = deliveryText(s.delivery, now);
  return { line: `${head} · rest ${rest.line.charAt(0).toLowerCase()}${rest.line.slice(1)}`, detail: rest.detail };
}
