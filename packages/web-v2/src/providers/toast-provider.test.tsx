// @vitest-environment jsdom
//
// A toast never moves the page under it: the lane overlays at every width, over the
// top edge, because room taken from <main> lifted the page's save bar while a toast
// showed (ISS-1171, at 1280 as on a phone). It overlays an open dialog too (ISS-1289).
// jsdom lays nothing out, so these read placement and the bounds that hold it;
// the painted geometry is measured in a browser.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlideOver } from "@/design/patterns/slide-over";
import { MAX_VISIBLE_TOASTS, ToastLane, ToastProvider, useToast, type ToastInput } from "./toast-provider";

expect.extend(matchers);

let fire: (t: ToastInput) => void = () => {};
let dismiss: (slot: string) => void = () => {};
function Trigger() {
  ({ toast: fire, dismiss } = useToast());
  return null;
}

function Frame({ withLane = true }: { withLane?: boolean }) {
  return (
    <ToastProvider>
      <Trigger />
      <div data-testid="column" className="flex flex-col">
        <main data-testid="main">content</main>
        {withLane ? <ToastLane /> : null}
      </div>
    </ToastProvider>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("inside a frame, toasts go to the lane", () => {
  it("renders the lane on <body>, outside the frame, and not the corner", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    const lane = screen.getByTestId("toast-lane");
    expect(lane).toHaveTextContent("Saved");
    expect(lane.parentElement).toBe(document.body);
    expect(screen.getByTestId("column")).not.toContainElement(lane);
    expect(screen.queryByTestId("toast-corner")).not.toBeInTheDocument();
  });

  // A toast raised while a drawer is open is seen, not painted under the drawer's scrim (ISS-1289):
  // the drawer is a portal on <body>, so the lane is one too, and z-index alone orders them.
  it("shows above an open slide-over: both on <body>, the lane at the higher tier", () => {
    render(
      <ToastProvider>
        <Trigger />
        <SlideOver open onClose={() => {}} title="A drawer">
          <p>panel</p>
        </SlideOver>
        <div data-testid="column">
          <ToastLane />
        </div>
      </ToastProvider>,
    );
    act(() => fire({ title: "Saved" }));

    const lane = screen.getByTestId("toast-lane");
    const dialogLayer = screen.getByRole("dialog").parentElement as HTMLElement;
    const tier = (el: HTMLElement) => Number(/(?:^|\s)z-\[?(\d+)\]?(?:\s|$)/.exec(el.className)?.[1] ?? Number.NaN);
    expect(lane.parentElement).toBe(document.body);
    expect(dialogLayer.parentElement).toBe(document.body);
    expect(tier(lane)).toBeGreaterThan(tier(dialogLayer));
  });

  it("is out of flow at every width, so it takes no room from the column at 1280 either", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    const classes = screen.getByTestId("toast-lane").className.split(/\s+/);
    expect(classes).toContain("fixed");
    expect(classes.filter((c) => /^max-md:(fixed|absolute)$/.test(c))).toEqual([]);
    expect(classes).not.toContain("flex-none");
  });

  it("overlays the top edge, letting touches through but to its toasts", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    const classes = screen.getByTestId("toast-lane").className.split(/\s+/);
    for (const overlay of ["fixed", "inset-x-0", "pointer-events-none"]) {
      expect(classes).toContain(overlay);
    }
    expect(screen.getByText("Saved").closest(".pointer-events-auto")).not.toBeNull();
  });

  it("caps its height and scrolls inside itself past the cap", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    const cls = screen.getByTestId("toast-lane").className;
    expect(cls).toContain("max-h-[35dvh]");
    expect(cls).toContain("overflow-y-auto");
  });

  it("keeps clear of the bottom edge at every width, where the tab bar and a save bar sit", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    const classes = screen.getByTestId("toast-lane").className.split(/\s+/);
    expect(classes.some((c) => c.startsWith("top-"))).toBe(true);
    expect(classes.filter((c) => /^(md:|max-md:)?bottom-/.test(c))).toEqual([]);
  });

  it("takes no room at all while nothing is showing", () => {
    render(<Frame />);
    expect(screen.queryByTestId("toast-lane")).not.toBeInTheDocument();
  });

  it("leaves every toast dismissable from the lane", () => {
    render(<Frame />);
    act(() => {
      fire({ title: "One", duration: 0 });
      fire({ title: "Two", duration: 0 });
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]);
    expect(screen.queryByText("One")).not.toBeInTheDocument();
    expect(screen.getByText("Two")).toBeInTheDocument();
  });
});

