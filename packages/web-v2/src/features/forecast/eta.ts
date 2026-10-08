import { type DeliveryForecast, deliveryDatesOf, type FeedbackForecast, type Forecast, type ForecastSpan, type ReleaseLeg, type ScopeForecast } from "@forge/contracts/forecast";
import type { Said } from "@forge/contracts/said";
import { formatDateTime } from "@/lib/i18n/format";
import { said, saysKey } from "@/lib/i18n/said";
import { type EtaClock, doneDayText, partsOf, whenText } from "@/lib/i18n/eta-clock-words";
import { ETA_COPY } from "@/lib/i18n/eta-copy";
import { deliveryText, forecastText, spanText, statusWord } from "./text";

export type { EtaClock } from "@/lib/i18n/eta-clock-words";
export { doneDayText, whenText } from "@/lib/i18n/eta-clock-words";

// The ETA column: a forecast read as the clock and the day it lands, in the viewer's timezone, never as
// durations the reader has to add to now. The p50 is the cell, the p85 its quiet second line; the
// durations, the as-of and the basis stay in the tooltip (VISION: state-never-lies keeps the label).

/** A person who still cuts the release once the work has landed. */
interface EtaTail {
  who: Said;
  act: Said;
}

export type Eta =
  | { kind: "range"; p50At: string; p85At: string; tail: EtaTail | null; detail: string }
  | { kind: "waits"; who: Said; act: Said; detail: string }
  | { kind: "done"; at: string | null; tail: EtaTail | null; detail: string }
  /** Landed and not yet in people's hands: no tick and no date in the cell, only who releases it (JU-7). */
  | { kind: "landed"; at: string | null; tail: EtaTail | null; detail: string }
  | { kind: "none"; detail: string };

/** The release a person still owes after the landing, the viewer's own as "then you cut it". */
const thenCuts = (who: Said, lang: EtaClock["lang"]) => (saysKey(who, "standing.who.you") ? ETA_COPY[lang].thenYouCut : ETA_COPY[lang].thenCuts(shortWho(who, lang)));

/** Who, short: the box itself for "Whoever can reach box-1", and English drops its leading article ("project writer"). */
function shortWho(who: Said, lang: EtaClock["lang"]): string {
  const device = saysKey(who, "forecast.who.whoeverReaches") ? who.vars?.device : undefined;
  const words = typeof device === "string" ? device : said(who, lang);
  const w = lang === "en" ? words.replace(/^(A|An|The) /, "") : words;
  return w.length > 24 ? `${w.slice(0, 23)}…` : w;
}

/** "Who — act. Reason.": a forecast wait as one tooltip line, its act left out where core names none. */
const waitDetail = (s: { who: Said; act: Said; reason: Said }, lang: EtaClock["lang"]) => {
  const act = said(s.act, lang);
  return `${said(s.who, lang)}${act ? ` — ${act}` : ""}. ${said(s.reason, lang)}`;
};

const minutesUntil = (iso: string, now: number) => Math.max(0, (Date.parse(iso) - now) / 60_000);

const clockOf = (iso: string, c: EtaClock) => {
  const p = partsOf(Date.parse(iso), c.timeZone);
  return `${p.hh}:${p.mm}`;
};

function rangeHead(span: Pick<ForecastSpan, "p50At" | "p85At">, asOf: string, c: EtaClock): string {
  const low = minutesUntil(span.p50At, c.now);
  const high = Math.max(low, minutesUntil(span.p85At, c.now));
  return ETA_COPY[c.lang].within(spanText(low, c.lang), spanText(high, c.lang), clockOf(asOf, c));
}

const tailOf = (leg: ReleaseLeg | null): EtaTail | null => (leg?.kind === "person" ? { who: leg.says.who, act: leg.says.act } : null);

/** An issue's own landing. */
export function etaOfForecast(f: Forecast, c: EtaClock): Eta {
  const copy = ETA_COPY[c.lang];
  const said = forecastText(f, c, { within: false }).detail;
  switch (f.kind) {
    case "forecast":
      return { kind: "range", p50At: f.p50At, p85At: f.p85At, tail: null, detail: `${rangeHead(f, f.asOf, c)} ${said}` };
    case "paused":
      return { kind: "waits", who: f.says.who, act: f.says.act, detail: waitDetail(f.says, c.lang) };
    case "not_enough_history":
      return { kind: "none", detail: copy.notEnoughHistory(f.n, f.floor) };
    case "landed":
      return { kind: "done", at: f.landedAt, tail: null, detail: f.landedAt ? copy.landed(formatDateTime(f.landedAt, c.lang, c.timeZone)) : said };
    case "ended":
      return { kind: "none", detail: copy.notForecast(statusWord(f.status, c.lang)) };
  }
}

