// ISS-1251 judge, 2026-11-16: the capabilities page's calls chart read 3400 as "400", its y-axis held
// at a width for three characters. The axis is as wide as its longest tick.
//
// @direct-test-of packages/web-v2/src/design/patterns/bar-chart.tsx

import { describe, expect, it } from "vitest";
import { axisWidthOf } from "./bar-chart";

const series = [
  { key: "calls", label: "Calls", fill: "x" },
  { key: "refused", label: "Refused", fill: "y" },
];
const row = (calls: number, refused: number) => ({ tick: "d", calls, refused });

describe("a bar chart's y-axis", () => {
  it("keeps its narrowest width for ticks of three characters", () => {
    expect(axisWidthOf([row(760, 40)], series, false)).toBe(40);
  });

  it("widens for each character its top tick adds, a stack read by its sum and an average by its value", () => {
    const three = axisWidthOf([row(760, 40)], series, false);
    expect(axisWidthOf([row(3400, 640)], series, false)).toBeGreaterThan(three);
    expect(axisWidthOf([row(11606, 0)], series, false)).toBeGreaterThan(axisWidthOf([row(3400, 0)], series, false));
    expect(axisWidthOf([row(600, 600)], series, true)).toBeGreaterThan(axisWidthOf([row(600, 600)], series, false));
    expect(axisWidthOf([row(10, 0)], series, false, 2400)).toBeGreaterThan(three);
  });
});
