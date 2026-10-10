// The workflow design page is a record page (REQ-43, ISS-496 part D): the person view reads the
// design's state, and revision numbers, approval notes, pins, the approver rule and the kernel's terms
// sit behind the Developer view (BC-7); the header's state, the proposer and the step count are each
// said once (BC-5).

import { verbatim } from "@forge/contracts/said";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RULE, say, waitingOn } from "@/test/said";
import type { DesignRevision, WorkflowDesign, WorkflowRecord } from "../types";
import { ApproveAction, DecisionNoteControl } from "./design-decision";
import { WorkflowDesignProperties } from "./workflow-design-facts";
import { WorkflowDesignPage } from "./workflow-design-page";

const AT = "2026-10-07T10:00:00.000Z";
const NOTE = "REQ-36 BC-16 drawn as act-qa; rule-merge is the gate.";

const body = {
  version: 2,
  project: "p-1",
  flow: "record-flow",
  kind: "flow",
  title: "Record flow",
  summary: "",
  template: { id: "operational-flow", version: 1 },
  steps: [
    { id: "intake", does: "Intake takes the case.", after: [], node: { owner: "Ops" } },
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

const proposed = (): WorkflowDesign =>
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
    revisions: [rev({}), rev({ revision: 1, decision: "approve", decidedBy: "u-2", decidedByName: "Bo", decidedAt: AT, reason: NOTE, state: "current" })],
    builds: [],
    gate: { open: false, rule: "held", says: { rule: verbatim("held") } },
    requirements: [{ key: "REQ-9", title: "Checkout", status: "agreed", state: "in_delivery", pinnedRevision: 1 }],
  }) as unknown as WorkflowDesign;

const record = { writerName: "Ana", document: { ...body, id: "w-1", createdAt: AT, updatedAt: AT }, revision: 1 } as unknown as WorkflowRecord;

const atView = (view: "person" | "developer") => window.history.replaceState(null, "", view === "developer" ? "/?view=developer" : "/");
const withQueries = (node: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
const facts = () =>
  withQueries(<WorkflowDesignProperties d={proposed()} record={record} shown={body as never} shownRevision={2} template={null} slug="acme" health={undefined} />);

afterEach(() => atView("person"));

describe("the workflow design page's person view (BC-7)", () => {
  it("shows no revision number, approval note, pin, approver rule or kernel terms in the rail", () => {
    atView("person");
    facts();
    const rail = screen.getByTestId("design-facts");
    expect(screen.queryByTestId("fact-revision")).toBeNull();
    expect(within(screen.getByTestId("fact-approved")).getByText("Bo")).toBeInTheDocument();
    expect(rail.textContent).not.toMatch(/\br\d|Rev \d|REQ-36|BC-16|Anyone allowed/);
    expect(screen.queryByTestId("fact-approved-note")).toBeNull();
    expect(screen.queryByTestId("rail-requirement-pin")).toBeNull();
    expect(screen.queryByTestId("design-technical")).toBeNull();
  });

  it("draws them all in the Developer view, the kernel's terms open", () => {
    atView("developer");
    facts();
    expect(screen.getByTestId("fact-revision")).toHaveTextContent("r2");
    expect(screen.getByTestId("fact-approved")).toHaveTextContent("Rev 1 by Bo");
    expect(screen.getByTestId("fact-approved-note")).toHaveTextContent("REQ-36 BC-16");
    expect(screen.getByTestId("rail-requirement-pin")).toHaveTextContent("r1");
    expect(screen.getByTestId("facts-build-gate")).toBeInTheDocument();
  });

  it("names the decision's acts without a revision number, and the Developer view with one", () => {
    const decide = { mutate: vi.fn(), isPending: false } as never;
    atView("person");
    const { unmount } = withQueries(<ApproveAction revision={2} decide={decide} />);
    expect(screen.getByTestId("design-approve")).toHaveTextContent(/^Approve$/);
    unmount();
    atView("developer");
    withQueries(<ApproveAction revision={2} decide={decide} />);
    expect(screen.getByTestId("design-approve")).toHaveTextContent("Approve rev 2");
  });

  it("reads the Revisions tab and a changed step without revision numbers", () => {
    atView("person");
    withQueries(<WorkflowDesignPage projectId="p-1" slug="acme" d={proposed()} record={record} template={null} tab="revisions" onTab={() => {}} />);
    for (const row of screen.getAllByTestId("revision-row")) expect(row.textContent).not.toMatch(/\br\d/);
  });

  it("keeps the note control's submit free of a revision number", () => {
    atView("person");
    const decide = { mutate: vi.fn(), isPending: false } as never;
    withQueries(<DecisionNoteControl revision={2} decide={decide} />);
    fireEvent.click(screen.getByTestId("design-return-open"));
    expect(screen.getByTestId("design-return-submit").textContent).not.toMatch(/\d/);
  });
});

describe("each fact once on the workflow design page (BC-5)", () => {
  it("says the state in the header only: the rail draws no revision state badge", () => {
    atView("person");
    facts();
    expect(within(screen.getByTestId("design-facts")).queryByText("Awaiting approval")).toBeNull();
  });

  it("counts the steps in the tab only, not again in the rail", () => {
    atView("person");
    facts();
    const steps = screen.getByTestId("fact-steps");
    expect(steps.textContent).not.toMatch(/\b2\b/);
    expect(steps).toHaveTextContent("1 with an owner");
  });

  it("names the proposer once: the rail's Drawn by, not again in the banner", () => {
    atView("person");
    withQueries(<WorkflowDesignPage projectId="p-1" slug="acme" d={proposed()} record={record} template={null} tab="design" onTab={() => {}} />);
    expect(screen.getByTestId("design-banner-line")).not.toHaveTextContent("Ana");
    expect(screen.getByTestId("design-facts")).toHaveTextContent("Ana");
  });
});
