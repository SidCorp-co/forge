/**
 * @direct-test-of packages/web-v2/src/features/workflows/api.ts
 */
// The workflow design page is a record page (REQ-43, ISS-496 part D): the person view reads the
// design's state, and revision numbers, approval notes, pins, the approver rule and the kernel's terms
// sit behind the Developer view (BC-7); the header's state, the proposer and the step count are each
// said once (BC-5).

import { verbatim } from "@forge/contracts/said";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RULE, say, waitingOn } from "@/test/said";
import type { DesignRevision, WorkflowDesign, WorkflowRecord } from "../types";
import { ApproveAction, DecisionNoteControl } from "./design-decision";
import { WorkflowDesignProperties } from "./workflow-design-facts";
import { WorkflowDesignPage } from "./workflow-design-page";

const apiClient = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
vi.mock("@/lib/api/client", async (orig) => ({ ...(await orig<object>()), apiClient }));
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

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
    canWrite: true,
    canDraftRequirement: true,
    waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.approveDesign", { what: "Record flow" }), rule: RULE }),
    revisions: [rev({}), rev({ revision: 1, decision: "approve", decidedBy: "u-2", decidedByName: "Bo", decidedAt: AT, reason: NOTE, state: "current" })],
    builds: [],
    gate: { open: false, rule: "held", says: { rule: verbatim("held") } },
    requirements: [{ key: "REQ-9", title: "Checkout", status: "agreed", state: "in_delivery", pinnedRevision: 1 }],
    matchingRequirement: null,
  }) as unknown as WorkflowDesign;

const record = { workflowId: "w-1", writerName: "Ana", document: { ...body, id: "w-1", createdAt: AT, updatedAt: AT }, revision: 1 } as unknown as WorkflowRecord;

