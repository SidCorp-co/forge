import type { DeliveryForecast, Forecast, ForecastBasis } from "@forge/contracts/forecast";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi as mock } from "vitest";
import { GroupedList, type ListGroup, sortGroupsBy } from "@/design";
import { EtaCell, EtaInline } from "./components/eta-cell";
import { type EtaClock, etaInline, etaLines, etaOfDelivery, etaOfFeedback, etaOfForecast, etaSortValue } from "./eta";
import { ETA_COPY, etaLangOf } from "./eta-copy";

// The ETA column reads a forecast as the clock and the day in the viewer's timezone. These read it in
// Ho Chi Minh City (UTC+7), where NOW is Wednesday 7 October 2026 at 12:00.

const NOW = Date.parse("2026-10-07T05:00:00Z");
const TZ = "Asia/Ho_Chi_Minh";
const vi: EtaClock = { lang: "vi", now: NOW, timeZone: TZ };
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
  kind: "forecast",
  p50At: at(p50),
  p85At: at(p85),
  p50Minutes: p50,
  p85Minutes: p85,
  ahead: 0,
  aheadKeys: [],
  waitsOn: [],
  basis,
});
const lines = (f: Forecast, c: EtaClock = vi) => etaLines(etaOfForecast(f, c), c);

// 14:10 today and 18:50 tomorrow
const TODAY = range(130, 1850);

describe("the ETA cell reads a clock, not a duration", () => {
  it("today: the bare clock, the p85 as the quiet second line", () => {
    expect(lines(TODAY)).toEqual({ line: "14:10", sub: "muộn nhất ~ Mai 18:50" }); // i18n-allow: asserts the vi ETA copy
    expect(lines(TODAY, en)).toEqual({ line: "14:10", sub: "latest ~ Tomorrow 18:50" });
  });

  it("tomorrow: the day word, then the clock", () => {
    expect(lines(range(1850, 1900)).line).toBe("Mai 18:50");
    expect(lines(range(1850, 1900), en).line).toBe("Tomorrow 18:50");
  });

  it("within the week: the weekday, Sunday as CN", () => {
    // Friday 9 October 09:00, Sunday 11 October 10:00
    expect(lines(range(2700, 2700)).line).toBe("Th 6 09:00");
    expect(lines(range(5640, 5640)).line).toBe("CN 10:00");
    expect(lines(range(2700, 2700), en).line).toBe("Fri 09:00");
  });

  it("beyond a week: the date alone", () => {
    // Thursday 15 October 07:00, eight days out
    expect(lines(range(11220, 11220)).line).toBe("15/10");
    expect(lines(range(11220, 11220), en).line).toBe("Oct 15");
  });

  it("reads the day in the viewer's timezone, not the server's", () => {
    // 17:30 in Ho Chi Minh City is 10:30 UTC on the same day; 23:30 there is still today, 16:30 UTC
    expect(lines(range(330, 330)).line).toBe("17:30");
    expect(lines(range(330, 330), { ...vi, timeZone: "UTC" }).line).toBe("10:30");
    expect(lines(range(690, 690)).line).toBe("23:30");
    expect(lines(range(750, 750)).line).toBe("Mai 00:30");
  });

  it("keeps the durations and the as-of out of the cell and in the tooltip", () => {
    const eta = etaOfForecast(TODAY, vi);
    const { line, sub } = etaLines(eta, vi);
    expect(`${line} ${sub}`).not.toMatch(/\d+(\.\d)? (min|h|d)\b/);
    expect(eta.detail).toMatch(/^Trong 2\.2 h – 31 h · tính lúc 12:00\./); // i18n-allow: asserts the vi ETA copy
    expect(eta.detail).toContain("not a promise");
    expect(eta.detail).toContain("held to 2");
  });
});

