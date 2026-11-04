/**
 * @direct-test-of packages/web-v2/src/features/workflows/components/workflow-design-screen.tsx
 * @direct-test-of packages/web-v2/src/features/workflows/components/design-banner.tsx
 *
 * REQ-68 BC-5 (ISS-687 c1): the workflow page shows the step its design is at, who it waits on and
 * what is next, read off core's design standing (`workflows/standing-read.ts` reads the same wait),
 * never derived here; a design nobody owes a step on names no one.
 * ISS-687 c2, judged short at dev.485: Issue lifecycle and Forge in context, both approved, said
 * neither who the design waits on nor what is next, though core said Nobody. Where it stands now
 * carries that one line for every design, "Nobody · nothing next" where nobody owes a step. Planted
 * red by leaving `WaitsOnMark` out of the panel.
 * ISS-687 round 4, judged short at dev.489: Issue lifecycle read "Waits on: Nobody · nothing next"
 * beside "Needs you 2" and "Approve 4 pin-only changes". An approved design's line is what core says
 * it still owes a person, in the words Needs you lists it by (`@forge/contracts/design-owed`); the step
 * stays the header's pill, said once (REQ-43 BC-5). Planted red by core's round-2 line ("Nobody").
 * @direct-test-of packages/web-v2/src/features/workflows/components/workflow-where-it-stands.tsx
 * @direct-test-of packages/web-v2/src/features/workflows/components/workflow-design-facts.tsx
 */
import { repinOwedWait, settleOwedWait } from "@forge/contracts/design-owed";
import { verbatim } from "@forge/contracts/said";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RULE, say, waitingOn } from "@/test/said";
import type { WorkflowDesign, WorkflowRecord } from "../types";
import { WorkflowDesignScreen } from "./workflow-design-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());
vi.mock("@/features/comments", () => ({ useEntityDecisions: () => ({ data: undefined }) }));

const AT = "2026-10-07T10:00:00.000Z";
const body = { version: 2, project: "p-1", flow: "intake", kind: "flow", title: "Clinic intake", summary: "", template: { id: "operational-flow", version: 1 }, steps: [], edges: [] };
const record = { workflowId: "w-1", writerName: "Ana", document: { ...body, id: "w-1", createdAt: AT, updatedAt: AT }, revision: 2 } as unknown as WorkflowRecord;
const designAt = (status: WorkflowDesign["status"], wait: WorkflowDesign["waitingOn"]) =>
  ({
    workflowId: "w-1",
    flow: "intake",
    status,
    revision: 2,
    proposedRevision: status === "proposed" ? 2 : null,
    approvedRevision: status === "approved" ? 2 : null,
    approver: "workflow-designs.approve",
    canDecide: false,
    canWrite: false,
    canDraftRequirement: false,
    waitingOn: wait,
    revisions: [],
    builds: [],
    gate: { open: false, rule: "held", says: { rule: verbatim("held") } },
    requirements: [],
    matchingRequirement: null,
    approvalBlocked: null,
    approvalLeavesStale: [],
    pinOnly: null,
  }) as unknown as WorkflowDesign;

let shown: WorkflowDesign;
let health: unknown;

vi.mock("../hooks", async (importOriginal) => {
  const q = (data: unknown) => ({ data, isLoading: false, error: null });
  return {
    ...(await importOriginal<typeof import("../hooks")>()),
    useWorkflows: () => q({ workflows: [record], returned: 1, canWrite: false }),
    useWorkflowTemplates: () => q({ templates: [] }),
    useWorkflowDesign: () => q(shown),
    useWorkflowHealth: () => q(health),
    useDesignDecision: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  };
});

const open = (d: WorkflowDesign, h: unknown = undefined) => {
  shown = d;
  health = h;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkflowDesignScreen projectId="p-1" slug="acme" flow="intake" />
    </QueryClientProvider>,
  );
};

describe("the workflow page says where its design stands (REQ-68 BC-5)", () => {
  it("shows the step, who it waits on and what is next for a proposed design", () => {
    open(
      designAt(
        "proposed",
        waitingOn("person", { who: say("standing.who.holderOf", { perm: "workflow-designs.approve" }), act: say("designs.act.approveOrReturn"), rule: RULE }),
      ),
    );
    const page = screen.getByTestId("workflow-design-screen");
    expect(page).toHaveTextContent("Awaiting approval");
    expect(screen.getByTestId("design-banner-line")).toHaveTextContent("Waiting on Design approver: approve or return the design");
  });

  it("names the author's revise as what is next for a returned design", () => {
    open(designAt("returned", waitingOn("person", { who: say("standing.who.named", { name: "Ana" }), act: say("designs.act.reviseR", { r: 2 }), rule: RULE })));
    expect(screen.getByTestId("workflow-design-screen")).toHaveTextContent("Returned");
    expect(screen.getByTestId("design-banner-line")).toHaveTextContent("Waiting on Ana: revise revision 2");
  });

  it("names no one for an approved design, which owes nobody a step", () => {
    open(designAt("approved", waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE })));
    expect(screen.getByTestId("workflow-design-screen")).toHaveTextContent("Approved");
    expect(screen.queryByTestId("design-banner")).toBeNull();
  });
});

describe("the workflow page's Where it stands says who the design waits on and what is next (ISS-687 c2)", () => {
  const line = () => screen.getByTestId("stands-waits-on");

  it("says Nobody and that nothing is next on an approved design", () => {
    open(designAt("approved", waitingOn("none", { who: say("standing.who.nobody"), act: say("standing.act.none"), rule: RULE })));
    expect(line()).toHaveTextContent("Waits on");
    expect(line()).toHaveTextContent("Nobody · nothing next");
  });

  it("names the approver and the act on a proposed design", () => {
    open(
      designAt(
        "proposed",
        waitingOn("person", { who: say("standing.who.holderOf", { perm: "workflow-designs.approve" }), act: say("designs.act.approveOrReturn"), rule: RULE }),
      ),
    );
    expect(line()).toHaveTextContent("Design approver · approve or return the design");
  });

  it("names the writer and the revise on a returned design, in a few words", () => {
    open(designAt("returned", waitingOn("person", { who: say("standing.who.named", { name: "Ana" }), act: say("designs.act.reviseR", { r: 2 }), rule: RULE })));
    expect(line()).toHaveTextContent("Ana · revise revision 2");
    expect((line().textContent ?? "").split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(10);
  });
});

describe("the workflow page's line agrees with what Needs you counts on the design (ISS-687 round 4)", () => {
  const line = () => screen.getByTestId("stands-waits-on");

  it("says the places to decide on an approved design, beside the same count, its step in the header", () => {
    open(designAt("approved", settleOwedWait(2, "intake")), { needsYou: 2, markers: [], nodes: [], counts: {}, rooted: { rooted: false, missing: [] }, observation: null, reconciliation: { state: "unreconciled" } });
    // the step is the header's pill, said once on the page (REQ-43 BC-5)
    expect(screen.getAllByTestId("design-pill")[0]).toHaveTextContent("Approved");
    expect(screen.queryByTestId("stands-step")).toBeNull();
    expect(line()).toHaveTextContent("A person · decide 2 places where the code and the design differ");
    expect(line()).not.toHaveTextContent("Nobody");
    expect(screen.getByTestId("stands-needs-you")).toHaveTextContent("2");
  });

  it("says the pin-only changes to approve on an approved design they follow", () => {
    open(designAt("approved", repinOwedWait({ flow: "intake", revision: 2, n: 4 }, true)));
    expect(line()).toHaveTextContent("You · approve 4 pin-only changes → r2");
  });
});
