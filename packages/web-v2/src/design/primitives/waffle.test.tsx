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

  it("draws a category without a destination as no door at all", () => {
    const { container } = render(<Waffle categories={cats([4])} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
  });
});
