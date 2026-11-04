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
 * @direct-test-of packages/web-v2/src/features/workflows/components/workflow-design-facts.tsx
 */
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

vi.mock("../hooks", async (importOriginal) => {
  const q = (data: unknown) => ({ data, isLoading: false, error: null });
  return {
    ...(await importOriginal<typeof import("../hooks")>()),
    useWorkflows: () => q({ workflows: [record], returned: 1, canWrite: false }),
    useWorkflowTemplates: () => q({ templates: [] }),
    useWorkflowDesign: () => q(shown),
    useWorkflowHealth: () => q(undefined),
    useDesignDecision: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  };
});

const open = (d: WorkflowDesign) => {
  shown = d;
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
