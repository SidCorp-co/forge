// @vitest-environment jsdom

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

it("says which option is picked, to a screen reader and not by colour alone, and follows the pick", () => {
  const { rerender } = render(<SegmentedControl options={options(0, 0)} value="t0" />);
  expect(screen.getByRole("button", { name: /Tab 0/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /Tab 1/ })).toHaveAttribute("aria-pressed", "false");

  rerender(<SegmentedControl options={options(0, 0)} value="t1" />);
  expect(screen.getByRole("button", { name: /Tab 0/ })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: /Tab 1/ })).toHaveAttribute("aria-pressed", "true");
});
