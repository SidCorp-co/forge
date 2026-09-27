// @vitest-environment jsdom
//
// ISS-1172: the command palette drew at z-50 inside the page, the same tier as
// every menu and dialog, and the page behind it scrolled under a wheel. It now
// renders on <body> at the palette tier and holds the page still; these tests
// pin both, and that the list inside it still scrolls.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Command, CommandPalette } from "./command-palette";

expect.extend(matchers);
afterEach(cleanup);

const COMMANDS: Command[] = [
  { label: "Go to issues", icon: "list" },
  { label: "Go to runners", icon: "server" },
];

function wheel(target: Element): boolean {
  const e = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("CommandPalette", () => {
  it("renders on <body> at the palette tier", () => {
    const { container } = render(<CommandPalette open onClose={vi.fn()} commands={COMMANDS} />);
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(container).not.toContainElement(dialog);
    expect(dialog.closest(".z-\\[55\\]")).not.toBeNull();
  });

  it("holds the page still while open", () => {
    render(
      <>
        <div data-testid="page">page</div>
        <CommandPalette open onClose={vi.fn()} commands={COMMANDS} />
      </>,
    );
    expect(wheel(screen.getByTestId("page"))).toBe(true);
  });

  it("leaves its own result list free to scroll", () => {
    render(<CommandPalette open onClose={vi.fn()} commands={COMMANDS} />);
    const row = screen.getByText("Go to issues");
    const list = row.closest(".overflow-y-auto") as HTMLElement;
    // jsdom applies no stylesheet, so the class's overflow and the list's
    // extent are stated here rather than computed.
    list.style.overflowY = "auto";
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 400 });
    expect(wheel(row)).toBe(false);
  });

  it("holds nothing once closed", () => {
    render(
      <>
        <div data-testid="page">page</div>
        <CommandPalette open={false} onClose={vi.fn()} commands={COMMANDS} />
      </>,
    );
    expect(wheel(screen.getByTestId("page"))).toBe(false);
  });
});
