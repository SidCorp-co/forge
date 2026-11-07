import type { DeliveryForecast, Forecast, ForecastBasis } from "@forge/contracts/forecast";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi as mock } from "vitest";
import { GroupedList, type ListGroup, sortGroupsBy } from "@/design";
import { EtaCell, EtaInline } from "./components/eta-cell";
import { type EtaClock, etaInline, etaLines, etaOfDelivery, etaOfFeedback, etaOfForecast, etaSortValue } from "./eta";
import { ETA_COPY } from "@/lib/i18n/eta-copy";
import { forecastWait, RULE, say } from "@/test/said";

// The ETA column reads a forecast as the clock and the day in the viewer's timezone. These read it in
// Ho Chi Minh City (UTC+7), where NOW is Wednesday 7 October 2026 at 12:00.

const NOW = Date.parse("2026-10-07T05:00:00Z");
const TZ = "Asia/Ho_Chi_Minh";
const en: EtaClock = { lang: "en", now: NOW, timeZone: TZ };
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const stamp = { label: "forecast" as const, asOf: at(0) };
const basis: ForecastBasis = {
  n: 45,
  floor: 10,
  windowDays: 60,
  complexity: null,
  cycleP50Minutes: 35,
  cycleP85Minutes: 240,
  throughputPerDay: 12.4,
  concurrency: 2,
  concurrencyBasis: "held to 2: the most runs live at once over the last 14 days",
};
const range = (p50: number, p85: number): Forecast => ({
  ...stamp,
  kind: "forecast", anchoredAt: "2026-10-07T00:00:00.000Z", confidence: { level: "medium", n: 12, spread: 0.5 },
  p50At: at(p50),
  p85At: at(p85),
  p50Minutes: p50,
  p85Minutes: p85,
  ahead: 0,
  aheadKeys: [],
  waitsOn: [],
  basis, late: null,
});
const lines = (f: Forecast, c: EtaClock = en) => etaLines(etaOfForecast(f, c), c);

// 14:10 today and 18:50 tomorrow
const TODAY = range(130, 1850);

describe("the ETA cell reads a clock, not a duration", () => {
  it("today: the bare clock, the p85 as the quiet second line", () => {
    expect(lines(TODAY, en)).toEqual({ line: "14:10", sub: "latest ~ Tomorrow 18:50" });
  });

  it("tomorrow: the day word, then the clock", () => {
    expect(lines(range(1850, 1900), en).line).toBe("Tomorrow 18:50");
  });

  it("within the week: the weekday", () => {
    // Friday 9 October 09:00, Sunday 11 October 10:00
    expect(lines(range(5640, 5640)).line).toBe("Sun 10:00");
    expect(lines(range(2700, 2700)).line).toBe("Fri 09:00");
  });

  it("beyond a week: the date alone", () => {
    // Thursday 15 October 07:00, eight days out
    expect(lines(range(11220, 11220), en).line).toBe("Oct 15");
  });

  it("reads the day in the viewer's timezone, not the server's", () => {
    // 17:30 in Ho Chi Minh City is 10:30 UTC on the same day; 23:30 there is still today, 16:30 UTC
    expect(lines(range(330, 330)).line).toBe("17:30");
    expect(lines(range(330, 330), { ...en, timeZone: "UTC" }).line).toBe("10:30");
    expect(lines(range(690, 690)).line).toBe("23:30");
    expect(lines(range(750, 750)).line).toBe("Tomorrow 00:30");
  });

  it("keeps the durations and the as-of out of the cell and in the tooltip", () => {
    const eta = etaOfForecast(TODAY, en);
    const { line, sub } = etaLines(eta, en);
    expect(`${line} ${sub}`).not.toMatch(/\d+(\.\d)? (min|h|d)\b/);
    expect(eta.detail).toMatch(/^Within 2\.2 h – 31 h · as of 12:00\./);
    expect(eta.detail).toContain("Forecast: half land by");
    expect(eta.detail).toContain("held to 2");
  });
});

