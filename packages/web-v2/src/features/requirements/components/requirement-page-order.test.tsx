// ISS-691 (REQ-65 BC-7): a requirement page reads its picture, then Problem, Value and Measured by as
// short properties, then its criteria as short rows on the same page, not a tab of their own; and the
// picture lights the steps each criterion touches for every kind, a rule, screen or report keeping
// its own picture beneath the lit workflow.
//
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-detail.tsx
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-overview.tsx
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-goal.tsx
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-criteria.tsx
// @direct-test-of packages/web-v2/src/features/requirements/components/requirement-picture.tsx

import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD, CHART, CHECKOUT_LINK, core, detail, page, TABLE } from "@/test/requirement-pictures";
import { reqDetail } from "@/test/vi-chrome-requirements";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/projects/hop/requirements/REQ-1", useParams: () => ({ slug: "hop" }) }));

// React Flow cannot lay a canvas out in jsdom; what the page hands the canvas is the claim here
type CanvasHighlight = { steps: ReadonlySet<string>; edges: ReadonlySet<string> };
const canvases = vi.hoisted(() => [] as { flow: string; highlight: CanvasHighlight | null | undefined }[]);
vi.mock("@/features/workflows/canvas/workflow-canvas", () => ({
  WorkflowCanvas: (p: { doc: { flow: string }; highlight?: CanvasHighlight | null }) => {
    canvases.push({ flow: p.doc.flow, highlight: p.highlight });
    return <div data-testid="canvas-stub" />;
  },
}));
vi.mock("@/features/board/board-canvas", () => ({
  default: ({ doc }: { doc: { shapes: unknown[] } }) => <div data-testid="board-stub">{doc.shapes.length} shapes</div>,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  canvases.length = 0;
});

const GOAL = "Problem: buyers leave at a slow checkout.\nValue: a buyer pays in one step.\nMeasured by: checkouts finished per day.\nRoadmap: Now";
const spec = { ...reqDetail.revisions.find((r) => r.state === "current")?.spec, goal: GOAL };
const PAY = { code: "BC-1", workflowId: "w1", flow: "checkout", steps: ["pay"], edges: [] };
const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const lastLit = () => [...(canvases.at(-1)?.highlight?.steps ?? [])];

describe("a requirement page, top to bottom", () => {
  it("opens on its picture, then Problem, Value and Measured by as properties, then the criteria as rows, with no criteria tab", async () => {
    core("viewer");
    page(detail({ kind: "process", spec, writtenLang: "en" }, { workflows: [CHECKOUT_LINK], traces: [PAY] }));
    const picture = await screen.findByTestId("requirement-picture");
    const overview = screen.getByTestId("view-overview");
    const goal = within(overview).getByTestId("requirement-goal");
    const criteria = within(overview).getByTestId("view-criteria");
    expect(follows(picture, goal)).toBe(true);
    expect(follows(goal, criteria)).toBe(true);
    expect(overview.firstElementChild?.contains(goal)).toBe(true);
    expect(within(goal).getAllByRole("term").map((x) => x.textContent)).toEqual(["Problem", "Value", "Measured by"]);
    expect(within(goal).getByTestId("goal-problem").querySelector("[title]")).toHaveClass("truncate");
    expect(within(goal).getAllByRole("definition").map((x) => x.textContent)).toEqual([
      "buyers leave at a slow checkout.",
      "a buyer pays in one step.",
      "checkouts finished per day.",
    ]);
    const rows = within(criteria).getAllByTestId("criterion-row");
    expect(rows).toHaveLength(reqDetail.standing.coverage.length);
    // the owner's face (2026-11-02): one short line a row, its code a tooltip, its detail behind the expand
    rows.forEach((r, i) => {
      const line = within(r).getByTestId("criterion-line");
      expect(line).toHaveAttribute("title", reqDetail.standing.coverage[i]?.code);
      expect(line.textContent).not.toContain("\n");
      expect(within(r).getByTestId("criterion-detail")).not.toHaveAttribute("open");
    });
    expect(within(criteria).queryByTestId("criterion-code")).toBeNull();
    expect(within(screen.getByTestId("requirement-tabs")).queryByRole("tab", { name: /Criteria/ })).toBeNull();
    expect(await screen.findByRole("figure", { name: "The Checkout workflow, with the steps its criteria trace lit: Pay." })).toBeInTheDocument();
    expect(lastLit()).toEqual(["pay"]);
  });

  it("names a label the goal leaves out as not stated, and reads an unlabelled goal as its problem", async () => {
    core("viewer");
    page(detail({ kind: "rule", spec: { ...spec, goal: "Buyers leave at a slow checkout." }, writtenLang: "en" }));
    const goal = await screen.findByTestId("requirement-goal");
    expect(within(goal).getAllByRole("definition").map((x) => x.textContent)).toEqual(["Buyers leave at a slow checkout.", "Not stated", "Not stated"]);
  });
});

describe("the picture lights the steps each criterion touches, for every kind", () => {
  for (const [kind, own, alt] of [
    ["rule", TABLE, TABLE.alt],
    ["screen", BOARD, BOARD.alt],
    ["report", CHART, CHART.alt],
  ] as const) {
    it(`lights them for a ${kind}, its own picture kept beneath`, async () => {
      core("viewer");
      page(detail({ kind, picture: own, spec, writtenLang: "en" }, { workflows: [CHECKOUT_LINK], traces: [PAY] }));
      const lit = await screen.findByRole("figure", { name: "The Checkout workflow, with the steps its criteria trace lit: Pay." });
      const mine = await screen.findByRole("figure", { name: alt });
      expect(follows(lit, mine)).toBe(true);
      expect(canvases.at(-1)?.flow).toBe("checkout");
      expect(lastLit()).toEqual(["pay"]);
    });
  }

  it("lights them where no kind is named, adding no empty slot beneath", async () => {
    core("viewer");
    page(detail({ spec, writtenLang: "en" }, { workflows: [CHECKOUT_LINK], traces: [PAY] }));
    await screen.findByRole("figure", { name: "The Checkout workflow, with the steps its criteria trace lit: Pay." });
    expect(lastLit()).toEqual(["pay"]);
    expect(screen.queryByTestId("picture-empty")).toBeNull();
  });
});
