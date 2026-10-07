import type { DeliveryForecast, Forecast, ForecastBasis, ScopeForecast } from "@forge/contracts/forecast";
import { describe, expect, it } from "vitest";
import { criteriaRestText, deliveryText, feedbackForecastText, forecastText, scopeText, spanText } from "./text";

// the lines read clock times in the viewer's timezone; this file reads them in UTC
process.env.TZ = "UTC";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const basis: ForecastBasis = {
  n: 45,
  floor: 10,
  windowDays: 60,
  complexity: null,
  cycleP50Minutes: 35,
  cycleP85Minutes: 240,
  throughputPerDay: 12.4,
  concurrency: 1,
  concurrencyBasis: "Little's law",
};
const stamp = { label: "forecast" as const, asOf: at(0) };

describe("forecast text", () => {
  it("reads a range as two clock times, labelled a forecast, its durations and as-of only in the tooltip", () => {
    const f: Forecast = { ...stamp, kind: "forecast", p50At: at(150), p85At: at(420), p50Minutes: 150, p85Minutes: 420, ahead: 3, aheadKeys: ["ISS-1", "ISS-2", "ISS-3"], waitsOn: [], basis };
    const { line, detail } = forecastText(f, NOW);
    expect(line).toBe("Forecast 14:30 – 19:00 today");
    expect(line).not.toMatch(/\d+(\.\d)? (min|h|d)\b/);
    expect(detail).toMatch(/^Within 2\.5 h – 7\.0 h · as of /);
    expect(detail).toContain("not a promise");
    expect(detail).toContain("3 ahead of it (ISS-1, ISS-2, ISS-3)");
  });

  it("says each day once where the range crosses midnight", () => {
    const f: Forecast = { ...stamp, kind: "forecast", p50At: at(600), p85At: at(1500), p50Minutes: 600, p85Minutes: 1500, ahead: 0, aheadKeys: [], waitsOn: [], basis };
    expect(forecastText(f, NOW).line).toBe("Forecast 22:00 today – tomorrow 13:00");
  });

  it("names who owes the move instead of a date when paused", () => {
    const f: Forecast = { ...stamp, kind: "paused", who: "A project writer", act: "answer a question", reason: "parked", ref: null };
    expect(forecastText(f, NOW).line).toBe("Paused — waiting on A project writer to answer a question");
  });

  it("gives no number below the floor", () => {
    const f: Forecast = { ...stamp, kind: "not_enough_history", n: 4, floor: 10 };
    expect(forecastText(f, NOW).line).toBe("Not enough history to forecast · 4 of 10 landings");
    expect(forecastText(f, NOW).line).not.toMatch(/\d+ (min|h|d)\b/);
  });

  it("names the release cut a person still owes once a draft has landed", () => {
    const line = scopeText(
      {
        ...stamp,
        scope: "release",
        key: "draft",
        total: 2,
        landed: 2,
        forecast: { ...stamp, kind: "landed", landedAt: at(-60) },
        next: { ...stamp, kind: "paused", who: "A release approver", act: "cut the version, then approve the release", reason: "r", ref: null },
        title: null,
        delivery: null,
      },
      NOW,
    ).line;
    expect(line).toMatch(/^All 2 landed by .+ · then waiting on A release approver to cut the version/);
  });

  it("spans minutes, hours and days", () => {
    expect([spanText(0), spanText(35), spanText(150), spanText(3000)]).toEqual(["1 min", "35 min", "2.5 h", "2 d"]);
  });
});

const range: Forecast = { ...stamp, kind: "forecast", p50At: at(120), p85At: at(300), p50Minutes: 120, p85Minutes: 300, ahead: 0, aheadKeys: [], waitsOn: [], basis };
const lag = { kind: "automatic" as const, basis: { n: 14, floor: 10, windowDays: 60, lagP50Minutes: 30, lagP85Minutes: 90 } };
const span = (lo: number, hi: number) => ({ p50At: at(lo), p85At: at(hi), p50Minutes: lo, p85Minutes: hi });
const delivery = (over: Partial<DeliveryForecast>): DeliveryForecast => ({ ...stamp, landing: range, release: lag, inHands: span(150, 390), shipped: null, ...over });
const manual = { kind: "person" as const, mode: "manual" as const, who: "A project admin", act: "cut 0.2.0", reason: "an admin cuts each release" };