describe("the ETA cell where there is no date", () => {
  it("paused: who it waits on, short and muted, the full act in the tooltip", () => {
    const f: Forecast = { ...stamp, kind: "paused", who: "A project writer", act: "answer a question", reason: "parked at needs_info", ref: null };
    const eta = etaOfForecast(f, vi);
    expect(eta.kind).toBe("waits");
    expect(etaLines(eta, vi)).toEqual({ line: "Chờ project writer", sub: null }); // i18n-allow: asserts the vi ETA copy
    expect(etaLines(eta, en).line).toBe("Waits on project writer");
    expect(eta.detail).toBe("A project writer — answer a question. parked at needs_info");
  });

  it("not enough history: a dash, the sample size in the tooltip", () => {
    const eta = etaOfForecast({ ...stamp, kind: "not_enough_history", n: 4, floor: 10 }, vi);
    expect(etaLines(eta, vi)).toEqual({ line: "—", sub: null });
    expect(eta.detail).toBe("Chưa đủ lịch sử để dự kiến: 4/10 lần hoàn thành."); // i18n-allow: asserts the vi ETA copy
  });

  it("landed: the day it landed, quiet", () => {
    expect(lines({ ...stamp, kind: "landed", landedAt: at(-60) })).toEqual({ line: "Hôm nay", sub: null }); // i18n-allow: asserts the vi ETA copy
    expect(lines({ ...stamp, kind: "landed", landedAt: at(-1440) })).toEqual({ line: "Hôm qua", sub: null }); // i18n-allow: asserts the vi ETA copy
    expect(lines({ ...stamp, kind: "landed", landedAt: at(-6 * 1440) }).line).toBe("01/10");
    expect(etaOfForecast({ ...stamp, kind: "landed", landedAt: at(-60) }, vi).kind).toBe("done");
  });

  it("shipped: the day it shipped, its version in the tooltip", () => {
    const d: DeliveryForecast = { ...stamp, landing: { ...stamp, kind: "landed", landedAt: at(-3000) }, release: null, inHands: null, shipped: { version: "0.3.1", at: at(-2880) } };
    const eta = etaOfDelivery(d, vi);
    expect(etaLines(eta, vi)).toEqual({ line: "05/10", sub: null });
    expect(eta.detail).toMatch(/^Đã phát hành 0\.3\.1 /); // i18n-allow: asserts the vi ETA copy
  });
});

describe("a release a person still cuts", () => {
  const manual = { kind: "person" as const, mode: "manual" as const, who: "A project admin", act: "cut 0.2.0", reason: "an admin cuts each release", version: "0.2.0", holders: [] };

  it("reads the landing, then who cuts it as the second line", () => {
    const d: DeliveryForecast = { ...stamp, landing: TODAY, release: manual, inHands: null, shipped: null };
    expect(etaLines(etaOfDelivery(d, vi), vi)).toEqual({ line: "14:10", sub: "rồi chờ project admin cắt" }); // i18n-allow: asserts the vi ETA copy
    expect(etaLines(etaOfDelivery(d, en), en).sub).toBe("then project admin cuts it");
  });

  it("reads a landed change waiting on the cut as landed, then who cuts it", () => {
    const d: DeliveryForecast = { ...stamp, landing: { ...stamp, kind: "landed", landedAt: at(-30) }, release: manual, inHands: null, shipped: null };
    expect(etaLines(etaOfDelivery(d, vi), vi)).toEqual({ line: "Hôm nay", sub: "rồi chờ project admin cắt" }); // i18n-allow: asserts the vi ETA copy
  });

  it("reads the time in people's hands where production releases on its own", () => {
    const lag = { kind: "automatic" as const, basis: { n: 14, floor: 10, windowDays: 60, lagP50Minutes: 30, lagP85Minutes: 90 } };
    const d: DeliveryForecast = { ...stamp, landing: TODAY, release: lag, inHands: { p50At: at(160), p85At: at(1940), p50Minutes: 160, p85Minutes: 1940 }, shipped: null };
    expect(etaLines(etaOfDelivery(d, vi), vi)).toEqual({ line: "14:40", sub: "muộn nhất ~ Mai 20:20" }); // i18n-allow: asserts the vi ETA copy
  });

  it("names who triages an untriaged feedback item, with no date", () => {
    const eta = etaOfFeedback({ key: "FB-1", triage: { ...stamp, kind: "paused", who: "A holder of feedback.approve", act: "triage it", reason: "new", ref: null }, delivery: null }, vi);
    expect(eta && etaLines(eta, vi).line).toBe("Chờ holder of feedback.appr…"); // i18n-allow: asserts the vi ETA copy
    expect(eta?.detail).toBe("A holder of feedback.approve — triage it. new");
  });
});

