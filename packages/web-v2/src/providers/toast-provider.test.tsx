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


// ISS-1236 r9, judge-149: at 390 the refused-repository toast stood over the path field it told the
// person to correct (32 of 349 px left to tap) for its whole reading time, and over its right half at
// 1280. A toast naming that field takes the lane to an edge that leaves it clear.
describe("a toast naming the element it keeps clear of", () => {
  const wide = (matches: boolean) => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({ matches, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
    });
  };
  const viewport = (width: number, height: number) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
  };
  /** Each element's box by what it is: the lane, the dialog's panel, the field, or nothing. */
  const boxes = (by: Record<string, Partial<DOMRect>>) =>
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const key = this.dataset.testid ?? (this.getAttribute("role") === "dialog" ? "dialog" : this.tagName.toLowerCase());
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...by[key] } as DOMRect;
    });
  let field: HTMLInputElement | null = null;
  function Dialog() {
    return (
      <SlideOver open onClose={() => {}} title="Set up pipeline">
        <input
          data-testid="path"
          ref={(el) => {
            field = el;
          }}
        />
      </SlideOver>
    );
  }
  const refused = { title: "Project created; its repository settings were not saved", tone: "error" as const };
  const original = { width: window.innerWidth, height: window.innerHeight };
  afterEach(() => {
    Reflect.deleteProperty(window, "matchMedia");
    viewport(original.width, original.height);
  });

  it("goes to the bottom edge on a phone when the top would stand over the field, with no tab bar under a dialog", () => {
    wide(false);
    viewport(390, 844);
    const spy = boxes({
      "toast-lane": { top: 61, bottom: 361, height: 300, width: 390, left: 0, right: 390 },
      path: { top: 241, bottom: 283, left: 21, right: 370 },
      dialog: { left: 0, right: 390 },
      header: { bottom: 61 },
    });
    try {
      render(
        <ToastProvider>
          <Trigger />
          <Dialog />
          <ToastLane />
        </ToastProvider>,
      );
      act(() => fire({ ...refused, duration: 0, clearOf: () => field }));
      const lane = screen.getByTestId("toast-lane");
      expect(lane.style.top).toBe("auto");
      expect(lane.style.bottom).toBe("0px");
    } finally {
      spy.mockRestore();
    }
  });

  it("goes beside the dialog on a wide screen, its right edge at the dialog's left", () => {
    wide(true);
    viewport(1280, 900);
    const spy = boxes({
      "toast-lane": { top: 56, bottom: 336, height: 280, width: 360, left: 920, right: 1280 },
      path: { top: 221, bottom: 259, left: 841, right: 1260 },
      dialog: { left: 820, right: 1280 },
    });
    try {
      render(
        <ToastProvider>
          <Trigger />
          <Dialog />
          <ToastLane />
        </ToastProvider>,
      );
      act(() => fire({ ...refused, duration: 0, clearOf: () => field }));
      const lane = screen.getByTestId("toast-lane");
      expect(lane.style.right).toBe("460px");
      expect(lane.style.bottom).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  // r9 plan consult F1: in a viewport too short for either edge, neither edge leaves the field clear.
  it("takes the larger space beside the field, capped to it, where neither edge leaves it clear", () => {
    wide(false);
    viewport(390, 240);
    const spy = boxes({
      "toast-lane": { top: 61, bottom: 145, height: 84, width: 390, left: 0, right: 390 },
      path: { top: 135, bottom: 177, left: 21, right: 370 },
      header: { bottom: 61 },
    });
    try {
      render(
        <ToastProvider>
          <Trigger />
          <Dialog />
          <ToastLane />
        </ToastProvider>,
      );
      act(() => fire({ ...refused, duration: 0, clearOf: () => field }));
      const lane = screen.getByTestId("toast-lane");
      // Above the field: 61 to 135 is 74 px; below it: 177 to 240 is 63 px.
      expect(lane.style.top).toBe("61px");
      expect(lane.style.maxHeight).toBe("74px");
      // r9 review F1 (second read): the cap is the whole box, padding included, so a gap smaller than
      // the lane's padding is not overrun by it.
      expect(lane.style.paddingTop).toBe("0px");
      expect(lane.style.paddingBottom).toBe("0px");
      const top = Number.parseFloat(lane.style.top);
      expect(top + Number.parseFloat(lane.style.maxHeight)).toBeLessThanOrEqual(135);

      // r9 review F1: the capped lane now measures 74 px, its toasts still 84 px tall inside it. A
      // later scroll must not read the cap back as the lane's height and lift it.
      spy.mockImplementation(function (this: HTMLElement) {
        const by: Record<string, Partial<DOMRect>> = {
          "toast-lane": { top: 61, bottom: 135, height: 74, width: 390, left: 0, right: 390 },
          path: { top: 135, bottom: 177, left: 21, right: 370 },
          header: { bottom: 61 },
        };
        const key = this.dataset.testid ?? this.tagName.toLowerCase();
        return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, ...by[key] } as DOMRect;
      });
      const tall = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(84);
      try {
        act(() => {
          window.dispatchEvent(new Event("scroll"));
        });
        expect(lane.style.top).toBe("61px");
        expect(lane.style.maxHeight).toBe("74px");
      } finally {
        tall.mockRestore();
      }
    } finally {
      spy.mockRestore();
    }
  });

  // r9 review F2: a phone's bottom safe-area lifts the bottom edge; the check that clears the field
  // must lift it the same, or the lane it places covers the field.
  it("counts the bottom safe-area in the place it checks, as in the place it sets", () => {
    wide(false);
    viewport(390, 300);
    const spy = boxes({
      "toast-lane": { top: 61, bottom: 166, height: 105, width: 390, left: 0, right: 390 },
      path: { top: 140, bottom: 190, left: 21, right: 370 },
      header: { bottom: 61 },
    });
    const real = window.getComputedStyle;
    const styled = vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, pseudo?: string | null) => {
      const style = real(el, pseudo);
      if ((el as HTMLElement).style?.visibility !== "hidden") return style;
      return { ...style, paddingTop: "0px", paddingBottom: "34px" } as CSSStyleDeclaration;
    });
    try {
      render(
        <ToastProvider>
          <Trigger />
          <Dialog />
          <ToastLane />
        </ToastProvider>,
      );
      act(() => fire({ ...refused, duration: 0, clearOf: () => field }));
      const lane = screen.getByTestId("toast-lane");
      // At the bottom it would span 161 to 266 over a field at 140 to 190: above it, 61 to 140, is larger.
      expect(lane.style.bottom).toBe("");
      expect(lane.style.top).toBe("61px");
      expect(Number.parseFloat(lane.style.top) + Number.parseFloat(lane.style.maxHeight)).toBeLessThanOrEqual(140);
    } finally {
      styled.mockRestore();
      spy.mockRestore();
    }
  });

  it("stays at the top where the top leaves the field clear, and when no toast names one", () => {
    wide(false);
    viewport(390, 844);
    const spy = boxes({
      "toast-lane": { top: 61, bottom: 161, height: 100, width: 390, left: 0, right: 390 },
      path: { top: 241, bottom: 283, left: 21, right: 370 },
      header: { bottom: 61 },
    });
    try {
      render(
        <ToastProvider>
          <Trigger />
          <Dialog />
          <ToastLane />
        </ToastProvider>,
      );
      act(() => fire({ ...refused, duration: 0, clearOf: () => field }));
      expect(screen.getByTestId("toast-lane")).toHaveStyle({ top: "61px" });
      expect(screen.getByTestId("toast-lane").style.bottom).toBe("");
    } finally {
      spy.mockRestore();
    }
  });

  it("comes back to the top once the toast naming the field is gone", () => {
    wide(false);
    viewport(390, 844);
    const spy = boxes({
      "toast-lane": { top: 61, bottom: 361, height: 300, width: 390, left: 0, right: 390 },
      path: { top: 241, bottom: 283, left: 21, right: 370 },
      header: { bottom: 61 },
    });
    try {
      render(
        <ToastProvider>
          <Trigger />
          <Dialog />
          <ToastLane />
        </ToastProvider>,
      );
      act(() => {
        fire({ title: "Project created", duration: 0 });
        fire({ ...refused, duration: 0, slot: "refused", clearOf: () => field });
      });
      expect(screen.getByTestId("toast-lane").style.top).toBe("auto");
      act(() => dismiss("refused"));
      expect(screen.getByTestId("toast-lane")).toHaveStyle({ top: "61px" });
      expect(screen.getByTestId("toast-lane").style.bottom).toBe("");
    } finally {
      spy.mockRestore();
    }
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

// ISS-1236 r8, judge-147: a 50-word error toast was gone in 4 seconds, and resting the pointer on it
// did not hold it.
describe("a toast is given the time it takes to read", () => {
  const card = (title: string) => screen.getByText(title).closest('[role="status"]') as HTMLElement;
  const LONG =
    "repoPath must be an absolute path on the device (it starts with /), not ~/code/app — a relative path names a different directory on every box. Correct the path here and save again, or set it later in the project's Settings, on Shape & release, under Repository.";

  it("holds while the pointer rests on it, and resumes with what was left", () => {
    render(<Frame />);
    act(() => fire({ title: "Held", duration: 4000 }));
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.mouseEnter(card("Held"));
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("Held")).toBeInTheDocument();

    fireEvent.mouseLeave(card("Held"));
    act(() => vi.advanceTimersByTime(999));
    expect(screen.getByText("Held")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Held")).not.toBeInTheDocument();
  });

  it("holds while focus is inside it", () => {
    render(<Frame />);
    act(() => fire({ title: "Focused", duration: 4000 }));
    act(() => within(card("Focused")).getByRole("button", { name: "Dismiss" }).focus());
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByText("Focused")).toBeInTheDocument();
  });

  it("keeps a long error toast past 4 seconds, and still lets it go once read", () => {
    render(<Frame />);
    act(() => fire({ title: "Project created; its repository settings were not saved", description: LONG, tone: "error" }));
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.getByText(LONG)).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.queryByText(LONG)).not.toBeInTheDocument();
  });

  it("lets a short toast go at 4 seconds, as before", () => {
    render(<Frame />);
    act(() => fire({ title: "Saved" }));
    act(() => vi.advanceTimersByTime(3999));
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});

// ISS-1236 r8: a toast that names a place carries it as a link, so the reader lands where it says.
describe("a toast carrying a link", () => {
  it("renders the link to where it names, and following it puts the toast away", () => {
    render(<Frame />);
    act(() =>
      fire({
        title: "Not saved",
        tone: "error",
        link: { label: "Open Shape & release", href: "/projects/desk/settings?tab=shape#repository" },
      }),
    );
    const link = screen.getByRole("link", { name: "Open Shape & release" });
    expect(link).toHaveAttribute("href", "/projects/desk/settings?tab=shape#repository");
    fireEvent.click(link);
    expect(screen.queryByText("Not saved")).not.toBeInTheDocument();
  });
});

// ISS-1236 r8 review: a toast that leaves by its slot, by dismiss or by the visible limit takes its
// countdown with it, held or not.
describe("a toast that leaves by any route", () => {
  it("takes its countdown with it when its slot is dismissed", () => {
    render(<Frame />);
    const before = vi.getTimerCount();
    act(() => fire({ title: "Slotted", slot: "s", duration: 4000 }));
    expect(vi.getTimerCount()).toBe(before + 1);
    act(() => dismiss("s"));
    expect(vi.getTimerCount()).toBe(before);
  });

  it("takes its countdown with it when it gives up its place to newer toasts", () => {
    render(<Frame />);
    const before = vi.getTimerCount();
    act(() => {
      for (const n of [1, 2, 3, 4]) fire({ title: `Toast ${n}`, duration: 4000 });
    });
    expect(screen.queryByText("Toast 1")).not.toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(before + MAX_VISIBLE_TOASTS);
  });
});

describe("a clickable toast carrying a link", () => {
  it("leaves Enter on the link to the link, never the card's own action", () => {
    const open = vi.fn();
    render(<Frame />);
    act(() => fire({ title: "Resolved", onClick: open, duration: 0, link: { label: "Elsewhere", href: "/x" } }));
    const link = screen.getByRole("link", { name: "Elsewhere" });
    link.focus();
    const event = fireEvent.keyDown(link, { key: "Enter" });
    expect(open).not.toHaveBeenCalled();
    expect(event).toBe(true);
  });
});
