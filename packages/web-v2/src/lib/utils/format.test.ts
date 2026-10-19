import { describe, expect, it } from "vitest";
import { formatDurationMs, formatDurationSec, formatUsd } from "./format";

describe("formatUsd", () => {
  it("says nothing was recorded, zero, a sub-cent figure and a two-place figure apart", () => {
    expect([formatUsd(null), formatUsd(0), formatUsd(0.004), formatUsd(1.234)]).toEqual([
      "—",
      "$0",
      "<$0.01",
      "$1.23",
    ]);
  });
});

describe("formatDurationMs / formatDurationSec", () => {
  it("reads each unit at its boundary", () => {
    expect([999, 1000, 59_999, 60_000, 3_600_000].map(formatDurationMs)).toEqual([
      "999ms",
      "1.0s",
      "60.0s",
      "1m 00s",
      "1h 00m",
    ]);
  });

  it("reads no value as a dash, and seconds through the same scale", () => {
    expect([formatDurationMs(null), formatDurationSec(undefined), formatDurationSec(192)]).toEqual([
      "—",
      "—",
      "3m 12s",
    ]);
  });
});
