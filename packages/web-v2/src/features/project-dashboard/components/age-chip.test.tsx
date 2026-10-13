// @vitest-environment jsdom
//
// ISS-1159 — how long an item has waited is shown, and its weight rises with the wait. A chip aged
// from the last write says so, since that is not time parked.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgeChip } from "./age-chip";

expect.extend(matchers);
afterEach(cleanup);

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

describe("the age chip", () => {
  it.each([
    [0.2, "fresh", "4h"],
    [1, "aging", "24h"],
    [3, "stale", "3d"],
    [14, "overdue", "14d"],
    [112, "overdue", "112d"],
  ] as const)("shows %s days as %s", (days, band, text) => {
    render(<AgeChip since={ago(days)} basis="entered" now={NOW} />);
    const chip = screen.getByTestId("age-chip");
    expect(chip).toHaveAttribute("data-band", band);
    expect(chip).toHaveTextContent(text);
  });

  it("rises in weight across the bands", () => {
    const weight = (days: number) => {
      const { unmount } = render(<AgeChip since={ago(days)} basis="entered" now={NOW} />);
      const w = screen.getByTestId("age-chip").className.match(/font-(normal|medium|semibold|bold)/)?.[0];
      unmount();
      return w;
    };
    expect([weight(0.2), weight(1), weight(3), weight(14)]).toEqual([
      "font-normal",
      "font-medium",
      "font-semibold",
      "font-bold",
    ]);
  });

  it("says an age taken from the last write is one, and explains it", () => {
    render(<AgeChip since={ago(112)} basis="last-write" now={NOW} />);
    const chip = screen.getByTestId("age-chip");
    expect(chip).toHaveTextContent("112d since last write");
    expect(chip.getAttribute("title")).toMatch(/Nothing records how long it has been parked/);
  });

  it("draws nothing for an item with no time", () => {
    render(<AgeChip since={undefined} basis={undefined} now={NOW} />);
    expect(screen.queryByTestId("age-chip")).toBeNull();
  });
});
