// @vitest-environment jsdom
//
// ISS-1172 measured at 07dba3f: the last row's menu on the issues list was 565px
// tall and 36px of it was visible, cut off by the Table primitive's
// `overflow-hidden` wrapper because the panel rendered in place. What jsdom can
// hold is the wiring that removes that mechanism: the panel leaves the clipping
// ancestor for <body>, is placed `fixed`, and carries the caps the size
// middleware writes. Coordinates are the browser walk's to prove.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Layer, Popover, type PopoverProps } from "./popover";

expect.extend(matchers);
afterEach(cleanup);

// jsdom reports a 0×0 viewport through <html>, which is what the size
// middleware measures the room against; state the window's size there instead.
beforeEach(() => {
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: window.innerWidth });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: window.innerHeight });
});

type Extra = Partial<Omit<PopoverProps, "anchor" | "children">>;

function Clipped({ open = true, anchorWidth, ...extra }: Extra & { anchorWidth?: number }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div data-testid="clip" style={{ overflow: "hidden", height: 40 }}>
      <button
        ref={(el) => {
          anchor.current = el;
          if (el && anchorWidth) {
            el.getBoundingClientRect = () =>
              ({ x: 20, y: 20, top: 20, left: 20, right: 20 + anchorWidth, bottom: 52, width: anchorWidth, height: 32, toJSON() {} }) as DOMRect;
          }
        }}
        type="button"
      >
        trigger
      </button>
      <Popover open={open} anchor={anchor} data-testid="panel" {...extra}>
        <span data-testid="inside">inside</span>
      </Popover>
    </div>
  );
}

describe("Popover", () => {
  it("renders the panel on <body>, outside the ancestor that would clip it", () => {
    render(<Clipped />);
    const panel = screen.getByTestId("panel");
    expect(screen.getByTestId("clip")).not.toContainElement(panel);
    expect(document.body).toContainElement(panel);
  });

  it("places the panel at position fixed, so no scrolling ancestor carries it off", async () => {
    render(<Clipped />);
    await waitFor(() => expect(screen.getByTestId("panel").style.position).toBe("fixed"));
  });

  it("renders nothing while closed", () => {
    render(<Clipped open={false} />);
    expect(screen.queryByTestId("panel")).toBeNull();
  });

  it("caps the panel's height at the cap asked for and its width at the viewport", async () => {
    render(<Clipped maxHeight={256} />);
    const panel = screen.getByTestId("panel");
    await waitFor(() => expect(panel.style.maxHeight).toBe("256px"));
    const width = Number.parseFloat(panel.style.maxWidth);
    expect(width).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(window.innerWidth - 16);
  });

  it("caps a panel to the room it has when that is below the cap", async () => {
    render(<Clipped maxHeight={100_000} />);
    const panel = screen.getByTestId("panel");
    await waitFor(() => expect(panel.style.maxHeight).not.toBe(""));
    const room = Number.parseFloat(panel.style.maxHeight);
    expect(room).toBeGreaterThan(0);
    expect(room).toBeLessThan(window.innerHeight);
  });

  it("sizes the panel to the anchor's width when asked", async () => {
    render(<Clipped matchAnchorWidth anchorWidth={212} />);
    await waitFor(() => expect(screen.getByTestId("panel").style.width).toBe("212px"));
  });

  it("is dismissed by a press outside both the anchor and the panel", () => {
    const onDismiss = vi.fn();
    render(<Clipped onDismiss={onDismiss} />);
    fireEvent.mouseDown(document.body);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("is not dismissed by a press on its anchor or inside it", () => {
    const onDismiss = vi.fn();
    render(<Clipped onDismiss={onDismiss} />);
    fireEvent.mouseDown(screen.getByText("trigger"));
    fireEvent.mouseDown(screen.getByTestId("inside"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("holds the page still while open when asked to lock scroll", () => {
    render(<Clipped lockScroll />);
    const e = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("leaves the page free when not asked to lock scroll", () => {
    render(<Clipped />);
    const e = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("moves focus into a panel that takes focus, and back to the anchor when it closes", async () => {
    function Focusing() {
      const anchor = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)}>
            help
          </button>
          <button type="button">next on the page</button>
          <Popover open={open} anchor={anchor} onDismiss={() => setOpen(false)} takesFocus>
            <button type="button" onClick={() => setOpen(false)}>
              close
            </button>
          </Popover>
        </>
      );
    }
    render(<Focusing />);
    const trigger = screen.getByText("help");
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("close")));
    fireEvent.click(screen.getByText("close"));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("leaves focus where it is for a panel that does not take focus", async () => {
    render(<Clipped />);
    const trigger = screen.getByText("trigger");
    trigger.focus();
    await waitFor(() => expect(screen.getByTestId("panel").style.position).toBe("fixed"));
    expect(document.activeElement).toBe(trigger);
  });

  it("sits on the panel tier, below the palette tier", () => {
    render(
      <>
        <Clipped />
        <Layer tier="palette">
          <span data-testid="palette">palette</span>
        </Layer>
      </>,
    );
    expect(screen.getByTestId("panel")).toHaveClass("z-50");
    expect(screen.getByTestId("palette").parentElement).toHaveClass("z-[55]");
    expect(document.body).toContainElement(screen.getByTestId("palette"));
  });
});
