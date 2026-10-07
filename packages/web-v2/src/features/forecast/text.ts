import type { DeliveryForecast, FeedbackForecast, Forecast, ForecastPaused, ForecastSpan, ReleaseLeg, ScopeForecast } from "@forge/contracts/forecast";
import { formatClock, formatDateTime, formatNumber } from "@/lib/i18n/format";
import { labelCopy } from "@/lib/i18n/labels";
import { type Copy, productCopy } from "@/lib/i18n/product-copy";
import { standingAct, standingWho } from "@/lib/i18n/standing-copy";
import { type EtaClock, partsOf, rangeText } from "./clock";
import { ETA_COPY } from "./eta-copy";

// The forecast sentences a screen reads: a line, and the tooltip behind it. Their words are the
// `fc.*` keys of the locale file, drawn in the clock's language; the names, keys and versions in
// them are core's, and the `reason` a forecast carries is core's English and stays so.

type Lang = EtaClock["lang"];

/** "40 min", "2.6 h", "3 d": a span read as a range bound in a tooltip, never as a promise. */
export function spanText(minutes: number, lang: Lang = "en"): string {
  const t = productCopy(lang);
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return t("fc.span.min", { n: Math.max(1, m) });
  const h = m / 60;
  if (h < 48) {
    const n = h < 10 ? new Intl.NumberFormat(lang === "vi" ? "vi-VN" : "en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(h) : formatNumber(Math.round(h), lang);
    return t("fc.span.h", { n });
  }
  return t("fc.span.d", { n: Math.round(h / 24) });
}

const until = (iso: string, now: number) => (new Date(iso).getTime() - now) / 60_000;

/** A day as the ETA column writes it: "Oct 7" in English, "07/10" in Vietnamese. */
const dayOf = (iso: string, c: EtaClock) => {
  const p = partsOf(Date.parse(iso), c.timeZone);
  return ETA_COPY[c.lang].date(p.d, p.m);
};

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** A range as clock times in the viewer's timezone: "14:10 – 18:50 today". */
const when = (span: ForecastSpan, c: EtaClock) => rangeText(span.p50At, span.p85At, c);

/** The durations and the as-of a line no longer carries: "Within 2.4 h – 31 h · as of 11:48." */
const within = (span: ForecastSpan, asOf: string, c: EtaClock) => {
  const low = Math.max(0, until(span.p50At, c.now));
  const high = Math.max(low, until(span.p85At, c.now));
  return productCopy(c.lang)("eta.within", { low: spanText(low, c.lang), high: spanText(high, c.lang), asOf: formatClock(asOf, c.lang, c.timeZone) });
};

const PAUSED_KEYS = {
  paused: ["fc.paused", "fc.pausedTo"],
  waitsOn: ["fc.waitsOn", "fc.waitsOnTo"],
  waitingOn: ["fc.waitingOn", "fc.waitingOnTo"],
} as const;
const pausedBody = (t: Copy, p: ForecastPaused, c: EtaClock, head: keyof typeof PAUSED_KEYS) => {
  const who = standingWho(p.who, c.lang);
  const [bare, withAct] = PAUSED_KEYS[head];
  return p.act ? t(withAct, { who, act: standingAct(p.act, c.lang) }) : t(bare, { who });
};
const pausedText = (p: ForecastPaused, c: EtaClock) => pausedBody(productCopy(c.lang), p, c, "paused");

/** A line, its tooltip, and the release it names where it names one: the version a reader can open. */
export interface Said {
  line: string;
  detail: string;
  release?: string | null;
}

/** Whether a tooltip opens on the durations and the as-of; the ETA column writes its own. */
interface TextOpts {
  within?: boolean;
}

export const statusWord = (status: string, lang: Lang) => (lang === "en" ? status : labelCopy(lang)("issueStatus", status).toLowerCase());

/**
 * One line and its tooltip. A range is always two clock times and always says it is a forecast, its
 * durations and as-of in the tooltip; a pause names who owes the move instead of a date.
 */
export function forecastText(f: Forecast, c: EtaClock, opts: TextOpts = {}): { line: string; detail: string } {
  const t = productCopy(c.lang);
  switch (f.kind) {
    case "forecast": {
      const b = f.basis;
      const keys = `${f.aheadKeys.join(", ")}${f.ahead > f.aheadKeys.length ? ", …" : ""}`;
      const ahead = f.ahead > 0 ? (f.aheadKeys.length ? t("fc.aheadKeys", { n: f.ahead, keys }) : t("fc.ahead", { n: f.ahead })) : t("fc.nothingAhead");
      const waits = f.waitsOn.length ? t("fc.waitsLanding", { keys: f.waitsOn.join(", ") }) : "";
      return {
        line: t("fc.forecastLine", { when: when(f, c) }),
        detail:
          `${opts.within === false ? "" : `${within(f, f.asOf, c)} `}${t("fc.notPromise", { p50: formatDateTime(f.p50At, c.lang, c.timeZone), p85: formatDateTime(f.p85At, c.lang, c.timeZone) })}` +
          ahead +
          waits +
          t("fc.readFrom", {
            n: b.n,
            days: b.windowDays,
            complexity: b.complexity ? t("fc.atComplexity", { c: b.complexity }) : "",
            p50: spanText(b.cycleP50Minutes, c.lang),
            p85: spanText(b.cycleP85Minutes, c.lang),
            concurrency: b.concurrency,
            basis: b.concurrencyBasis,
          }),
      };
    }
    case "paused":
      return { line: pausedText(f, c), detail: f.reason };
    case "not_enough_history":
      return { line: t("fc.notEnoughLine", { n: f.n, floor: f.floor }), detail: t("fc.notEnoughDetail", { n: f.n, floor: f.floor }) };
    case "landed":
      return {
        line: f.landedAt ? t("fc.landedLine", { day: dayOf(f.landedAt, c) }) : t("fc.landed"),
        detail: f.landedAt ? t("fc.landedDetail", { at: formatDateTime(f.landedAt, c.lang, c.timeZone) }) : t("fc.landedNoTime"),
      };
    case "ended":
      return { line: t("fc.endedLine", { status: statusWord(f.status, c.lang) }), detail: t("fc.endedDetail", { status: statusWord(f.status, c.lang) }) };
  }
}

/** A requirement's or a draft release's line: how many have landed, then when the last will. */
export function scopeText(s: ScopeForecast, c: EtaClock, opts: { next?: boolean } = {}): { line: string; detail: string } {
  const t = productCopy(c.lang);
  if (!s.forecast) return { line: t("fc.noIssues"), detail: t("eta.nothingLinked") };
  const own = forecastText(s.forecast, c);
  const head = t("fc.scopeHead", { landed: s.landed, total: s.total });
  if (s.forecast.kind === "landed") {
    const inHands = s.delivery?.inHands;
    const next =
      s.next && opts.next !== false
        ? t("fc.thenWaits", { waits: pausedBody(t, s.next, c, "waitingOn") })
        : inHands
          ? t("fc.forecastLiveInline", { when: when(inHands, c) })
          : "";
    const detail = s.next?.reason ?? (s.delivery ? deliveryText(s.delivery, c).detail : own.detail);
    const by = s.forecast.landedAt ? t("fc.landedBy", { day: dayOf(s.forecast.landedAt, c) }) : "";
    return { line: t("fc.allLanded", { total: s.total, by, next }), detail };
  }
  if (s.forecast.kind === "forecast") return { line: t("fc.scopeForecast", { head, when: when(s.forecast, c) }), detail: own.detail };
  return { line: `${head} · ${own.line}`, detail: own.detail };
}

const legDetail = (leg: ReleaseLeg, c: EtaClock): string => {
  const t = productCopy(c.lang);
  switch (leg.kind) {
    case "automatic":
      return t("fc.legAutomatic", { n: leg.basis.n, days: leg.basis.windowDays, p50: spanText(leg.basis.lagP50Minutes, c.lang), p85: spanText(leg.basis.lagP85Minutes, c.lang) });
    case "not_enough_history":
      return t("fc.legNotEnough", { n: leg.n, floor: leg.floor });
    case "person":
      return t("fc.legPerson", { who: standingWho(leg.who, c.lang), act: standingAct(leg.act, c.lang), reason: leg.reason });
  }
};

const waitsOnText = (leg: Extract<ReleaseLeg, { kind: "person" }>, c: EtaClock) =>
  productCopy(c.lang)("fc.waitsOnTo", { who: standingWho(leg.who, c.lang), act: standingAct(leg.act, c.lang) });

/**
 * Done as a person means it — in their hands, not merged — as one line and its tooltip: shipped in a
 * version; a range to people's hands where production releases on its own; else the landing and the
 * person who owes the release, never a date for their act.
 */
export function deliveryText(d: DeliveryForecast, c: EtaClock, opts: TextOpts = {}): Said {
  const t = productCopy(c.lang);
  if (d.shipped) {
    const day = d.shipped.at ? t("fc.shippedDay", { day: dayOf(d.shipped.at, c) }) : "";
    return {
      release: d.shipped.version,
      line: d.shipped.version ? t("fc.shippedIn", { version: d.shipped.version, day }) : t("fc.shipped", { day }),
      detail: d.shipped.at ? t("fc.shippedAt", { at: formatDateTime(d.shipped.at, c.lang, c.timeZone) }) : t("fc.shippedNoRun"),
    };
  }
  const landing = forecastText(d.landing, c, opts);
  const leg = d.release;
  if (!leg || (d.landing.kind !== "forecast" && d.landing.kind !== "landed")) return landing;
  const lead = d.landing.kind === "landed" ? `${landing.detail}.` : landing.detail;
  const hands = d.inHands && opts.within !== false ? t("fc.inHands", { within: lowerFirst(within(d.inHands, d.asOf, c)) }) : "";
  const detail = `${hands}${lead}${legDetail(leg, c)}`;
  const release = leg.kind === "person" ? leg.version : null;
  if (d.landing.kind === "landed") {
    if (d.inHands) return { line: t("fc.fixedLive", { when: when(d.inHands, c) }), detail };
    if (leg.kind === "person") return { line: t("fc.fixedWaits", { waits: waitsOnText(leg, c) }), detail, release };
    return { line: t("fc.fixedAutomatic"), detail };
  }
  const lands = t("fc.forecastLands", { when: when(d.landing, c) });
  if (d.inHands) return { line: t("fc.forecastLive", { when: when(d.inHands, c) }), detail };
  if (leg.kind === "person") return { line: t("fc.landsThen", { lands, waits: waitsOnText(leg, c) }), detail, release };
  return { line: t("fc.landsUnknown", { lands }), detail };
}

/** A feedback item's line: untriaged, who triages it; else its linked work's delivery; null where nothing ships. */
export function feedbackForecastText(f: FeedbackForecast, c: EtaClock): Said | null {
  if (f.triage) return { line: productCopy(c.lang)("fc.waitingTriage", { who: standingWho(f.triage.who, c.lang), act: standingAct(f.triage.act, c.lang) }), detail: f.triage.reason };
  return f.delivery ? deliveryText(f.delivery, c) : null;
}

/** A requirement's detail line: how many criteria are proven, then when the rest is in people's hands. */
export function criteriaRestText(proven: number, criteria: number, s: ScopeForecast | undefined, c: EtaClock): Said | null {
  const t = productCopy(c.lang);
  if (criteria === 0) return s?.delivery ? deliveryText(s.delivery, c) : null;
  const head = proven >= criteria ? t("fc.allCriteria", { n: criteria }) : t("fc.criteriaOf", { proven, n: criteria });
  if (proven >= criteria || !s?.delivery) return { line: head, detail: t("fc.criteriaDetail") };
  const rest = deliveryText(s.delivery, c);
  return { line: t("fc.restLine", { head, rest: lowerFirst(rest.line) }), detail: rest.detail, release: rest.release ?? null };
}
