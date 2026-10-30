// ISS-781 part 1 on the workflows list (REQ-10 BC-12..BC-14, REQ-43 BC-5): a first-time reader
// reads the designs in the order they build on each other, sees each one's requirement, is told once
// whether they owe anything, and reads a state every design shares once rather than on each row.
//
// @direct-test-of packages/web-v2/src/features/workflows/components/workflows-screen.tsx
// @direct-test-of packages/web-v2/src/features/workflows/components/system-overview.tsx
// @direct-test-of packages/web-v2/src/features/workflows/catalogue.ts

import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { RULE, say, waitingOn } from "@/test/said";
import { readingOrder } from "../catalogue";
import type { WorkflowRecord } from "../types";
import { WorkflowsScreen } from "./workflows-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const AT = "2026-10-29T10:00:00.000Z";
const draftWait = waitingOn("agent", { who: say("standing.who.named", { name: "orchestrator" }), act: say("designs.act.finish"), rule: RULE });
const youWait = waitingOn("you", { who: say("standing.who.you"), act: say("designs.act.approveOrReturn"), rule: RULE });

interface Over {
  basedOn?: string[];
  refs?: string[];
  requirements?: string[];
  status?: "draft" | "proposed" | "approved";
  wait?: WorkflowRecord["design"]["waitingOn"];
}

const design = (flow: string, title: string, o: Over = {}): WorkflowRecord =>
  ({
    workflowId: `w-${flow}`,
    revision: 1,
    writer: "u-o",
    writerName: "orchestrator",
    requirements: o.requirements ?? [],
    design: { status: o.status ?? "draft", shown: o.status ?? "draft", approvedRevision: null, pendingRevision: null, waitingOn: o.wait ?? draftWait },
    document: {
      id: `w-${flow}`,
      version: 2,
      project: "p-1",
      flow,
      kind: "flow",
      title,
      summary: "",
      template: { id: "operational-flow", version: 1 },
      steps: [{ id: "s1", does: "starts", after: [], node: { type: "EVENT", refs: (o.refs ?? []).map((f) => ({ template: "operational-flow", flow: f, step: "s1" })) } }],
      ...(o.basedOn ? { basedOn: o.basedOn.map((w) => ({ workflow: w, revision: 1 })) } : {}),
      writtenBy: {},
      createdAt: AT,
      updatedAt: AT,
    },
    health: { counts: { outdated: 0, needs_update: 0, has_problem: 0, remove_proposed: 0, upcoming: 0, not_in_design: 0, wrong: 0 }, needsYou: 0, workflowLevelOnly: false },
  }) as unknown as WorkflowRecord;

// agenfold's four, as the owner met them: alphabetical put governed-actions first although it builds on the other three
const AGENFOLD = [
  design("governed-actions", "Governed business action and approval loop", { basedOn: ["workspace-onboarding", "strategy-planning"], refs: ["operator-lifecycle"] }),
  design("operator-lifecycle", "Operator lifecycle and safe replication", { basedOn: ["workspace-onboarding"] }),
  design("strategy-planning", "Strategy planning, durable execution and outcome review", { refs: ["operator-lifecycle"], requirements: ["REQ-4"] }),
  design("workspace-onboarding", "Workspace onboarding and resource grants", { requirements: ["REQ-2", "REQ-3"] }),
];

function screenWith(records: WorkflowRecord[]) {
  fakeCore((call) => {
    if (call.path === "/projects/p-1/workflows") return { body: { workflows: records, returned: records.length } };
    if (call.path === "/projects/p-1/workflow-templates") return { body: { templates: [], returned: 0 } };
    if (call.path.startsWith("/projects/p-1/config")) return { body: { declared: false } };
    return undefined;
  });
  renderWithQuery(<WorkflowsScreen projectId="p-1" slug="agenfold" projectName="Agenfold" />);
}

