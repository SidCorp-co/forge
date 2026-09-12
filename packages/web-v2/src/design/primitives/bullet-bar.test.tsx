// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BulletBar } from "./bullet-bar";

afterEach(cleanup);

describe("BulletBar", () => {
  // cm:guard the denominator is rendered beside the rate AS TEXT: "12% failed" over four runs and over four hundred are different claims that a share alone renders identically, and the bar itself is aria-hidden, so this text is the whole of what a screen reader gets (ISS-988 criterion 37)
  it("states the value against the whole it is part of", () => {
    render(<BulletBar label="Failed" value={3} total={12} />);
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("3 of 12")).toBeTruthy();
  });

  it("lets the caller name the pair where it is not a percentage", () => {
    render(<BulletBar label="Rework" value={6} total={20} valueText="6 fix · 20 code" />);
    expect(screen.getByText("6 fix · 20 code")).toBeTruthy();
  });

  // cm:guard a zero denominator renders an EMPTY bar, never a NaN width — nothing has happened yet is a normal state on a new workspace (ISS-988 criterion 48)
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
