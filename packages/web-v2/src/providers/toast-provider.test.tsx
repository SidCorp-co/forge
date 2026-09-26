// @vitest-environment jsdom
//
// A toast never covers what a person is reading. Inside a frame that is a
// layout fact — the lane is an in-flow sibling of <main>, so it takes its room
// out of <main>'s box — and jsdom lays nothing out, so these read placement
// and the bounds that hold it; the painted geometry is measured in a browser.

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_VISIBLE_TOASTS, ToastLane, ToastProvider, useToast, type ToastInput } from "./toast-provider";

expect.extend(matchers);

let fire: (t: ToastInput) => void = () => {};
function Trigger() {
  fire = useToast().toast;
  return null;
}

function Frame({ withLane = true }: { withLane?: boolean }) {
  return (
    <ToastProvider>
      <Trigger />
      <div data-testid="column" className="flex flex-col">
        <main data-testid="main">content</main>
        {withLane ? <ToastLane className="mb-[56px] md:mb-0" /> : null}
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
  it("renders the toast as the next sibling of <main>, not over it", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    const lane = screen.getByTestId("toast-lane");
    expect(lane).toHaveTextContent("Saved");
    expect(screen.getByTestId("main").nextElementSibling).toBe(lane);
    expect(screen.queryByTestId("toast-corner")).not.toBeInTheDocument();
  });

  it("is in flow: the lane is not positioned over anything", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    const cls = screen.getByTestId("toast-lane").className;
    expect(cls).not.toMatch(/\b(fixed|absolute|sticky)\b/);
    expect(cls).toContain("flex-none");
  });

  it("caps its height and scrolls inside itself past the cap", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    const cls = screen.getByTestId("toast-lane").className;
    expect(cls).toContain("max-h-[35dvh]");
    expect(cls).toContain("overflow-y-auto");
  });

  it("carries the frame's clearance for the mobile tab bar", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));

    expect(screen.getByTestId("toast-lane").className).toContain("mb-[56px]");
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
});
