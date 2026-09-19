// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BulletBar } from "./bullet-bar";

afterEach(cleanup);

describe("BulletBar", () => {
  it("states the value against the whole it is part of", () => {
    render(<BulletBar label="Failed" value={3} total={12} />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("3 of 12")).toBeTruthy();
  });

  it("lets the caller name the pair where it is not a percentage", () => {
    render(<BulletBar label="Rework" value={6} total={20} valueText="6 fix · 20 code" />);
    expect(screen.getByText("6 fix · 20 code")).toBeTruthy();
  });

  it("draws an empty bar over a zero total instead of NaN", () => {
    const { container } = render(<BulletBar label="Failed" value={0} total={0} />);
    const fill = container.querySelector("[aria-hidden] > div") as HTMLElement;
    expect(fill.style.width).toBe("0%");
  });

  it("fills the bar in proportion to the pair", () => {
    const { container } = render(<BulletBar label="Failed" value={3} total={12} />);
    const fill = container.querySelector("[aria-hidden] > div") as HTMLElement;
    expect(Number.parseFloat(fill.style.width)).toBeCloseTo(25, 2);
  });
});
