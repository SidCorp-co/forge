// REQ-35 BC-7 and the decision on question 20c74d56 (2026-10-14, (a)), on the workflow design page: a
// proposed design awaiting this reader opens with its changes against the approved revision showing,
// so nobody approves a change they have not seen; a design awaiting someone else, or one not
// proposed, opens as it stands. "This reader" is whoever the page lets decide it (`canDecide`).
//
// @direct-test-of packages/web-v2/src/features/workflows/components/workflow-design-page.tsx

import { verbatim } from "@forge/contracts/said";
import type { WorkflowHealth } from "@forge/contracts/workflow-health";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RULE, say, waitingOn } from "@/test/said";
import type { DesignRevision, WorkflowDesign, WorkflowRecord } from "../types";
import { WorkflowDesignPage } from "./workflow-design-page";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const AT = "2026-10-07T10:00:00.000Z";
const step = (id: string, does: string, after: string[]) => ({ id, does, after });
const doc = (steps: ReturnType<typeof step>[]) => ({ version: 2, project: "p-1", flow: "record-flow", kind: "flow", title: "Record flow", summary: "", template: null, steps, edges: [] });
const approvedDoc = doc([step("intake", "Intake takes the case.", []), step("decide", "A person decides.", ["intake"])]);
const proposedDoc = doc([step("intake", "Intake takes the case.", []), step("decide", "Two people decide.", ["intake"])]);

const rev = (revision: number, document: unknown, state: string): DesignRevision =>
  ({ revision, document, proposedBy: "u-1", proposedByName: "Ana", proposedAt: AT, decision: null, decidedBy: null, decidedByName: null, decidedAt: null, reason: null, says: { reason: null }, state, changes: null }) as unknown as DesignRevision;

const design = (over: Partial<WorkflowDesign>): WorkflowDesign =>
  ({
    workflowId: "w-1",
    flow: "record-flow",
    status: "proposed",
    revision: 2,
    proposedRevision: 2,
    approvedRevision: 1,
    approver: "workflow-designs.approve",
    canDecide: true,
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.approveDesign", { what: "Record flow" }), rule: RULE }),
    revisions: [rev(2, proposedDoc, "proposed"), rev(1, approvedDoc, "current")],
    builds: [],
    gate: { open: false, rule: "held", says: { rule: "held" } },
    requirements: [],
    ...over,
  }) as unknown as WorkflowDesign;

const record = { workflowId: "w-1", writerName: "Ana", document: { ...approvedDoc, id: "w-1", createdAt: AT, updatedAt: AT }, revision: 1 } as unknown as WorkflowRecord;

/** Core's health read for the design: no markers, and the proposed revision's diff against the approved one. */
const health = {
  workflowId: "w-1",
  flow: "record-flow",
  revision: 2,
  approvedRevision: 1,
  proposedRevision: 2,
  proposal: null,
  rooted: { rooted: true, approvedRevision: 1, requirements: [], missing: [] },
  observation: null,
  markers: [],
  counts: { outdated: 0, needs_update: 0, has_problem: 0, remove_proposed: 0, upcoming: 0, not_in_design: 0, wrong: 0 },
  nodes: [],
  workflowLevel: [],
  needsYou: 0,
  orphanedTraces: [],
  diff: { from: 1, to: 2, steps: { decide: "changed" }, edges: {} },
  observed: null,
  reconciliation: { state: "reconciled", undecided: 0, cleaning: 0, issues: [], version: null, criteria: { total: 0, proven: 0 }, rule: "matches", says: { rule: verbatim("matches") } },
} as unknown as WorkflowHealth;

function page(d: WorkflowDesign): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } } });
  client.setQueryData(["workflow-health", "p-1", "w-1"], health);
  render(
    <QueryClientProvider client={client}>
      <WorkflowDesignPage projectId="p-1" slug="acme" d={d} record={record} template={null} tab="design" onTab={() => {}} />
    </QueryClientProvider>,
  );
}

/** The canvas control that draws the changes against the approved revision. */
const changesToggle = () => screen.getByRole("switch", { name: "Changes since approved rev 1" });

describe("a proposed design awaiting this reader opens on its changes", () => {
  it("draws the changes of a proposal the reader decides, with nothing pressed", () => {
    page(design({ canDecide: true }));
    expect(changesToggle(), "a proposal awaiting this reader opens without its changes").toBeChecked();
  });

  it("opens a proposal awaiting someone else as it stands", () => {
    page(design({ canDecide: false }));
    expect(changesToggle(), "a proposal awaiting someone else opens on its changes").not.toBeChecked();
  });

  it("opens a returned design as it stands, whoever reads it", () => {
    page(design({ status: "returned", canDecide: true }));
    expect(changesToggle(), "a design not awaiting a decision opens on its changes").not.toBeChecked();
  });
});