const rowTitles = () => within(screen.getByTestId("workflow-list")).getAllByTestId("workflow-row").map((r) => r.querySelector("[title]")?.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("the order a first-time reader reads the designs in (C1)", () => {
  it("puts each design after every design it builds on, by bases and step references, ties by title", () => {
    expect(readingOrder(AGENFOLD).map((r) => r.document.flow)).toEqual(["workspace-onboarding", "operator-lifecycle", "strategy-planning", "governed-actions"]);
  });

  it("orders designs that build on nothing by title, and a ring after the rest", () => {
    const ring = [design("b", "Bravo", { basedOn: ["a"] }), design("a", "Alpha", { basedOn: ["b"] }), design("z", "Zulu"), design("c", "Charlie")];
    expect(readingOrder(ring).map((r) => r.document.flow)).toEqual(["c", "z", "a", "b"]);
  });

  it("ignores a base the list does not hold and a design naming itself", () => {
    const loose = [design("b", "Bravo", { basedOn: ["gone", "b"] }), design("a", "Alpha")];
    expect(readingOrder(loose).map((r) => r.document.flow)).toEqual(["a", "b"]);
  });

  it("draws the list in that order, one list with no purpose group repeating the count", async () => {
    screenWith(AGENFOLD);
    await screen.findAllByTestId("workflow-row");
    expect(rowTitles()).toEqual([
      "Workspace onboarding and resource grants",
      "Operator lifecycle and safe replication",
      "Strategy planning, durable execution and outcome review",
      "Governed business action and approval loop",
    ]);
    expect(screen.queryByTestId("workflow-group")).toBeNull();
    expect(within(screen.getByTestId("designs")).getAllByText("4"), "the design count is said more than once").toHaveLength(1);
  });
});

describe("each design's requirement (C2)", () => {
  it("names the linked keys on the row, or None", async () => {
    screenWith(AGENFOLD);
    await screen.findAllByTestId("workflow-row");
    expect(screen.getAllByTestId("workflow-requirements").map((c) => c.textContent)).toEqual(["REQ-2 · REQ-3", "None", "REQ-4", "None"]);
  });
});

describe("what the viewer owes, said once (C3)", () => {
  it("says None when no design waits on the viewer, and shows no No context line", async () => {
    screenWith(AGENFOLD);
    await screen.findAllByTestId("workflow-row");
    const owes = screen.getByTestId("workflows-needs-you");
    expect(owes).toHaveTextContent("Needs youNone");
    expect(screen.queryByTestId("system-overview")).toBeNull();
    expect(screen.queryByText("No context")).toBeNull();
    expect(screen.getAllByTestId("workflows-needs-you")).toHaveLength(1);
  });

  it("counts the designs waiting on the viewer", async () => {
    screenWith([design("a", "Alpha", { status: "proposed", wait: youWait }), design("b", "Bravo", { status: "proposed", wait: youWait }), design("c", "Charlie")]);
    await screen.findAllByTestId("workflow-row");
    expect(screen.getByTestId("workflows-needs-you")).toHaveAttribute("data-count", "2");
    expect(screen.getByTestId("workflows-needs-you")).toHaveTextContent("Needs you2");
  });
});

describe("a state every design shares, said once (C4)", () => {
  it("draws the shared status and waiting-on once above the list and on no row", async () => {
    screenWith(AGENFOLD);
    await screen.findAllByTestId("workflow-row");
    const shared = screen.getByTestId("workflows-shared");
    expect(within(shared).getAllByTestId("design-pill")).toHaveLength(1);
    expect(within(shared).getByTestId("waiting-on")).toHaveTextContent("orchestrator · finish and propose it");
    const list = screen.getByTestId("workflow-list");
    expect(within(list).queryAllByTestId("design-pill")).toHaveLength(0);
    expect(within(list).queryAllByTestId("waiting-on")).toHaveLength(0);
  });

  it("keeps each row's own state where the designs differ", async () => {
    screenWith([design("a", "Alpha", { status: "proposed", wait: youWait }), design("b", "Bravo")]);
    await screen.findAllByTestId("workflow-row");
    expect(screen.queryByTestId("workflows-shared")).toBeNull();
    expect(within(screen.getByTestId("workflow-list")).getAllByTestId("design-pill")).toHaveLength(2);
    expect(within(screen.getByTestId("workflow-list")).getAllByTestId("waiting-on")).toHaveLength(2);
  });

  it("names the waiting filter's every-design choice All", async () => {
    screenWith(AGENFOLD);
    await screen.findAllByTestId("workflow-row");
    const filter = screen.getByTestId("waiting-filter");
    expect(within(filter).getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(within(filter).queryByRole("button", { name: "Anyone" })).toBeNull();
  });
});
