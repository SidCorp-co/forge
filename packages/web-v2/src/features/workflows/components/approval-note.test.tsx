// An approval's note is shown where the design is read (ISS-259): in the Properties rail's Approved fact,
// and in the Revisions tab under a label that says which decision wrote it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { say, sayEn, verbatim } from "@forge/contracts/said";
import { describe, expect, it } from "vitest";
import { revisionReason } from "../decision-words";
import type { DesignRevision, WorkflowDesign, WorkflowRecord } from "../types";
import { WorkflowDesignFacts } from "./workflow-design-facts";
import { WorkflowDesignPage } from "./workflow-design-page";

const NOTE = "Approved as drawn.\nThe SLA step is owed in rev 2.";

const body = {
  version: 2,
  project: "p-1",
  flow: "noted-flow",
  kind: "flow",
  title: "Noted flow",
  summary: "",
  template: { id: "operational-flow", version: 1 },
  steps: [{ id: "intake", does: "Intake takes the case.", after: [] }],
  edges: [],
};

const revision = (over: Partial<DesignRevision>): DesignRevision => {
  const r = {
    revision: 1,
    document: body,
    proposedBy: "u-1",
    proposedByName: "Ana",
    proposedAt: "2026-10-06T10:00:00.000Z",
    decision: "approve",
    decidedBy: "u-2",
    decidedByName: "Bo",
    decidedAt: "2026-10-06T11:00:00.000Z",
    reason: NOTE,
    state: "approved",
    ...over,
  };
  return { ...r, says: over.says ?? { reason: r.reason ? verbatim(r.reason) : null } } as DesignRevision;
};

const design = (r: DesignRevision): WorkflowDesign =>
  ({
    workflowId: "w-1",
    flow: "noted-flow",
    status: r.decision === "return" ? "returned" : "approved",
    revision: 1,
    proposedRevision: null,
    approvedRevision: r.decision === "approve" ? 1 : null,
    approver: "workflow-designs.approve",
    canDecide: false,
    waitingOn: { kind: "none", who: "", act: "", rule: "", ref: null, dueAt: null },
    revisions: [r],
    builds: [],
    gate: { open: r.decision === "approve", rule: "issues that build it may be dispatched" },
    requirements: [],
  }) as unknown as WorkflowDesign;

const record = { document: { ...body, id: "w-1", createdAt: "2026-10-06T10:00:00.000Z", updatedAt: "2026-10-06T10:00:00.000Z" }, revision: 1 } as unknown as WorkflowRecord;

const withQueries = (node: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);

describe("an approval's note where the design is read", () => {
  it("shows the approved revision's note beneath who approved it", () => {
    withQueries(<WorkflowDesignFacts d={design(revision({}))} record={record} shown={record.document} shownRevision={1} template={null} slug="acme" health={undefined} />);
    const fact = screen.getByTestId("fact-approved");
    expect(fact).toHaveTextContent("Rev 1 by Bo");
    expect(within(fact).getByTestId("fact-approved-note").textContent).toBe(NOTE);
  });

  it("shows no note line when the approval carried none", () => {
    withQueries(<WorkflowDesignFacts d={design(revision({ reason: null }))} record={record} shown={record.document} shownRevision={1} template={null} slug="acme" health={undefined} />);
    expect(screen.getByTestId("fact-approved")).toHaveTextContent("Rev 1 by Bo");
    expect(screen.queryByTestId("fact-approved-note")).toBeNull();
  });

  it("labels an approval's text Approval note and a return's Reason in the Revisions tab", () => {
    const page = (r: DesignRevision) => (
      <WorkflowDesignPage projectId="p-1" slug="acme" d={design(r)} record={record} template={null} tab="revisions" onTab={() => {}} />
    );
    const { rerender } = withQueries(page(revision({})));
    const approved = screen.getByTestId("revision-row");
    expect(within(approved).getByText("Approval note")).toBeInTheDocument();
    expect(within(approved).queryByText("Reason")).toBeNull();
    fireEvent.click(within(approved).getByText("Approval note"));
    expect(approved.querySelector("p")?.textContent).toBe(NOTE);

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        {page(revision({ decision: "return", reason: "Name the consent owner.", state: "returned" }))}
      </QueryClientProvider>,
    );
    const returned = screen.getByTestId("revision-row");
    expect(within(returned).getByText("Reason")).toBeInTheDocument();
    expect(within(returned).queryByText("Approval note")).toBeNull();
  });

  it("reads a re-pin act's reason in the reader's language, and a decider's note as they wrote it", () => {
    const said = say("designs.reason.repinOnly", {
      act: "a1b2",
      actWords: say("designs.act.repinBatch", { n: 2, changes: "changes", r: 2 }),
      flow: "access",
      pins: "access r1 → r2",
      fp: "0123456789ab",
      r: 1,
    });
    const composed = revision({ reason: sayEn(said), says: { reason: said } });
    expect(revisionReason(composed, "en")).toBe(sayEn(said));
    const vi = revisionReason(composed, "vi");
    expect(vi).not.toBe(sayEn(said));
    expect(vi).toContain("access r1 → r2");
    expect(revisionReason(revision({}), "vi")).toBe(NOTE);
  });
});