describe("delivery text: in people's hands, not merged", () => {
  it("ranges to people's hands where production releases on its own, labelled a forecast", () => {
    const { line, detail } = deliveryText(delivery({}), NOW);
    expect(line).toBe("Forecast live 14:30 – 18:30 today");
    expect(detail).toMatch(/^In people's hands within 2\.5 h – 6\.5 h · as of /);
    expect(detail).toContain("sampled from 14 releases");
  });

  it("names the person and the act, with no date for it, where a person cuts the release", () => {
    const { line } = deliveryText(delivery({ release: manual, inHands: null }), NOW);
    expect(line).toBe("Forecast lands 14:00 – 17:00 today · then waits on A project admin to cut 0.2.0");
  });

  it("reads a fixed change still unreleased as waiting on the release", () => {
    const landed: Forecast = { ...stamp, kind: "landed", landedAt: at(-30) };
    expect(deliveryText(delivery({ landing: landed, release: manual, inHands: null }), NOW).line).toBe("Fixed · waits on A project admin to cut 0.2.0");
    expect(deliveryText(delivery({ landing: landed, inHands: span(10, 60) }), NOW).line).toBe("Fixed · forecast live 12:10 – 13:00 today");
  });

  it("says shipped in its version and when, with no range", () => {
    const line = deliveryText(delivery({ shipped: { version: "0.3.1", at: at(-1440) }, release: null, inHands: null }), NOW).line;
    expect(line).toMatch(/^Shipped in 0\.3\.1 · /);
    expect(line).not.toMatch(/Forecast/);
  });

  it("gives no in-hands number below the release floor", () => {
    const line = deliveryText(delivery({ release: { kind: "not_enough_history", n: 4, floor: 10 }, inHands: null }), NOW).line;
    expect(line).toBe("Forecast lands 14:00 – 17:00 today · release time not known yet");
  });
});

describe("feedback and requirement lines", () => {
  it("says an untriaged item waits on triage and who, with no date", () => {
    const line = feedbackForecastText({ key: "FB-1", triage: { ...stamp, kind: "paused", who: "A holder of feedback.approve", act: "triage it", reason: "new", ref: null }, delivery: null }, NOW)?.line;
    expect(line).toBe("Waiting on triage — A holder of feedback.approve to triage it");
  });

  it("draws nothing for an item that carries no work that ships", () => {
    expect(feedbackForecastText({ key: "FB-2", triage: null, delivery: null }, NOW)).toBeNull();
  });

  it("reads the proof so far, then when the rest is in people's hands", () => {
    const scope: ScopeForecast = { ...stamp, scope: "requirement", key: "REQ-3", title: "t", total: 3, landed: 1, forecast: range, next: null, delivery: delivery({}) };
    expect(criteriaRestText(2, 5, scope, NOW)?.line).toBe("2 of 5 criteria proven · rest forecast live 14:30 – 18:30 today");
    expect(criteriaRestText(5, 5, scope, NOW)?.line).toBe("All 5 criteria proven");
  });

  it("adds the release lag to a draft that has landed where nobody cuts it", () => {
    const landed: Forecast = { ...stamp, kind: "landed", landedAt: at(-60) };
    const draft: ScopeForecast = { ...stamp, scope: "release", key: "draft", title: null, total: 2, landed: 2, forecast: landed, next: null, delivery: delivery({ landing: landed, inHands: span(20, 80) }) };
    expect(scopeText(draft, NOW).line).toMatch(/^All 2 landed by .+ · forecast live 12:20 – 13:20 today$/);
  });
});