/** When it is in people's hands: shipped, a range to hands, or the landing and the person who cuts it after. */
export function etaOfDelivery(d: DeliveryForecast, c: EtaClock): Eta {
  const copy = ETA_COPY[c.lang];
  const said = deliveryText(d, c, { within: false }).detail;
  if (d.shipped) {
    const when = d.shipped.at ? formatDateTime(d.shipped.at, c.lang, c.timeZone) : "";
    return { kind: "done", at: d.shipped.at, tail: null, detail: copy.shipped(d.shipped.version, when) };
  }
  const tail = tailOf(d.release);
  // the dates are the one reading the progress report takes too (`deliveryDatesOf`), so the two never disagree
  const dates = deliveryDatesOf(d);
  if (dates) return { kind: "range", p50At: dates.p50At, p85At: dates.p85At, tail: dates.of === "hands" ? null : tail, detail: `${rangeHead(dates, d.asOf, c)} ${said}` };
  const own = etaOfForecast(d.landing, c);
  if (own.kind === "done") return { kind: "landed", at: own.at, tail, detail: said };
  return own;
}

/** A requirement's row: when the last of its issues is in people's hands. */
export function etaOfScope(s: ScopeForecast | undefined, c: EtaClock): Eta | null {
  if (!s) return null;
  if (!s.delivery || s.progress.total === 0) return { kind: "none", detail: ETA_COPY[c.lang].nothingLinked };
  return etaOfDelivery(s.delivery, c);
}

/** A feedback row: who triages it while untriaged, else its linked work's delivery; null where nothing ships. */
export function etaOfFeedback(f: FeedbackForecast | undefined, c: EtaClock): Eta | null {
  if (!f) return null;
  if (f.triage) return { kind: "waits", who: f.triage.says.who, act: f.triage.says.act, detail: waitDetail(f.triage.says, c.lang) };
  return f.delivery ? etaOfDelivery(f.delivery, c) : null;
}

/** The order the column sorts by: the p50, then what has landed by when, then everything without a time. */
export function etaSortValue(e: Eta | null): number | null {
  if (!e) return null;
  if (e.kind === "range") return Date.parse(e.p50At);
  if ((e.kind === "done" || e.kind === "landed") && e.at) return Date.parse(e.at);
  return null;
}

/** The cell's two lines: the time and, quieter, the p85 or the person who cuts the release. */
export function etaLines(e: Eta, c: EtaClock): { line: string; sub: string | null } {
  const copy = ETA_COPY[c.lang];
  const tail = e.kind === "range" || e.kind === "done" || e.kind === "landed" ? e.tail : null;
  const sub = tail ? thenCuts(tail.who, c.lang) : null;
  switch (e.kind) {
    case "range":
      return { line: whenText(e.p50At, c), sub: sub ?? copy.latest(whenText(e.p85At, c)) };
    case "waits":
      return { line: copy.waitsOn(shortWho(e.who, c.lang)), sub: null };
    case "done":
      return { line: e.at ? doneDayText(e.at, c) : "", sub };
    case "landed":
      return { line: copy.awaitingRelease, sub };
    case "none":
      return { line: "—", sub: null };
  }
}

/** The rail's one line: "14:10 today · latest tomorrow 18:50". */
export function etaInline(e: Eta, c: EtaClock): string {
  const copy = ETA_COPY[c.lang];
  if (e.kind === "range") {
    const head = `${whenText(e.p50At, c, true)} · ${copy.latestInline(whenText(e.p85At, c, true))}`;
    return e.tail ? `${head} · ${thenCuts(e.tail.who, c.lang)}` : head;
  }
  const { line, sub } = etaLines(e, c);
  const head = e.kind === "done" ? `✓ ${line}`.trim() : line;
  return sub ? `${head} · ${sub}` : head;
}
