// @vitest-environment jsdom
// The layout half is measured in a real Chrome by sticky-reach.test.tsx.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Truncated } from "./truncated";

expect.extend(matchers);
afterEach(cleanup);

describe("Truncated", () => {
  it("draws the whole text and carries the whole of it as its title", () => {
    render(<Truncated text="AdminHub UI" />);
    const el = screen.getByText("AdminHub UI");
    expect(el).toHaveAttribute("title", "AdminHub UI");
  });

  it("is a single line that may shrink inside its cell, and takes the caller's classes", () => {
    render(<Truncated text="SID_GROWTH" className="font-mono" />);
    const el = screen.getByText("SID_GROWTH");
    expect(el).toHaveClass("truncate", "min-w-0", "block", "font-mono");
  });

  it("stays out of the tab order, and says nothing more, while its text fits", () => {
    render(<Truncated text="SID_GROWTH" />);
    const el = screen.getByText("SID_GROWTH");
    expect(el).not.toHaveAttribute("tabindex");
    expect(el).not.toHaveAttribute("role");
    fireEvent.focus(el);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

// jsdom has no layout, so a line is cut where a test says its content is wider than its box.
describe("Truncated, when its text is cut", () => {
  const TEXT = "Project: qa-project-available-for-testing-0xxxxxx";
  function cutAt(content: number, box: number) {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(content);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(box);
  }
  afterEach(() => vi.restoreAllMocks());

  it("can be focused and is named by the whole text", () => {
    cutAt(300, 144);
    render(<Truncated text={TEXT} />);
    const el = screen.getByRole("group", { name: TEXT });
    expect(el).toHaveAttribute("tabindex", "0");
    expect(el).toHaveAttribute("title", TEXT);
  });

  it("shows the whole text on focus, tap included, and hides it on blur", () => {
    cutAt(300, 144);
    render(<Truncated text={TEXT} />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focus(screen.getByRole("group", { name: TEXT }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(TEXT);
    fireEvent.blur(screen.getByRole("group", { name: TEXT }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("is not focusable at the width where it fits exactly", () => {
    cutAt(144, 144);
    render(<Truncated text={TEXT} />);
    expect(screen.getByText(TEXT)).not.toHaveAttribute("tabindex");
  });
});
