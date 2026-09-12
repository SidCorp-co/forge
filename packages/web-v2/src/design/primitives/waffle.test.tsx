// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Waffle } from "./waffle";

afterEach(cleanup);

const cats = (counts: number[], onOpen?: () => void) =>
  counts.map((count, i) => ({
    key: `k${i}`,
    label: `Bucket ${i}`,
    count,
    color: "var(--accent)",
    onOpen,
  }));

describe("Waffle", () => {
  it("renders nothing when every category is zero", () => {
    const { container } = render(<Waffle categories={cats([0, 0])} />);
    expect(container.querySelector("li")).toBeNull();
  });

  // cm:guard the cell count is derived from each category's OWN count, so a small total draws exactly that many cells — rounding every category to a share of a fixed grid draws a 3-issue bucket the size of a 300-issue one (ISS-988 criterion 28)
  it("draws one cell per record while the total is small", () => {
    const { container } = render(<Waffle categories={cats([3, 5])} />);
    expect(container.querySelectorAll("[data-waffle-cell]").length).toBe(8);
  });

  it("says how many records a cell stands for once it stops being one", () => {
    render(<Waffle categories={cats([1000])} />);
    expect(screen.getByText(/Each cell is \d+ issues\./)).toBeTruthy();
  });

  it("opens a category's records by pointer and by Enter", () => {
    const onOpen = vi.fn();
    render(<Waffle categories={cats([4], onOpen)} />);
    const button = screen.getByRole("button", { name: /Bucket 0: 4 issues — open the list/ });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  // cm:guard a category with no `onOpen` is a figure the response cannot list, so it renders as a span with no button and nothing focusable (ISS-988 criteria 42-43)
  it("draws a category without a destination as no door at all", () => {
    const { container } = render(<Waffle categories={cats([4])} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
  });
});
