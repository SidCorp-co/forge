import type { Forecast, ForecastBasis } from "@forge/contracts/forecast";
import { describe, expect, it } from "vitest";
import { forecastText, scopeText, spanText } from "./text";

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
  it("reads a range with both bounds, labelled a forecast and stamped as of", () => {
    const f: Forecast = { ...stamp, kind: "forecast", p50At: at(150), p85At: at(420), p50Minutes: 150, p85Minutes: 420, ahead: 3, aheadKeys: ["ISS-1", "ISS-2", "ISS-3"], waitsOn: [], basis };
    const { line, detail } = forecastText(f, NOW);
    expect(line).toMatch(/^Forecast 2\.5 h – 7\.0 h · as of /);
    expect(detail).toContain("not a promise");
    expect(detail).toContain("3 ahead of it (ISS-1, ISS-2, ISS-3)");
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
      },
      NOW,
    ).line;
    expect(line).toMatch(/^All 2 landed by .+ · then waiting on A release approver to cut the version/);
  });

  it("spans minutes, hours and days", () => {
    expect([spanText(0), spanText(35), spanText(150), spanText(3000)]).toEqual(["1 min", "35 min", "2.5 h", "2 d"]);
  });
});
