// The design page gives its canvas the room (owner request 2026-10-08): focus mode lifts the canvas
// over the whole page by its toolbar control or F and leaves by F or Esc, keeping a bare #canvas
// anchor; the decision banner is one line whose detail folds and is remembered per viewer; the facts
// rail folds away from the canvas's edge; and a banner whose detail would leave the canvas under 60%
// of the viewport compacts on its own.

import { verbatim } from "@forge/contracts/said";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RULE, say, waitingOn } from "@/test/said";
import type { DesignRevision, WorkflowDesign, WorkflowRecord } from "../types";
import { CANVAS_SHARE, detailSqueezes } from "./design-room";
import { WorkflowDesignPage } from "./workflow-design-page";

const AT = "2026-10-07T10:00:00.000Z";
const LONG = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: the consent owner is not named on the redemption step, and the SLA is unset.`).join("\n");

const body = {
  version: 2,
  project: "p-1",
  flow: "roomy-flow",
  kind: "flow",
  title: "Roomy flow",
  summary: "",
  template: { id: "operational-flow", version: 1 },
  steps: [
    { id: "intake", does: "Intake takes the case.", after: [] },
    { id: "decide", does: "A person decides.", after: ["intake"] },
  ],
  edges: [],
};

const rev = (over: Partial<DesignRevision>): DesignRevision =>
  ({
    revision: 2,
    document: body,
    proposedBy: "u-1",
    proposedByName: "Ana",
    proposedAt: AT,
    decision: null,
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    reason: null,
    says: { reason: over.reason ? verbatim(over.reason) : null },
    state: "proposed",
    changes: null,
    ...over,
  }) as DesignRevision;

const returned = (): WorkflowDesign =>
  ({
    workflowId: "w-1",
    flow: "roomy-flow",
    status: "returned",
    revision: 2,
    proposedRevision: null,
    approvedRevision: 1,
    approver: "workflow-designs.approve",
    canDecide: false,
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.approveDesign", { what: "Roomy flow" }), rule: RULE }),
    revisions: [rev({ decision: "return", decidedBy: "u-2", decidedByName: "Bo", decidedAt: AT, reason: LONG, state: "returned" }), rev({ revision: 1, decision: "approve", state: "current" })],
    builds: [],
    gate: { open: false, rule: "held", says: { rule: verbatim("held") } },
    requirements: [],
  }) as unknown as WorkflowDesign;

const record = { document: { ...body, id: "w-1", createdAt: AT, updatedAt: AT }, revision: 1 } as unknown as WorkflowRecord;

const page = (tab: "design" | "steps" = "design") => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <WorkflowDesignPage projectId="p-1" slug="acme" d={returned()} record={record} template={null} tab={tab} onTab={() => {}} />
  </QueryClientProvider>
);

const area = () => screen.getByTestId("design-canvas-area");
const key = (k: string, init: KeyboardEventInit = {}) => act(() => void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, ...init })));

beforeEach(() => {
  // No query reaches a network: health and the step graph stay loading
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  window.localStorage.clear();
  window.history.replaceState(null, "", "/projects/acme/workflows/roomy-flow");
});
afterEach(() => vi.restoreAllMocks());

describe("focus mode", () => {
  it("lifts the canvas over the page from its toolbar control, and keeps a bare #canvas anchor", () => {
    render(page());
    expect(area()).toHaveAttribute("data-focus", "false");
    fireEvent.click(screen.getByTestId("canvas-focus"));
    expect(area()).toHaveAttribute("data-focus", "true");
    expect(area().className).toContain("fixed");
    expect(window.location.hash).toBe("#canvas");
    expect(screen.queryByTestId("design-rail-toggle")).toBeNull();
    fireEvent.click(screen.getByTestId("canvas-focus"));
    expect(area()).toHaveAttribute("data-focus", "false");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/projects/acme/workflows/roomy-flow");
  });

  it("enters and leaves on F, leaves on Esc, and leaves Shift+F and Ctrl+F to fit and to the browser", () => {
    render(page());
    key("f");
    expect(area()).toHaveAttribute("data-focus", "true");
    key("F", { shiftKey: true });
    key("f", { ctrlKey: true });
    expect(area()).toHaveAttribute("data-focus", "true");
    key("f");
    expect(area()).toHaveAttribute("data-focus", "false");
    key("F");
    key("Escape");
    expect(area()).toHaveAttribute("data-focus", "false");
    expect(window.location.hash).toBe("");
  });

  it("ends a walk-through on the first Esc and leaves focus mode on the next", () => {
    render(page());
    key("f");
    fireEvent.click(screen.getByTestId("walk-start-bar"));
    expect(screen.getByTestId("walk-bar")).toBeInTheDocument();
    key("Escape");
    expect(screen.queryByTestId("walk-bar")).toBeNull();
    expect(area()).toHaveAttribute("data-focus", "true");
    key("Escape");
    expect(area()).toHaveAttribute("data-focus", "false");
  });

  it("opens focused from a linked or reloaded #canvas address, and follows a hand-edited anchor", () => {
    window.history.replaceState(null, "", "/projects/acme/workflows/roomy-flow#canvas");
    render(page());
    expect(area()).toHaveAttribute("data-focus", "true");
    act(() => {
      window.history.replaceState(null, "", "/projects/acme/workflows/roomy-flow");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(area()).toHaveAttribute("data-focus", "false");
  });

  it("ignores F while the reader types in the canvas search", () => {
    render(page());
    const search = screen.getByTestId("workflow-search").querySelector("input") ?? screen.getByTestId("workflow-search");
    fireEvent.keyDown(search, { key: "f" });
    act(() => void search.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true })));
    expect(area()).toHaveAttribute("data-focus", "false");
  });
});

describe("the decision banner", () => {
  it("is one line by default, its return reason folded under Show details", () => {
    render(page());
    const banner = screen.getByTestId("design-banner");
    expect(within(banner).getByTestId("design-banner-line")).toHaveTextContent("Waiting on you:");
    expect(screen.getByTestId("design-banner-detail")).not.toBeVisible();
    expect(screen.getByTestId("design-banner-more")).toHaveAttribute("aria-expanded", "false");
  });

  it("remembers the reader's open or folded choice across a reload", () => {
    const first = render(page());
    fireEvent.click(screen.getByTestId("design-banner-more"));
    expect(screen.getByTestId("design-banner-detail")).toBeVisible();
    expect(screen.getByTestId("design-banner-reason").textContent).toBe(LONG);
    expect(window.localStorage.getItem("web-v2:workflows.design-banner-open")).toBe("true");
    first.unmount();

    const second = render(page());
    expect(screen.getByTestId("design-banner-detail")).toBeVisible();
    fireEvent.click(screen.getByTestId("design-banner-more"));
    expect(window.localStorage.getItem("web-v2:workflows.design-banner-open")).toBe("false");
    second.unmount();

    render(page());
    expect(screen.getByTestId("design-banner-detail")).not.toBeVisible();
  });

  it("reads folded, and still opens, when the browser's storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    render(page());
    expect(screen.getByTestId("design-banner-detail")).not.toBeVisible();
    fireEvent.click(screen.getByTestId("design-banner-more"));
    expect(screen.getByTestId("design-banner-detail")).toBeVisible();
  });
});

describe("the facts rail", () => {
  it("folds from the canvas's edge, giving the canvas the full width, and stays folded on the next visit", () => {
    const first = render(page());
    const layout = screen.getByTestId("workflow-design-detail");
    expect(layout).toHaveAttribute("data-rail", "open");
    fireEvent.click(screen.getByTestId("design-rail-toggle"));
    expect(layout).toHaveAttribute("data-rail", "collapsed");
    expect(layout.className).not.toContain("lg:grid-cols-[minmax(0,1fr)_320px]");
    expect(screen.getByTestId("design-rail").parentElement).toHaveClass("lg:hidden");
    expect(screen.getByTestId("design-rail-toggle")).toHaveAttribute("aria-expanded", "false");
    first.unmount();

    render(page());
    expect(screen.getByTestId("workflow-design-detail")).toHaveAttribute("data-rail", "collapsed");
    fireEvent.click(screen.getByTestId("design-rail-toggle"));
    expect(screen.getByTestId("workflow-design-detail")).toHaveAttribute("data-rail", "open");
  });

  it("is always shown on a reading tab, which has no canvas to widen", () => {
    window.localStorage.setItem("web-v2:workflows.design-rail-collapsed", "true");
    render(page("steps"));
    expect(screen.getByTestId("workflow-design-detail")).toHaveAttribute("data-rail", "open");
    expect(screen.queryByTestId("design-rail-toggle")).toBeNull();
  });
});

// jsdom lays nothing out, so the page's geometry at 1280x720 is stood in for: the column under the
// 48px top bar, a one-line banner and the tabs, and the long return reason when it is in the flow.
describe("the canvas keeps its share of the viewport", () => {
  const VIEW = { width: 1280, height: 720 };
  const LINE = 37;
  const TABS = 45;
  const REASON = 300;

  function layOut() {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: VIEW.width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: VIEW.height });
    const rect = (h: number) => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: h, width: 800, height: h, toJSON: () => ({}) }) as DOMRect;
    const detailIn = () => {
      const d = document.querySelector<HTMLElement>("[data-testid=design-banner-detail]");
      return d && !d.hidden ? d : null;
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "view-design") return rect(VIEW.height - 48);
      if (this.dataset.testid === "design-banner-detail") return rect(this.hidden ? 0 : REASON);
      if (this.contains(screen.queryByTestId("design-tabs")) && this.contains(screen.queryByTestId("design-banner"))) {
        const d = detailIn();
        return rect(LINE + TABS + (d && d.dataset.float !== "true" ? REASON : 0));
      }
      return rect(0);
    });
  }
  const canvasShare = () => {
    const column = screen.getByTestId("view-design").getBoundingClientRect().height;
    const head = (screen.getByTestId("view-design").firstElementChild as HTMLElement).getBoundingClientRect().height;
    return (column - head) / VIEW.height;
  };

  it("compacts a banner the reader left open when its long return reason would push the canvas under 60%", () => {
    layOut();
    window.localStorage.setItem("web-v2:workflows.design-banner-open", "true");
    render(page());
    expect(canvasShare()).toBeGreaterThanOrEqual(CANVAS_SHARE);
    expect(screen.getByTestId("design-banner-detail")).not.toBeVisible();
    expect(screen.getByTestId("design-banner")).toHaveAttribute("data-float", "true");
  });

  it("opens the squeezed detail over the canvas when asked, never in the flow", () => {
    layOut();
    render(page());
    fireEvent.click(screen.getByTestId("design-banner-more"));
    expect(screen.getByTestId("design-banner-detail")).toBeVisible();
    expect(screen.getByTestId("design-banner-detail")).toHaveAttribute("data-float", "true");
    expect(canvasShare()).toBeGreaterThanOrEqual(CANVAS_SHARE);
  });

  it("decides on the head without the detail, so showing it never flips the answer", () => {
    const m = { viewport: VIEW, column: 672, detail: 300 };
    expect(detailSqueezes({ ...m, head: LINE + TABS, detailInFlow: false })).toBe(true);
    expect(detailSqueezes({ ...m, head: LINE + TABS + 300, detailInFlow: true })).toBe(true);
    expect(detailSqueezes({ ...m, detail: 80, head: LINE + TABS, detailInFlow: false })).toBe(false);
    expect(detailSqueezes({ ...m, detail: 80, head: LINE + TABS + 80, detailInFlow: true })).toBe(false);
    // the boundary: exactly 60% left is enough
    expect(detailSqueezes({ viewport: VIEW, column: 672, detail: 672 - 82 - 432, head: 82, detailInFlow: false })).toBe(false);
    expect(detailSqueezes({ viewport: VIEW, column: 672, detail: 672 - 82 - 431, head: 82, detailInFlow: false })).toBe(true);
    // below the wide layout the page scrolls, and nothing has been measured yet
    expect(detailSqueezes({ ...m, viewport: { width: 1023, height: 720 }, head: 82, detailInFlow: false })).toBe(false);
    expect(detailSqueezes({ ...m, detail: 0, head: 82, detailInFlow: false })).toBe(false);
  });
});
