// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Heartbeat } from "./heartbeat";

afterEach(cleanup);

const days = (values: number[]) =>
  values.map((value, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, value }));

describe("Heartbeat", () => {
  it("renders nothing without a series", () => {
    const { container } = render(<Heartbeat days={[]} label="none" />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws a flatline rather than nothing when every day is zero", () => {
    const { container } = render(<Heartbeat days={days([0, 0, 0, 0])} label="nothing ran" />);
    const d = container.querySelector("path")?.getAttribute("d");
    expect(d).toBeTruthy();
    const ys = [...(d as string).matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size).toBe(1);
  });

  it("varies the trace when the days differ", () => {
    const { container } = render(<Heartbeat days={days([0, 5, 2, 9])} label="ran" />);
    const d = container.querySelector("path")?.getAttribute("d") as string;
    const ys = [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size).toBeGreaterThan(1);
  });

  it("carries its figures as text for a reader who cannot see it", () => {
    render(<Heartbeat days={days([1, 2])} label="Two days of runs." />);
    expect(screen.getByRole("img", { name: "Two days of runs." })).toBeTruthy();
  });

  it("offers no door: nothing focusable and no button", () => {
    const { container } = render(<Heartbeat days={days([1, 0, 3])} label="x" />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
  });
});
