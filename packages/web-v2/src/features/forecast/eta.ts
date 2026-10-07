import type { DeliveryForecast, FeedbackForecast, Forecast, ForecastSpan, ReleaseLeg, ScopeForecast } from "@forge/contracts/forecast";
import { type EtaClock, doneDayText, partsOf, whenText } from "./clock";
import { ETA_COPY } from "./eta-copy";
import { deliveryText, forecastText, spanText } from "./text";

export type { EtaClock } from "./clock";
export { doneDayText, whenText } from "./clock";

// The ETA column: a forecast read as the clock and the day it lands, in the viewer's timezone, never as
// durations the reader has to add to now. The p50 is the cell, the p85 its quiet second line; the
// durations, the as-of and the basis stay in the tooltip (VISION: state-never-lies keeps the label).

/** A person who still cuts the release once the work has landed. */
interface EtaTail {
  who: string;
  act: string;
}

export type Eta =
  | { kind: "range"; p50At: string; p85At: string; tail: EtaTail | null; detail: string }
  | { kind: "waits"; who: string; act: string; detail: string }
  | { kind: "done"; at: string | null; tail: EtaTail | null; detail: string }
  | { kind: "none"; detail: string };

/** "project writer" from "A project writer", the box from "Whoever can reach box-1": who, short. */
function shortWho(who: string): string {
  const w = who.replace(/^Whoever can reach /, "").replace(/^(A|An|The) /, "");
  return w.length > 24 ? `${w.slice(0, 23)}…` : w;
}

const minutesUntil = (iso: string, now: number) => Math.max(0, (Date.parse(iso) - now) / 60_000);

const clockOf = (iso: string, c: EtaClock) => {
  const p = partsOf(Date.parse(iso), c.timeZone);
  return `${p.hh}:${p.mm}`;
};

function rangeHead(span: Pick<ForecastSpan, "p50At" | "p85At">, asOf: string, c: EtaClock): string {
  const low = minutesUntil(span.p50At, c.now);
  const high = Math.max(low, minutesUntil(span.p85At, c.now));
  return ETA_COPY[c.lang].within(spanText(low), spanText(high), clockOf(asOf, c));
}

const tailOf = (leg: ReleaseLeg | null): EtaTail | null => (leg?.kind === "person" ? { who: leg.who, act: leg.act } : null);

/** An issue's own landing. */
export function etaOfForecast(f: Forecast, c: EtaClock): Eta {
  const copy = ETA_COPY[c.lang];
  const said = forecastText(f, c.now, { within: false }).detail;
  switch (f.kind) {
    case "forecast":
      return { kind: "range", p50At: f.p50At, p85At: f.p85At, tail: null, detail: `${rangeHead(f, f.asOf, c)} ${said}` };
    case "paused":
      return { kind: "waits", who: f.who, act: f.act, detail: `${f.who}${f.act ? ` — ${f.act}` : ""}. ${f.reason}` };
    case "not_enough_history":
      return { kind: "none", detail: copy.notEnoughHistory(f.n, f.floor) };
    case "landed":
      return { kind: "done", at: f.landedAt, tail: null, detail: f.landedAt ? copy.landed(new Date(f.landedAt).toLocaleString(copy.locale)) : said };
    case "ended":
      return { kind: "none", detail: copy.notForecast(f.status) };
  }
}

/** When it is in people's hands: shipped, a range to hands, or the landing and the person who cuts it after. */
export function etaOfDelivery(d: DeliveryForecast, c: EtaClock): Eta {
  const copy = ETA_COPY[c.lang];
  const said = deliveryText(d, c.now, { within: false }).detail;
  if (d.shipped) {
    const when = d.shipped.at ? new Date(d.shipped.at).toLocaleString(copy.locale) : "";
    return { kind: "done", at: d.shipped.at, tail: null, detail: copy.shipped(d.shipped.version, when) };
  }
  const tail = tailOf(d.release);
  if (d.inHands) return { kind: "range", p50At: d.inHands.p50At, p85At: d.inHands.p85At, tail: null, detail: `${rangeHead(d.inHands, d.asOf, c)} ${said}` };
  const own = etaOfForecast(d.landing, c);
  if (own.kind === "range") return { ...own, tail, detail: `${rangeHead(own, d.asOf, c)} ${said}` };
  if (own.kind === "done") return { ...own, tail, detail: said };
  return own;
}

/** A requirement's row: when the last of its issues is in people's hands. */
export function etaOfScope(s: ScopeForecast | undefined, c: EtaClock): Eta | null {
  if (!s) return null;
  if (!s.delivery || s.total === 0) return { kind: "none", detail: ETA_COPY[c.lang].nothingLinked };
  return etaOfDelivery(s.delivery, c);
}

/** A feedback row: who triages it while untriaged, else its linked work's delivery; null where nothing ships. */
export function etaOfFeedback(f: FeedbackForecast | undefined, c: EtaClock): Eta | null {
  if (!f) return null;
  if (f.triage) return { kind: "waits", who: f.triage.who, act: f.triage.act, detail: `${f.triage.who} — ${f.triage.act}. ${f.triage.reason}` };
  return f.delivery ? etaOfDelivery(f.delivery, c) : null;
}

/** The order the column sorts by: the p50, then what has landed by when, then everything without a time. */
export function etaSortValue(e: Eta | null): number | null {
  if (!e) return null;
  if (e.kind === "range") return Date.parse(e.p50At);
  if (e.kind === "done" && e.at) return Date.parse(e.at);
  return null;
}

/** The cell's two lines: the time and, quieter, the p85 or the person who cuts the release. */
export function etaLines(e: Eta, c: EtaClock): { line: string; sub: string | null } {
  const copy = ETA_COPY[c.lang];
  const tail = e.kind === "range" || e.kind === "done" ? e.tail : null;
  const sub = tail ? copy.thenCuts(shortWho(tail.who)) : null;
  switch (e.kind) {
    case "range":
      return { line: whenText(e.p50At, c), sub: sub ?? copy.latest(whenText(e.p85At, c)) };
    case "waits":
      return { line: copy.waitsOn(shortWho(e.who)), sub: null };
    case "done":
      return { line: e.at ? doneDayText(e.at, c) : "", sub };
    case "none":
      return { line: "—", sub: null };
  }
}

/** The rail's one line: "14:10 today · latest tomorrow 18:50". */
export function etaInline(e: Eta, c: EtaClock): string {
  const copy = ETA_COPY[c.lang];
  if (e.kind === "range") {
    const head = `${whenText(e.p50At, c, true)} · ${copy.latestInline(whenText(e.p85At, c, true))}`;
    return e.tail ? `${head} · ${copy.thenCuts(shortWho(e.tail.who))}` : head;
  }
  const { line, sub } = etaLines(e, c);
  const head = e.kind === "done" ? `✓ ${line}`.trim() : line;
  return sub ? `${head} · ${sub}` : head;
}
