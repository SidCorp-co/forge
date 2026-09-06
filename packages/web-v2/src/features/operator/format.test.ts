import { describe, expect, it } from "vitest";
import {
  NO_VALUE,
  formatCount,
  formatDelta,
  formatMinutes,
  formatPercent,
  formatRatio,
  formatSince,
  formatUsd,
} from "./format";

// cm:guard the four endpoints send `null` for a ratio whose denominator was zero, so rendering it as "0" tells an operator the metric was measured and came out at nothing — the opposite of what the endpoint said
describe("null is not zero", () => {
  it.each([
    ["formatCount", formatCount],
    ["formatUsd", formatUsd],
    ["formatMinutes", formatMinutes],
    ["formatPercent", formatPercent],
    ["formatRatio", formatRatio],
  ])("%s renders null as the em-dash, not 0", (_name, fn) => {
    expect(fn(null)).toBe(NO_VALUE);
    expect(fn(0)).not.toBe(NO_VALUE);
  });
});

describe("formatMinutes", () => {
  it("keeps minutes under an hour", () => {
    expect(formatMinutes(42)).toBe("42m");
  });

  it("switches to hours, then to days past two days", () => {
    expect(formatMinutes(90)).toBe("1.5h");
    expect(formatMinutes(2677.8)).toBe("44.6h");
    expect(formatMinutes(4320)).toBe("3.0d");
  });
});

describe("formatUsd", () => {
  it("keeps cents below a dollar and compacts thousands", () => {
    expect(formatUsd(0.6)).toBe("$0.60");
    expect(formatUsd(246.78)).toBe("$246.8");
    expect(formatUsd(0)).toBe("$0");
  });
});

describe("formatDelta", () => {
  it("signs the move and drops a null baseline", () => {
    expect(formatDelta(-4.31)).toBe("-4.3%");
    expect(formatDelta(-15.93)).toBe("-16%");
    expect(formatDelta(42.4)).toBe("+42%");
    expect(formatDelta(null)).toBeNull();
    expect(formatDelta(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("formatSince", () => {
  const NOW = Date.parse("2026-09-06T12:00:00.000Z");

  it("coarsens the age of the oldest contributor", () => {
    expect(formatSince("2026-09-06T11:50:00.000Z", NOW)).toBe("10m");
    expect(formatSince("2026-09-06T06:00:00.000Z", NOW)).toBe("6h");
    expect(formatSince("2026-09-01T12:00:00.000Z", NOW)).toBe("5d");
  });

  it("answers null for an alert that is ok, which carries no `since`", () => {
    expect(formatSince(null, NOW)).toBeNull();
  });

  // cm:why a clock skew between core and the browser is ordinary; "in -3 minutes" on screen is not
  it("answers null rather than a negative age for a future instant", () => {
    expect(formatSince("2026-09-06T12:05:00.000Z", NOW)).toBeNull();
  });
});