describe("the ETA cell where there is no date", () => {
  it("paused: who it waits on, short and muted, the full act in the tooltip", () => {
    const f: Forecast = { ...stamp, kind: "paused", ...forecastWait(say("standing.who.named", { name: "Ana" }), say("issues.standing.act.answer"), say("issues.rule.needsInfo")), ref: null, since: null, late: null };
    const eta = etaOfForecast(f, en);
    expect(eta.kind).toBe("waits");
    expect(etaLines(eta, en).line).toBe("Waits on Ana");
    expect(eta.detail).toBe("Ana — answer a question. parked at needs_info: asked in Needs you; the answer wakes the master");
  });

  it("not enough history: a dash, the sample size in the tooltip", () => {
    const eta = etaOfForecast({ ...stamp, kind: "not_enough_history", n: 4, floor: 10 }, en);
    expect(etaLines(eta, en)).toEqual({ line: "—", sub: null });
    expect(eta.detail).toBe("Not enough history to forecast: 4 of 10 landings.");
  });

  it("landed: the day it landed, quiet", () => {
    expect(lines({ ...stamp, kind: "landed", landedAt: at(-60) })).toEqual({ line: "Today", sub: null });
    expect(lines({ ...stamp, kind: "landed", landedAt: at(-1440) })).toEqual({ line: "Yesterday", sub: null });
    expect(lines({ ...stamp, kind: "landed", landedAt: at(-6 * 1440) }).line).toBe("Oct 1");
    expect(etaOfForecast({ ...stamp, kind: "landed", landedAt: at(-60) }, en).kind).toBe("done");
  });

  it("shipped: says so with its version and no date, the day in the tooltip", () => {
    const d: DeliveryForecast = { ...stamp, landing: { ...stamp, kind: "landed", landedAt: at(-3000) }, release: null, inHands: null, shipped: { version: "0.3.1", at: at(-2880) } };
    const eta = etaOfDelivery(d, en);
    expect(etaLines(eta, en)).toEqual({ line: "Shipped 0.3.1", sub: null });
    expect(eta.detail).toMatch(/^Shipped in 0\.3\.1 /);
  });
});

describe("a release a person still cuts", () => {
  const manual = { kind: "person" as const, mode: "manual" as const, ...forecastWait(say("standing.who.named", { name: "Ada" }), say("standing.act.cut", { v: "0.2.0", more: null }), say("forecast.reason.manual")), version: "0.2.0", holders: [] };

  it("reads the landing, then who cuts it as the second line", () => {
    const d: DeliveryForecast = { ...stamp, landing: TODAY, release: manual, inHands: null, shipped: null };
    expect(etaLines(etaOfDelivery(d, en), en).sub).toBe("then Ada cuts it");
  });

  // JU-7: hop's REQ-11 read '✓ Oct 4' under ETA while still in delivery; a landed change not in people's hands has no tick and no date
  it("reads a landed change waiting on the cut as awaiting release with no tick or date, then who cuts it", () => {
    const d: DeliveryForecast = { ...stamp, landing: { ...stamp, kind: "landed", landedAt: at(-30) }, release: manual, inHands: null, shipped: null };
    const eta = etaOfDelivery(d, en);
    expect(eta.kind).toBe("landed");
    expect(etaLines(eta, en)).toEqual({ line: "Landed, awaiting release", sub: "then Ada cuts it" });
    expect(etaInline(eta, en)).not.toContain("✓");
    render(<EtaCell eta={eta} clock={en} />);
    expect(screen.getByTestId("eta-cell").querySelector("svg")).toBeNull();
  });

  it("names the viewer as you where the release act is theirs, never their own account name", () => {
    const mine = { ...manual, ...forecastWait(say("standing.who.you"), say("standing.act.cut", { v: "0.2.0", more: null }), say("forecast.reason.manual")) };
    const d: DeliveryForecast = { ...stamp, landing: { ...stamp, kind: "landed", landedAt: at(-30) }, release: mine, inHands: null, shipped: null };
    expect(etaInline(etaOfDelivery(d, en), en)).toBe("Landed, awaiting release · then you cut it");
  });

  it("reads the time in people's hands where production releases on its own", () => {
    const lag = { kind: "automatic" as const, basis: { n: 14, floor: 10, windowDays: 60, lagP50Minutes: 30, lagP85Minutes: 90 } };
    const d: DeliveryForecast = { ...stamp, landing: TODAY, release: lag, inHands: { p50At: at(160), p85At: at(1940), p50Minutes: 160, p85Minutes: 1940 }, shipped: null };
    expect(etaLines(etaOfDelivery(d, en), en)).toEqual({ line: "14:40", sub: "latest ~ Tomorrow 20:20" });
  });

  it("names who triages an untriaged feedback item, with no date", () => {
    const eta = etaOfFeedback({ key: "FB-1", triage: { ...stamp, kind: "paused", ...forecastWait(say("standing.who.holderOf", { perm: "feedback.approve" }), say("standing.act.triageIt"), say("feedback.rule.triagerTriages", { phase: "new" })), ref: null, since: null, late: null }, delivery: null }, en);
    expect(eta && etaLines(eta, en).line).toBe("Waits on Feedback triager");
    expect(eta?.detail).toBe("Feedback triager — triage it. new: a holder of feedback.approve triages it");
  });
});

