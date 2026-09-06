// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Sparkline } from "./sparkline";

afterEach(cleanup);

function path(points: number[]): string | null {
  const { container } = render(<Sparkline points={points} width={100} height={20} />);
  return container.querySelector("path")?.getAttribute("d") ?? null;
}

describe("Sparkline", () => {
  it("renders nothing for a series that cannot make a line", () => {
    expect(render(<Sparkline points={[]} />).container.querySelector("svg")).toBeNull();
    cleanup();
    expect(render(<Sparkline points={[3]} />).container.querySelector("svg")).toBeNull();
  });

  // cm:guard a flat series makes min === max, so dividing by the span yields NaN for every coordinate: an invisible path, no error anywhere, and a metric that has not moved reads on screen as one with no data at all
  it("draws a flat series down the middle instead of NaN", () => {
    for (const flat of [[0, 0, 0, 0], [7, 7, 7]]) {
      const d = path(flat);
      expect(d).not.toBeNull();
      expect(d).not.toContain("NaN");
    }
  });

  it("puts the lowest point at the bottom and the highest at the top", () => {
    const d = path([0, 10]) as string;
    const [, y0, y1] = d.match(/M[\d.]+,([\d.]+) L[\d.]+,([\d.]+)/) ?? [];
    expect(Number(y0)).toBeGreaterThan(Number(y1));
  });

  it("is hidden from assistive tech — the value beside it is the datum", () => {
    const { container } = render(<Sparkline points={[1, 2, 3]} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