describe("the rail reads the same clock in one line", () => {
  it("today, then the latest", () => {
    expect(etaInline(etaOfForecast(TODAY, vi), vi)).toBe("14:10 hôm nay · muộn nhất mai 18:50"); // i18n-allow: asserts the vi ETA copy
    expect(etaInline(etaOfForecast(TODAY, en), en)).toBe("14:10 today · latest tomorrow 18:50");
  });

  it("renders the rail line with the durations on hover", () => {
    render(<EtaInline eta={etaOfForecast(TODAY, vi)} clock={vi} />);
    const el = screen.getByTestId("eta-inline");
    expect(el.textContent).toBe("14:10 hôm nay · muộn nhất mai 18:50"); // i18n-allow: asserts the vi ETA copy
    expect(el.getAttribute("title")).toMatch(/^Trong 2\.2 h – 31 h · tính lúc 12:00\./); // i18n-allow: asserts the vi ETA copy
  });
});

describe("the ETA column's language and order", () => {
  it("reads vi for any vi tag and English for every other", () => {
    expect([etaLangOf("vi"), etaLangOf("vi-VN"), etaLangOf("en"), etaLangOf("ja"), etaLangOf(undefined)]).toEqual(["vi", "vi", "en", "en", "en"]);
  });

  it("sorts by the p50 within each group, every row without a time last in its own order", () => {
    type R = { key: string; f: Forecast };
    const paused: Forecast = { ...stamp, kind: "paused", who: "A project writer", act: "answer", reason: "r", ref: null };
    const rows: R[] = [
      { key: "ISS-1", f: paused },
      { key: "ISS-2", f: range(1850, 1900) },
      { key: "ISS-3", f: { ...stamp, kind: "not_enough_history", n: 1, floor: 10 } },
      { key: "ISS-4", f: TODAY },
      { key: "ISS-5", f: range(2700, 2800) },
    ];
    const groups: ListGroup<R>[] = [{ id: "moving", label: "Moving", rows }];
    const sorted = sortGroupsBy(groups, (r) => etaSortValue(etaOfForecast(r.f, vi)));
    expect(sorted[0]?.rows.map((r) => r.key)).toEqual(["ISS-4", "ISS-2", "ISS-5", "ISS-1", "ISS-3"]);
  });

  it("draws the column header in the content language and toggles the sort from it", () => {
    const onSort = mock.fn();
    const groups: ListGroup<{ key: string }>[] = [{ id: "g", label: "Moving", rows: [{ key: "ISS-4" }] }];
    render(
      <GroupedList
        ariaLabel="Issues"
        groups={groups}
        fold={{ isOpen: () => true, toggle: () => {} }}
        row={(r) => ({ key: r.key, href: `/i/${r.key}`, title: r.key, facts: [], state: null, waitingOn: null, owner: null, age: null, eta: <EtaCell eta={etaOfForecast(TODAY, vi)} clock={vi} /> })}
        selected={null}
        onPeek={() => {}}
        eta={{ label: ETA_COPY.vi.header, sortLabel: ETA_COPY.vi.sortBy, sorted: false, onSort }}
      />,
    );
    const header = screen.getByTestId("list-sort-eta");
    expect(header.textContent).toBe("Dự kiến"); // i18n-allow: asserts the vi ETA copy
    expect(header.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(header);
    expect(onSort).toHaveBeenCalledTimes(1);
    const cell = screen.getByTestId("eta-cell");
    expect(cell.getAttribute("data-kind")).toBe("range");
    expect(screen.getByTestId("eta-line").textContent).toBe("14:10");
    expect(screen.getByTestId("eta-sub").textContent).toBe("muộn nhất ~ Mai 18:50"); // i18n-allow: asserts the vi ETA copy
  });
});