describe("with no frame, the corner is kept", () => {
  it("renders the fixed bottom-right stack when no lane is mounted", () => {
    render(<Frame withLane={false} />);
    act(() => fire({ title: "Signed in" }));

    const corner = screen.getByTestId("toast-corner");
    expect(corner).toHaveTextContent("Signed in");
    expect(corner.className).toContain("fixed");
    expect(corner.className).toContain("bottom-5");
    expect(corner.className).toContain("right-5");
  });

  it("moves to the corner when the frame's lane unmounts with a toast still showing", () => {
    const { rerender } = render(<Frame />);
    act(() => fire({ title: "Still here", duration: 0 }));
    expect(screen.getByTestId("toast-lane")).toBeInTheDocument();

    rerender(<Frame withLane={false} />);
    expect(screen.queryByTestId("toast-lane")).not.toBeInTheDocument();
    expect(screen.getByTestId("toast-corner")).toHaveTextContent("Still here");
  });
});

describe("how many toasts show", () => {
  it(`shows at most ${MAX_VISIBLE_TOASTS}, the oldest giving up its place`, () => {
    render(<Frame />);
    act(() => {
      for (const n of [1, 2, 3, 4]) fire({ title: `Toast ${n}`, duration: 0 });
    });

    expect(MAX_VISIBLE_TOASTS).toBe(3);
    expect(screen.queryByText("Toast 1")).not.toBeInTheDocument();
    for (const n of [2, 3, 4]) expect(screen.getByText(`Toast ${n}`)).toBeInTheDocument();
  });

  // ISS-1229 r29 review F1: three later notices pushed out the one holding an unsent message.
  it("keeps a toast marked keep past any number of newer ones, and past its duration", () => {
    render(<Frame />);
    act(() => {
      fire({ title: "Your message", keep: true });
      for (const n of [1, 2, 3, 4]) fire({ title: `Toast ${n}`, duration: 0 });
    });

    expect(screen.getByText("Your message")).toBeInTheDocument();
    expect(screen.queryByText("Toast 2")).not.toBeInTheDocument();
    for (const n of [3, 4]) expect(screen.getByText(`Toast ${n}`)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Your message")).toBeInTheDocument();
    const card = screen.getByText("Your message").closest(".pointer-events-auto") as HTMLElement;
    fireEvent.click(within(card).getByLabelText("Dismiss"));
    expect(screen.queryByText("Your message")).not.toBeInTheDocument();
  });

  it("gives a burst sharing a slot one card, showing the newest", () => {
    render(<Frame />);
    act(() => {
      fire({ title: "Resolved — ISS-1", slot: "notification", duration: 0 });
      fire({ title: "Resolved — ISS-2", slot: "notification", duration: 0 });
      fire({ title: "Resolved — ISS-3", slot: "notification", duration: 0 });
    });

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Resolved — ISS-3")).toBeInTheDocument();
  });

  it("does not let a slot displace a toast the person caused", () => {
    render(<Frame />);
    act(() => {
      fire({ title: "Copied", duration: 0 });
      fire({ title: "Background A", slot: "notification", duration: 0 });
      fire({ title: "Background B", slot: "notification", duration: 0 });
    });

    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Background B")).toBeInTheDocument();
    expect(screen.queryByText("Background A")).not.toBeInTheDocument();
  });

  it("still expires a toast after its duration", () => {
    render(<Frame />);
    act(() => fire({ title: "Brief", duration: 4000 }));
    expect(screen.getByText("Brief")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText("Brief")).not.toBeInTheDocument();
  });

  it("dismisses the toasts holding a slot, and keeps every other one", () => {
    render(<Frame />);
    act(() => {
      fire({ title: "Re-authenticate to continue", slot: "token-form", duration: 0 });
      fire({ title: "Copied", duration: 0 });
      fire({ title: "Background", slot: "notification", duration: 0 });
    });

    act(() => dismiss("token-form"));
    expect(screen.queryByText("Re-authenticate to continue")).not.toBeInTheDocument();
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Background")).toBeInTheDocument();
  });
});

/**
 * ISS-1229 r30, judge-86: the notice holding a deleted room's unsent message closed when it was
 * selected to copy, so it could be copied once; and at 390 it sat over New conversation and the first
 * room of the list the reader is returned to.
 */
describe("a toast marked keep", () => {
  const wide = (matches: boolean) => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
  };
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("stays after it is selected, and goes only by its Dismiss control", () => {
    const copy = vi.fn();
    render(<Frame />);
    act(() => fire({ title: "This room was deleted", keep: true, onClick: copy }));

    fireEvent.click(screen.getByText("This room was deleted"));
    fireEvent.click(screen.getByText("This room was deleted"));
    expect(copy).toHaveBeenCalledTimes(2);
    expect(screen.getByText("This room was deleted")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Dismiss"));
    expect(screen.queryByText("This room was deleted")).not.toBeInTheDocument();
  });

  it("still lets a passing toast go once it is selected", () => {
    const open = vi.fn();
    render(<Frame />);
    act(() => fire({ title: "Resolved — ISS-3", duration: 0, onClick: open }));
    fireEvent.click(screen.getByText("Resolved — ISS-3"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Resolved — ISS-3")).not.toBeInTheDocument();
  });

  it("sits at the bottom on a phone, above the tab bar, clear of the top of the page", () => {
    wide(false);
    render(<Frame />);
    act(() => {
      fire({ title: "This room was deleted", keep: true });
      fire({ title: "Saved", duration: 0 });
    });

    const kept = screen.getByTestId("toast-lane-kept");
    expect(kept).toHaveTextContent("This room was deleted");
    expect(kept.parentElement).toBe(document.body);
    const classes = kept.className.split(/\s+/);
    expect(classes).toContain("bottom-[calc(56px+env(safe-area-inset-bottom))]");
    expect(classes.some((c) => /^top-/.test(c))).toBe(false);
    expect(classes).toContain("pointer-events-none");
    expect(screen.getByTestId("toast-lane")).not.toHaveTextContent("This room was deleted");
    expect(screen.getByTestId("toast-lane")).toHaveTextContent("Saved");
  });

  // ISS-1421 r27, judge-110 (b): at 390 "Integration saved" covered the drawer's title and badge.
  it("starts below an open drawer's header on a phone, and at the top with none open", async () => {
    wide(false);
    const header = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return { bottom: this.tagName === "HEADER" ? 61 : 0 } as DOMRect;
      });
    try {
      const { rerender } = render(
        <ToastProvider>
          <Trigger />
          <SlideOver open onClose={() => {}} title="Sentry">
            <p>panel</p>
          </SlideOver>
          <ToastLane />
        </ToastProvider>,
      );
      act(() => fire({ title: "Integration saved", duration: 0 }));
      expect(screen.getByTestId("toast-lane")).toHaveStyle({ top: "61px" });

      rerender(
        <ToastProvider>
          <Trigger />
          <SlideOver open={false} onClose={() => {}} title="Sentry">
            <p>panel</p>
          </SlideOver>
          <ToastLane />
        </ToastProvider>,
      );
      // The drawer leaves after its exit; the lane reads the body again once it has gone.
      await act(async () => {
        vi.advanceTimersByTime(1000);
        await Promise.resolve();
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(screen.getByTestId("toast-lane").style.top).toBe("");
    } finally {
      header.mockRestore();
    }
  });

  it("keeps to its place under the top bar on a wide screen, drawer open or not", () => {
    wide(true);
    render(
      <ToastProvider>
        <Trigger />
        <SlideOver open onClose={() => {}} title="Sentry">
          <p>panel</p>
        </SlideOver>
        <ToastLane />
      </ToastProvider>,
    );
    act(() => fire({ title: "Integration saved", duration: 0 }));
    expect(screen.getByTestId("toast-lane").style.top).toBe("");
  });

  it("stays with the other toasts on a wide screen", () => {
    wide(true);
    render(<Frame />);
    act(() => fire({ title: "This room was deleted", keep: true }));

    expect(screen.getByTestId("toast-lane")).toHaveTextContent("This room was deleted");
    expect(screen.queryByTestId("toast-lane-kept")).not.toBeInTheDocument();
  });
});


// ISS-1229 r32 review F1: a notice whose text is to be selected by hand keeps that text's spaces and
// blank lines; the usual description collapses them.
describe("a toast whose description is verbatim", () => {
  it("keeps runs of spaces and blank lines as written", () => {
    render(<Frame />);
    act(() => fire({ title: "Kept", description: "    indented\n\n", verbatim: true, keep: true }));
    const text = screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "    indented\n\n");
    expect(text).toHaveClass("whitespace-pre-wrap");
    expect(text).not.toHaveClass("whitespace-pre-line");
  });

  it("is not asked of an ordinary toast", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved", description: "All good." }));
    expect(screen.getByText("All good.")).toHaveClass("whitespace-pre-line");
  });
});