describe("the rail reads the same clock in one line", () => {
  it("today, then the latest", () => {
    expect(etaInline(etaOfForecast(TODAY, en), en)).toBe("14:10 today · latest tomorrow 18:50");
  });

  it("renders the rail line with the durations on hover", () => {
    render(<EtaInline eta={etaOfForecast(TODAY, en)} clock={en} />);
    const el = screen.getByTestId("eta-inline");
    expect(el.textContent).toBe("14:10 today · latest tomorrow 18:50");
    expect(el.getAttribute("title")).toMatch(/^Within 2\.2 h – 31 h · as of 12:00\./);
  });
});

describe("the ETA column's language and order", () => {
  it("sorts by the p50 within each group, every row without a time last in its own order", () => {
    type R = { key: string; f: Forecast };
    const paused: Forecast = { ...stamp, kind: "paused", ...forecastWait(say("standing.who.named", { name: "Ana" }), say("issues.standing.act.answer"), RULE), ref: null, since: null, late: null };
    const rows: R[] = [
      { key: "ISS-1", f: paused },
      { key: "ISS-2", f: range(1850, 1900) },
      { key: "ISS-3", f: { ...stamp, kind: "not_enough_history", n: 1, floor: 10 } },
      { key: "ISS-4", f: TODAY },
      { key: "ISS-5", f: range(2700, 2800) },
    ];
    const groups: ListGroup<R>[] = [{ id: "moving", label: "Moving", rows }];
    const sorted = sortGroupsBy(groups, (r) => etaSortValue(etaOfForecast(r.f, en)));
    expect(sorted[0]?.rows.map((r) => r.key)).toEqual(["ISS-4", "ISS-2", "ISS-5", "ISS-1", "ISS-3"]);
  });

  it("draws the column header and toggles the sort from it", () => {
    const onSort = mock.fn();
    const groups: ListGroup<{ key: string }>[] = [{ id: "g", label: "Moving", rows: [{ key: "ISS-4" }] }];
    render(
      <GroupedList
        ariaLabel="Issues"
        groups={groups}
        fold={{ isOpen: () => true, toggle: () => {} }}
        row={(r) => ({ key: r.key, href: `/i/${r.key}`, title: r.key, facts: [], state: null, waitingOn: null, owner: null, age: null, eta: <EtaCell eta={etaOfForecast(TODAY, en)} clock={en} /> })}
        selected={null}
        onPeek={() => {}}
        eta={{ label: ETA_COPY.en.header, sort: { label: ETA_COPY.en.sortBy, sorted: false, onSort } }}
      />,
    );
    const header = screen.getByTestId("list-sort-eta");
    expect(header.textContent).toBe("ETA");
    expect(header.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(header);
    expect(onSort).toHaveBeenCalledTimes(1);
    const cell = screen.getByTestId("eta-cell");
    expect(cell.getAttribute("data-kind")).toBe("range");
    expect(screen.getByTestId("eta-line").textContent).toBe("14:10");
    // one ETA on the row (ISS-1072): the latest it may run to rides the tooltip, never a second line
    expect(screen.queryByTestId("eta-sub")).toBeNull();
    expect(cell.getAttribute("title")).toContain("latest ~ Tomorrow 18:50");
  });
});