const atView = (view: "person" | "developer") => window.history.replaceState(null, "", view === "developer" ? "/?view=developer" : "/");
const withQueries = (node: React.ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
const facts = (d: WorkflowDesign = proposed()) =>
  withQueries(<WorkflowDesignProperties d={d} record={record} shown={body as never} shownRevision={2} template={null} slug="acme" health={undefined} projectId="p-1" />);

afterEach(() => atView("person"));

describe("the workflow design page's person view (BC-7)", () => {
  it("shows no revision number, approval note, pin, approver rule or kernel terms in the rail", () => {
    atView("person");
    facts();
    const rail = screen.getByTestId("design-facts");
    expect(screen.queryByTestId("fact-revision")).toBeNull();
    expect(screen.queryByTestId("fact-approved")).toBeNull();
    expect(screen.getByTestId("stands-approved").querySelector("[data-stand]")).toHaveAttribute("title", expect.stringContaining("Bo"));
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

describe("an act the viewer cannot take is not shown (ISS-807)", () => {
  const viewer = (): WorkflowDesign => ({ ...proposed(), canWrite: false, canDraftRequirement: false, requirements: [] });
  const member = (): WorkflowDesign => ({ ...proposed(), canWrite: true, canDraftRequirement: true, requirements: [] });
  const page = (d: WorkflowDesign) =>
    withQueries(<WorkflowDesignPage projectId="p-1" slug="acme" d={d} record={record} template={null} tab="design" onTab={() => {}} />);

  it("gives a viewer no Edit tab, and a member with the grant the tab", () => {
    page(viewer());
    expect(within(screen.getByTestId("design-tabs")).queryByRole("tab", { name: /^Edit/ })).toBeNull();
    expect(within(screen.getByTestId("design-tabs")).getByRole("tab", { name: /^Revisions/ })).toBeInTheDocument();
  });

  it("shows a member the Edit tab", () => {
    page(member());
    expect(within(screen.getByTestId("design-tabs")).getByRole("tab", { name: /^Edit/ })).toBeInTheDocument();
  });

  it("gives a viewer no Draft a requirement, and a member the button", () => {
    facts(viewer());
    expect(screen.queryByTestId("draft-from-design")).toBeNull();
  });

  it("shows a member Draft a requirement on a design no requirement roots", () => {
    facts(member());
    expect(screen.getByTestId("draft-from-design")).toHaveTextContent("Draft a requirement");
  });

  it("opens a viewer who follows an Edit link on the design, not the editor", () => {
    withQueries(<WorkflowDesignPage projectId="p-1" slug="acme" d={viewer()} record={record} template={null} tab="edit" onTab={() => {}} />);
    expect(screen.getByTestId("view-design")).toBeInTheDocument();
  });
});

describe("a design links the requirement that covers it before it drafts one (ISS-805)", () => {
  const member = (over: Partial<WorkflowDesign> = {}): WorkflowDesign => ({ ...proposed(), requirements: [], matchingRequirement: null, ...over });
  const match = { key: "REQ-12", title: "Record flow" };

  it("offers Link REQ-n, and not Draft, where a requirement matches", () => {
    facts(member({ matchingRequirement: match }));
    expect(screen.getByTestId("link-requirement")).toHaveTextContent("Link REQ-12");
    expect(screen.queryByTestId("draft-from-design")).toBeNull();
  });

  it("links the matching requirement through the requirement's own link route", async () => {
    facts(member({ matchingRequirement: match }));
    fireEvent.click(screen.getByTestId("link-requirement"));
    await waitFor(() => expect(apiClient).toHaveBeenCalledWith("/projects/p-1/requirements/REQ-12/workflows", { method: "POST", body: JSON.stringify({ workflowId: "w-1" }) }));
  });

  it("offers Draft, and not Link, where none matches", () => {
    facts(member());
    expect(screen.getByTestId("draft-from-design")).toHaveTextContent("Draft a requirement");
    expect(screen.queryByTestId("link-requirement")).toBeNull();
  });

  it("offers a viewer neither, match or not", () => {
    facts(member({ matchingRequirement: match, canDraftRequirement: false, canWrite: false }));
    expect(screen.queryByTestId("link-requirement")).toBeNull();
    expect(screen.queryByTestId("draft-from-design")).toBeNull();
  });

  it("offers neither on a design a requirement already roots", () => {
    facts(member({ requirements: proposed().requirements, matchingRequirement: match }));
    expect(screen.queryByTestId("link-requirement")).toBeNull();
    expect(screen.queryByTestId("draft-from-design")).toBeNull();
  });

  it("puts the act after the three marks, not between them", () => {
    facts(member({ matchingRequirement: match }));
    const rows = within(screen.getByTestId("plain-status"));
    const order = [rows.getByTestId("stands-approved"), rows.getByTestId("stands-requirement"), rows.getByTestId("stands-code"), rows.getByTestId("link-requirement")];
    order.slice(1).forEach((el, i) => expect((order[i]?.compareDocumentPosition(el) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy());
  });

  it("shows no flow slug or revision id in the Person view of the page, and the Developer view does", () => {
    atView("person");
    const { unmount } = facts();
    expect(screen.getByTestId("design-facts").innerHTML).not.toMatch(/record-flow|operational-flow|w-1/);
    unmount();
    atView("developer");
    facts();
    expect(screen.getByTestId("fact-revision")).toHaveTextContent("r2");
  });
});

describe("a draft's approval is said once (ISS-805)", () => {
  const draft = (): WorkflowDesign => ({ ...proposed(), status: "draft", approvedRevision: null, proposedRevision: null, revisions: [], requirements: [] });

  it("draws no Approved row where no revision was approved: the header pill says the state", () => {
    facts(draft());
    expect(screen.queryByTestId("stands-approved")).toBeNull();
    expect(screen.getByTestId("plain-status").textContent).not.toMatch(/Approved/);
  });

  it("keeps the row where an earlier revision is approved and a newer one waits", () => {
    facts();
    expect(screen.getByTestId("stands-approved")).toHaveTextContent("ApprovedYes");
  });
});

