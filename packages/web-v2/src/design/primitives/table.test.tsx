// @vitest-environment jsdom
//
// ISS-1147: the Table clipped columns past its card with no scroll route and no
// cue. jsdom has no layout, so these tests plant the scroller's measured widths
// and pin what the primitive does with them: which edge cue shows, when the
// scroll area becomes a named tab stop, and that the table keeps its props.
// Whether a column is actually reachable is the browser walk's to prove.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Table, TBody, TD, TH, THead, TR } from "./table";

expect.extend(matchers);

const geometry = { scrollWidth: 0, clientWidth: 0 };
const isScroller = (el: Element) => el.firstElementChild?.tagName === "TABLE";
const observers: Array<() => void> = [];

beforeEach(() => {
  for (const key of ["scrollWidth", "clientWidth"] as const) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? geometry[key] : 0;
      },
    });
  }
  globalThis.ResizeObserver = class {
    constructor(private readonly cb: () => void) {
      observers.push(() => this.cb());
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  observers.length = 0;
});

function Sample(props: { "aria-label"?: string; "data-testid"?: string; className?: string }) {
  return (
    <Table {...props}>
      <TBody>
        <TR>
          <TD>cell</TD>
        </TR>
      </TBody>
    </Table>
  );
}

const scroller = (container: HTMLElement) => container.querySelector("table")?.parentElement as HTMLElement;
const cue = (container: HTMLElement, side: "start" | "end") =>
  container.querySelector(`[data-table-edge="${side}"]`);

function scrollTo(el: HTMLElement, left: number) {
  el.scrollLeft = left;
  fireEvent.scroll(el);
}

describe("Table — a table that fits its card", () => {
  it("shows no edge cue and adds no tab stop", () => {
    Object.assign(geometry, { scrollWidth: 800, clientWidth: 800 });
    const { container } = render(<Sample />);
    expect(cue(container, "start")).toHaveAttribute("data-visible", "false");
    expect(cue(container, "end")).toHaveAttribute("data-visible", "false");
    expect(scroller(container)).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("treats a sub-pixel remainder as fitting", () => {
    Object.assign(geometry, { scrollWidth: 801, clientWidth: 800 });
    const { container } = render(<Sample />);
    expect(cue(container, "end")).toHaveAttribute("data-visible", "false");
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("Table — a table wider than its card", () => {
  beforeEach(() => {
    Object.assign(geometry, { scrollWidth: 1218, clientWidth: 882 });
  });

  it("shows the end cue only, at the start of the scroll", () => {
    const { container } = render(<Sample />);
    expect(cue(container, "start")).toHaveAttribute("data-visible", "false");
    expect(cue(container, "end")).toHaveAttribute("data-visible", "true");
  });

  it("shows both cues in the middle and only the start cue at the far end", () => {
    const { container } = render(<Sample />);
    const el = scroller(container);
    act(() => scrollTo(el, 100));
    expect(cue(container, "start")).toHaveAttribute("data-visible", "true");
    expect(cue(container, "end")).toHaveAttribute("data-visible", "true");
    act(() => scrollTo(el, 1218 - 882));
    expect(cue(container, "start")).toHaveAttribute("data-visible", "true");
    expect(cue(container, "end")).toHaveAttribute("data-visible", "false");
  });

  it("hides the cues from assistive technology", () => {
    const { container } = render(<Sample />);
    expect(cue(container, "end")).toHaveAttribute("aria-hidden", "true");
  });

  it("makes the scroll area a focusable region with the default name", () => {
    render(<Sample />);
    const region = screen.getByRole("region", { name: "Table, scrolls sideways" });
    expect(region).toHaveAttribute("tabindex", "0");
    region.focus();
    expect(region).toHaveFocus();
  });

  it("names each region after its own table's label", () => {
    render(
      <>
        <Sample aria-label="Issues" />
        <Sample aria-label="Sessions" />
      </>,
    );
    expect(screen.getByRole("region", { name: "Issues" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Issues" })).toBeInTheDocument();
  });
});

describe("Table — size changes without a scroll", () => {
  it("re-measures when the table grows past its card", () => {
    Object.assign(geometry, { scrollWidth: 800, clientWidth: 800 });
    const { container } = render(<Sample />);
    expect(cue(container, "end")).toHaveAttribute("data-visible", "false");
    geometry.scrollWidth = 1100;
    act(() => {
      for (const notify of observers) notify();
    });
    expect(cue(container, "end")).toHaveAttribute("data-visible", "true");
    expect(screen.getByRole("region")).toHaveAttribute("tabindex", "0");
  });
});

describe("Table — the table element", () => {
  it("still receives className and every other prop", () => {
    Object.assign(geometry, { scrollWidth: 800, clientWidth: 800 });
    render(<Sample data-testid="t" className="min-w-[520px]" />);
    const table = screen.getByTestId("t");
    expect(table.tagName).toBe("TABLE");
    expect(table).toHaveClass("min-w-[520px]", "w-full");
  });
});

describe("Table — a sticky first column holds the start edge", () => {
  beforeEach(() => {
    Object.assign(geometry, { scrollWidth: 1218, clientWidth: 882 });
  });

  function Stuck() {
    return (
      <Table stickyStart>
        <THead>
          <TR>
            <TH sticky>Name</TH>
            <TH>Other</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD sticky>first</TD>
            <TD>second</TD>
          </TR>
        </TBody>
      </Table>
    );
  }

  it("gives the sticky cells, and only them, the classes that pin them to the start edge", () => {
    render(<Stuck />);
    for (const name of ["Name", "first"]) {
      expect(screen.getByText(name)).toHaveClass("sticky", "left-0", "bg-surface");
    }
    for (const name of ["Other", "second"]) expect(screen.getByText(name)).not.toHaveClass("sticky");
  });

  it("lets the body cell take the row's hover colour and the header cell not", () => {
    render(<Stuck />);
    expect(screen.getByText("first")).toHaveClass("group-hover/row:bg-hover");
    expect(screen.getByText("Name")).not.toHaveClass("group-hover/row:bg-hover");
  });

  it("marks the scroller once it has scrolled, so the sticky cell can draw its hairline, and draws no start cue over the column", () => {
    const { container } = render(<Stuck />);
    expect(scroller(container)).toHaveAttribute("data-edge-start", "false");
    act(() => scrollTo(scroller(container), 100));
    expect(scroller(container)).toHaveAttribute("data-edge-start", "true");
    expect(cue(container, "start")).toHaveAttribute("data-visible", "false");
    expect(cue(container, "end")).toHaveAttribute("data-visible", "true");
  });

  it("keeps the start cue for a table with no sticky column", () => {
    const { container } = render(<Sample />);
    act(() => scrollTo(scroller(container), 100));
    expect(cue(container, "start")).toHaveAttribute("data-visible", "true");
  });
});
