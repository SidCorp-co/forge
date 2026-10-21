// @vitest-environment jsdom
//
// ISS-1172: the tooltip was drawn inside its trigger's wrapper with fixed CSS
// offsets, so at a viewport edge or in a clipping ancestor part of it was lost.
// It is now placed by Popover on <body>; these tests pin that it is, and that
// hover and keyboard focus still show and hide it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/**
 * ISS-1229 r30, judge-86: on a phone the reason showed for about 12 ms. A touch browser follows a tap
 * with the mouse events it emulates, ending in a mouseleave after the click, and the tooltip closed on
 * that. These send the events in the order Chrome sends them for a tap, not a bare touchend.
 */
describe("a sentence tooltip on a touch screen", () => {
  function Held() {
    return (
      <div>
        <Tooltip prose label="Add another agent first.">
          <button type="button">take out</button>
        </Tooltip>
        <p>elsewhere</p>
      </div>
    );
  }
  const tap = (el: Element) => {
    fireEvent.pointerDown(el, { pointerType: "touch" });
    fireEvent.touchStart(el);
    fireEvent.pointerUp(el, { pointerType: "touch" });
    fireEvent.touchEnd(el);
    fireEvent.mouseEnter(el);
    fireEvent.mouseDown(el);
    fireEvent.focus(el);
    fireEvent.mouseUp(el);
    fireEvent.click(el);
    fireEvent.mouseLeave(el);
  };

  it("keeps the sentence after the mouse events a tap is followed by", () => {
    render(<Held />);
    tap(screen.getByText("take out"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("Add another agent first.");
  });

  it("puts it away on a tap anywhere else", () => {
    render(<Held />);
    tap(screen.getByText("take out"));
    fireEvent.pointerDown(screen.getByText("elsewhere"), { pointerType: "touch" });
    fireEvent.touchStart(screen.getByText("elsewhere"));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("puts it away on Escape", () => {
    render(<Held />);
    tap(screen.getByText("take out"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  // r31, judge-88: a bubble over a crowded panel covered the control its sentence names.
  it("draws no bubble for a tap where the caller shows the sentence itself, and tells it when to stop", () => {
    const shown = vi.fn();
    render(
      <div>
        <Tooltip prose label="Add another agent first." onTouchShown={shown}>
          <button type="button">take out</button>
        </Tooltip>
        <p>elsewhere</p>
      </div>,
    );
    tap(screen.getByText("take out"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(shown).toHaveBeenLastCalledWith(true);
    fireEvent.pointerDown(screen.getByText("elsewhere"), { pointerType: "touch" });
    expect(shown).toHaveBeenLastCalledWith(false);
    const trigger = screen.getByText("take out");
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    expect(shown).toHaveBeenLastCalledWith(false);
  });

  it("still opens on a mouse's hover and closes when the mouse leaves", () => {
    render(<Held />);
    const trigger = screen.getByText("take out");
    fireEvent.pointerDown(trigger, { pointerType: "mouse" });
    fireEvent.mouseEnter(trigger);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
