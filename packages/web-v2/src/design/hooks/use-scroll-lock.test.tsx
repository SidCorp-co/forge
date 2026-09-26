// @vitest-environment jsdom
//
// ISS-1172 measured at 07dba3f: a wheel of 200 over the issues list scrolled
// <main> by 200 while a row menu stayed open over it. The workspace scrolls
// <main>, not the document, so the lock has to cancel the gesture itself; these
// tests pin which gestures it cancels. Geometry is the browser walk's to prove.

import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useScrollLock } from "./use-scroll-lock";

afterEach(cleanup);

function Harness({ active }: { active: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useScrollLock(active, [panel]);
  return (
    <div>
      <div data-testid="page">page</div>
      <div ref={panel} data-testid="panel">
        <div data-testid="list" style={{ overflowY: "auto" }}>
          <span data-testid="row">row</span>
        </div>
        <span data-testid="label">label</span>
      </div>
    </div>
  );
}

/** jsdom lays nothing out, so a scroller's extent is stated rather than measured. */
function extent(el: HTMLElement, { top, client, total }: { top: number; client: number; total: number }) {
  Object.defineProperty(el, "clientHeight", { configurable: true, value: client });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: total });
  el.scrollTop = top;
}

function wheel(target: Element, deltaY: number): boolean {
  const e = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

function touch(target: Element): boolean {
  const e = new Event("touchmove", { bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

describe("useScrollLock", () => {
  it("cancels a wheel over the page behind an open surface", () => {
    const { getByTestId } = render(<Harness active />);
    expect(wheel(getByTestId("page"), 200)).toBe(true);
  });

  it("leaves a wheel over a list inside the surface that can still scroll that way", () => {
    const { getByTestId } = render(<Harness active />);
    extent(getByTestId("list"), { top: 0, client: 100, total: 400 });
    expect(wheel(getByTestId("row"), 120)).toBe(false);
  });

  it("cancels a wheel inside the surface once its list is at the end it is scrolling toward", () => {
    const { getByTestId } = render(<Harness active />);
    extent(getByTestId("list"), { top: 300, client: 100, total: 400 });
    expect(wheel(getByTestId("row"), 120)).toBe(true);
    expect(wheel(getByTestId("row"), -120)).toBe(false);
  });

  it("cancels a wheel inside the surface over nothing that scrolls", () => {
    const { getByTestId } = render(<Harness active />);
    expect(wheel(getByTestId("label"), 120)).toBe(true);
  });

  it("cancels a touch drag outside the surface and leaves one inside it", () => {
    const { getByTestId } = render(<Harness active />);
    expect(touch(getByTestId("page"))).toBe(true);
    expect(touch(getByTestId("row"))).toBe(false);
  });

  it("holds nothing while inactive", () => {
    const { getByTestId } = render(<Harness active={false} />);
    expect(wheel(getByTestId("page"), 200)).toBe(false);
    expect(touch(getByTestId("page"))).toBe(false);
  });

  it("leaves a list scrolling in one open surface while another surface is also open", () => {
    const { getAllByTestId } = render(
      <>
        <Harness active />
        <Harness active />
      </>,
    );
    const [, second] = getAllByTestId("list");
    extent(second, { top: 0, client: 100, total: 400 });
    expect(wheel(getAllByTestId("row")[1], 120)).toBe(false);
    expect(wheel(getAllByTestId("page")[0], 120)).toBe(true);
    expect(touch(getAllByTestId("row")[1])).toBe(false);
  });

  it("lets go when the surface closes", () => {
    const { getByTestId, rerender } = render(<Harness active />);
    rerender(<Harness active={false} />);
    expect(wheel(getByTestId("page"), 200)).toBe(false);
  });
});
