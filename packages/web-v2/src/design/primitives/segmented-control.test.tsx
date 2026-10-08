// @vitest-environment jsdom
//
// ISS-1334: a tab's count was as wide as its digits, so a refused key (every count 0) narrowed the
// tab bar and the filter selects after it re-wrapped. A control that asks for a stable count takes
// one slot width for every figure; layout itself is measured in a browser, not here.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SegmentedControl, type SegmentOption } from "./segmented-control";

expect.extend(matchers);
afterEach(cleanup);

const options = (...counts: number[]): SegmentOption<string>[] =>
  counts.map((count, i) => ({ value: `t${i}`, label: `Tab ${i}`, count }));

const slot = (label: string) => screen.getByRole("button", { name: new RegExp(label) }).querySelector("span");

it("gives every count the same slot whatever it reads, when a stable width is asked for", () => {
  render(<SegmentedControl stableCountWidth options={options(0, 7, 1399, 9999, 100000)} value="t0" />);

  const classes = [0, 1, 2, 3, 4].map((i) => slot(`Tab ${i}`)?.className);

  expect(new Set(classes).size).toBe(1);
  expect(classes[0]).toContain("w-[5ch]");
});

it("keeps a count that does not fit its slot inside it, with the full figure on the tab", () => {
  render(<SegmentedControl stableCountWidth options={options(1399, 100000)} value="t0" />);

  expect(slot("Tab 0")).toHaveTextContent("1399");
  expect(slot("Tab 1")).toHaveTextContent("9999+");
  expect(screen.getByRole("button", { name: /Tab 1/ })).toHaveAttribute("title", "100000");
});

it("leaves a count as wide as its digits when no stable width is asked for", () => {
  render(<SegmentedControl options={options(0, 100000)} value="t0" />);

  expect(slot("Tab 0")?.className).not.toContain("w-[5ch]");
  expect(slot("Tab 1")).toHaveTextContent("100000");
});
