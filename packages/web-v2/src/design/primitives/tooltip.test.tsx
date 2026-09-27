// @vitest-environment jsdom
//
// ISS-1172: the tooltip was drawn inside its trigger's wrapper with fixed CSS
// offsets, so at a viewport edge or in a clipping ancestor part of it was lost.
// It is now placed by Popover on <body>; these tests pin that it is, and that
// hover and keyboard focus still show and hide it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tooltip } from "./tooltip";

expect.extend(matchers);
afterEach(cleanup);

function Clipped() {
  return (
    <div data-testid="clip" style={{ overflow: "hidden" }}>
      <Tooltip label="Display density">
        <button type="button">density</button>
      </Tooltip>
    </div>
  );
}

describe("Tooltip", () => {
  it("shows on hover, on <body> outside the clipping ancestor, and hides on leave", () => {
    render(<Clipped />);
    fireEvent.mouseEnter(screen.getByText("density"));
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent("Display density");
    expect(screen.getByTestId("clip")).not.toContainElement(tip);
    expect(tip).toHaveClass("pointer-events-none");
    fireEvent.mouseLeave(screen.getByText("density"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows on keyboard focus and hides on blur", () => {
    render(<Clipped />);
    fireEvent.focus(screen.getByText("density"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Display density");
    fireEvent.blur(screen.getByText("density"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("is not dismissed by a press elsewhere, and does not hold the page still", () => {
    render(<Clipped />);
    fireEvent.mouseEnter(screen.getByText("density"));
    fireEvent.mouseDown(document.body);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    const e = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});
