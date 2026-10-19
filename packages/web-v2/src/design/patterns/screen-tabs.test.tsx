// @vitest-environment jsdom
//
// A tab strip wider than the screen scrolls sideways, and the end that hides tabs says so: at 390 px
// the eight project settings tabs show four, and nothing else tells a person the rest exist.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenTabs } from "./screen-tabs";

expect.extend(matchers);

const TABS = ["General", "Shape & release", "Pipeline", "Runners", "Integrations", "Members", "Labels & modules", "Memory"].map(
  (label) => ({ value: label.toLowerCase(), label }),
);

/** jsdom lays nothing out, so the strip's widths are what each case says they are. */
function layout(strip: { scrollWidth: number; clientWidth: number }) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(strip.scrollWidth);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(strip.clientWidth);
}

function scroller(): HTMLElement {
  const el = screen.getByRole("tablist").parentElement;
  if (!el) throw new Error("no scroller");
  return el;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe("a tab strip wider than the screen", () => {
  it("shows a cue at the end that hides tabs, and none at the end that hides nothing", () => {
    layout({ scrollWidth: 820, clientWidth: 358 });
    render(<ScreenTabs tabs={TABS} value="general" />);
    expect(screen.getByTestId("more-tabs-after")).toBeInTheDocument();
    expect(screen.queryByTestId("more-tabs-before")).toBeNull();
  });

  it("moves the cue to the start once the strip is scrolled to its end", () => {
    layout({ scrollWidth: 820, clientWidth: 358 });
    render(<ScreenTabs tabs={TABS} value="general" />);
    act(() => {
      scroller().scrollLeft = 462;
      fireEvent.scroll(scroller());
    });
    expect(screen.getByTestId("more-tabs-before")).toBeInTheDocument();
    expect(screen.queryByTestId("more-tabs-after")).toBeNull();
  });

  it("shows a cue at both ends while scrolled to the middle", () => {
    layout({ scrollWidth: 820, clientWidth: 358 });
    render(<ScreenTabs tabs={TABS} value="general" />);
    act(() => {
      scroller().scrollLeft = 200;
      fireEvent.scroll(scroller());
    });
    expect(screen.getByTestId("more-tabs-before")).toBeInTheDocument();
    expect(screen.getByTestId("more-tabs-after")).toBeInTheDocument();
  });

  it("keeps the cue out of the accessibility tree and out of the pointer's way", () => {
    layout({ scrollWidth: 820, clientWidth: 358 });
    render(<ScreenTabs tabs={TABS} value="general" />);
    const cue = screen.getByTestId("more-tabs-after");
    expect(cue).toHaveAttribute("aria-hidden", "true");
    expect(cue.className).toContain("pointer-events-none");
  });
});

describe("a tab strip that fits", () => {
  it("shows no cue at either end", () => {
    layout({ scrollWidth: 1200, clientWidth: 1200 });
    render(<ScreenTabs tabs={TABS} value="general" />);
    expect(screen.queryByTestId("more-tabs-after")).toBeNull();
    expect(screen.queryByTestId("more-tabs-before")).toBeNull();
  });
});

describe("the open tab", () => {
  it("is scrolled into view when it changes", () => {
    layout({ scrollWidth: 820, clientWidth: 358 });
    const seen = vi.fn();
    HTMLElement.prototype.scrollIntoView = seen;
    const { rerender } = render(<ScreenTabs tabs={TABS} value="general" />);
    rerender(<ScreenTabs tabs={TABS} value="memory" />);
    expect(seen.mock.contexts.at(-1)).toHaveTextContent("Memory");
  });
});
