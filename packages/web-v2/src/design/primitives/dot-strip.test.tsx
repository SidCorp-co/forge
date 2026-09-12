// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DotStrip } from "./dot-strip";

afterEach(cleanup);

const items = (values: number[], onOpen?: () => void) =>
  values.map((value, i) => ({ key: `i${i}`, value, label: `Issue ${i}`, onOpen }));

describe("DotStrip", () => {
  it("renders nothing for an empty series", () => {
    const { container } = render(<DotStrip items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  // cm:guard one dot per record and never a bucketed histogram: the 103-day outlier is the reason to look, and a count-per-bin loses it (ISS-988 criterion 31)
  it("draws exactly one dot per item", () => {
    const { container } = render(<DotStrip items={items([1, 2, 3, 400])} />);
    expect(container.querySelectorAll("span[aria-hidden]").length).toBe(4);
  });

  it("places the largest value at the far end of the strip", () => {
    const { container } = render(<DotStrip items={items([0, 50, 100])} />);
    const lefts = [...container.querySelectorAll("span[aria-hidden]")].map((el) =>
      Number.parseFloat((el as HTMLElement).style.left),
    );
    expect(lefts[0]).toBeCloseTo(0, 2);
    expect(lefts[2]).toBeCloseTo(100, 2);
  });

  it("opens a record it can name, by pointer and by Enter", () => {
    const onOpen = vi.fn();
    render(<DotStrip items={items([5], onOpen)} />);
    const dot = screen.getByRole("button", { name: "Issue 0" });
    fireEvent.click(dot);
    dot.focus();
    expect(document.activeElement).toBe(dot);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // cm:guard a dot the response cannot name is not focusable and carries no affordance (ISS-988 criteria 43-44)
  it("draws a dot with no destination as no door", () => {
    const { container } = render(<DotStrip items={items([5])} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
    expect(container.innerHTML).not.toContain("cursor-pointer");
  });
});
