// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowBody, WorkflowDesign, WorkflowRecord } from "../types";
import { WorkflowDesignScreen } from "./workflow-design-screen";

expect.extend(matchers);
afterEach(cleanup);

const ok = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
const mutate = vi.fn();

const doc = (over: Partial<WorkflowBody> = {}): WorkflowBody => ({
  version: 2,
  project: "hop",
  flow: "discharge-post-care",
  kind: "flow",
  title: "Discharge to post-care",
  summary: "From a signed discharge to a recorded clinic visit.",
 
  steps: [
    { id: "s1", title: "Discharge signed", does: "d", after: [], node: { type: "EVENT", owner: "Ward nurse", sla: "same day" } },
    { id: "s2", title: "Reminder sent", does: "d", after: ["s1"], node: { type: "ACTION" } },
  ],
  writtenBy: {},
  ...over,
});

const record: WorkflowRecord = {
  revision: 4,
  writer: "u1",
  writerName: "hop",
  design: { status: "proposed", approvedRevision: 3 },
  document: { ...doc(), id: "w1", updatedAt: "2026-10-04T00:00:00.000Z" } as WorkflowRecord["document"],
};

const revision = (n: number, over: Partial<WorkflowDesign["revisions"][number]> = {}): WorkflowDesign["revisions"][number] => ({
  revision: n,
  document: doc(),
  proposedBy: "u1",
  proposedByName: "hop",
  proposedAt: "2026-10-04T00:00:00.000Z",
  decision: null,
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  reason: null,
  state: "superseded",
  ...over,
});

const proposedYou: WorkflowDesign = {
  workflowId: "w1",
  flow: "discharge-post-care",
  status: "proposed",
  revision: 4,
  proposedRevision: 4,
  approvedRevision: 3,
  approver: "owner",
  canDecide: true,
  waitingOn: { kind: "you", who: "You", act: "approve or return revision 4", rule: "revision 4 is proposed and you may decide it" },
  revisions: [revision(4, { state: "proposed", document: doc({ steps: [...doc().steps, { id: "s3", title: "Roll back", does: "d", after: ["s2"] }] }) }), revision(3, { state: "current", decision: "approve", decidedByName: "Lan", decidedAt: "2026-10-03T00:00:00.000Z" })],
  builds: [{ issueId: "i1", displayId: "ISS-1402", title: "Publish only an approved revision", status: "in_progress" }],
  gate: { open: false, rule: "issues that build it are held out of dispatch until a revision is approved; revision 4 waits on its approver" },
  requirements: [{ key: "REQ-12", title: "Post-discharge follow-up", status: "agreed", pinnedRevision: 3 }],
};

let design: WorkflowDesign = proposedYou;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search), usePathname: () => window.location.pathname }));
vi.mock("../hooks", () => ({
  useWorkflows: () => ok({ workflows: [record], returned: 1 }),
  useWorkflowTemplates: () => ok({ templates: [], returned: 0 }),
  useWorkflowDesign: () => ok(design),
  useDesignDecision: () => ({ mutate, isPending: false, isError: false, error: null }),
}));
vi.mock("@/features/comments/hooks", () => ({ useEntityDecisions: () => ok({ items: [], returned: 2 }) }));
vi.mock("@/features/comments/components/decisions-panel", () => ({ DecisionsPanel: () => <p data-testid="decisions-panel" /> }));
vi.mock("../canvas/workflow-canvas", () => ({ WorkflowCanvas: () => <div data-testid="canvas-stub" /> }));

const wrap = (n: ReactNode) => <QueryClientProvider client={new QueryClient()}>{n}</QueryClientProvider>;
const show = (d: WorkflowDesign, search = "") => {
  design = d;
  window.history.replaceState(null, "", `/projects/hop/workflows/discharge-post-care${search}`);
  return render(wrap(<WorkflowDesignScreen projectId="p1" slug="hop" flow="discharge-post-care" />));
};

beforeEach(() => {
  mutate.mockReset();
  try {
    sessionStorage.clear();
  } catch {}
});

describe("WorkflowDesignScreen", () => {
  it("names its back control after Workflows and goes to the list view it was opened from", () => {
    sessionStorage.setItem("web-v2:list-origin:workflows", "/projects/hop/workflows?template=state-machine");
    show(proposedYou);
    const back = screen.getByTestId("detail-back");
    expect(back).toHaveTextContent("Workflows");
    expect(back).toHaveAttribute("href", "/projects/hop/workflows?template=state-machine");
  });

  it("goes to the plain list when the page was reached by a link", () => {
    sessionStorage.setItem("web-v2:list-origin:workflows", "/projects/hop/issues?status=open");
    show(proposedYou);
    expect(screen.getByTestId("detail-back")).toHaveAttribute("href", "/projects/hop/workflows");
  });

  it("states whose turn it is once, in one tinted line read from core, with Return where it acts", () => {
    show(proposedYou);
    const banner = screen.getByTestId("design-banner");
    expect(banner).toHaveTextContent("Waiting on you: approve or return revision 4");
    expect(banner).toHaveAttribute("title", "revision 4 is proposed and you may decide it");
    expect(within(banner).getByTestId("design-return-open")).toBeInTheDocument();
    expect(within(banner).queryByTestId("design-approve")).toBeNull();
  });

  it("carries one primary act in the header, Approve of the revision that waits", () => {
    show(proposedYou);
    const approve = screen.getAllByTestId("design-approve");
    expect(approve).toHaveLength(1);
    expect(approve[0]).toHaveTextContent("Approve rev 4");
    fireEvent.click(approve[0] as HTMLElement);
    expect(mutate).toHaveBeenCalledWith({ revision: 4, decision: "approve" });
  });

  it("offers no decision to a viewer who may not decide, and names who may", () => {
    show({ ...proposedYou, canDecide: false, waitingOn: { kind: "person", who: "An org owner or admin", act: "approve or return revision 4", rule: "r" } });
    expect(screen.getByTestId("design-banner")).toHaveTextContent("Waiting on An org owner or admin: approve or return revision 4");
    expect(screen.queryByTestId("design-approve")).toBeNull();
    expect(screen.queryByTestId("design-return-open")).toBeNull();
  });

  it("draws no banner when the design waits on nobody", () => {
    show({ ...proposedYou, status: "approved", proposedRevision: null, approvedRevision: 4, canDecide: true, waitingOn: { kind: "none", who: "Nobody", act: "", rule: "r" } });
    expect(screen.queryByTestId("design-banner")).toBeNull();
    expect(screen.queryByTestId("design-approve")).toBeNull();
  });

  it("names the requirement drawn with it and its build gate in the facts rail, from core", () => {
    show(proposedYou);
    const rail = screen.getByTestId("design-rail");
    const req = within(rail).getByTestId("rail-requirement");
    expect(within(req).getByRole("link", { name: "REQ-12" })).toHaveAttribute("href", "/projects/hop/requirements/REQ-12");
    expect(req).toHaveTextContent("r3");
    expect(within(req).getByTestId("status-badge")).toHaveTextContent("Agreed");
    const gate = within(rail).getByTestId("build-gate");
    expect(gate).toHaveAttribute("data-open", "false");
    expect(gate).toHaveTextContent("Held");
    expect(within(rail).getByRole("link", { name: "ISS-1402" })).toHaveAttribute("href", "/projects/hop/issues/ISS-1402");
  });

  it("says plainly when no requirement links the design", () => {
    show({ ...proposedYou, requirements: [] });
    expect(within(screen.getByTestId("facts-requirement")).getByText("No requirement links this design.")).toBeInTheDocument();
  });

  it("draws the design status and each revision's state as badges, never as raw tokens", () => {
    show(proposedYou, "?tab=revisions");
    const rows = screen.getAllByTestId("revision-row");
    expect(rows.map((r) => within(r).getByTestId("status-badge").textContent)).toEqual(["●Awaiting approval", "◆Approved"]);
    expect(within(screen.getByTestId("fact-revision")).getByTestId("status-badge")).toHaveAttribute("data-value", "proposed");
    for (const pill of screen.getAllByTestId("design-pill")) expect(pill).toHaveAttribute("data-status", "proposed");
    expect(document.body.textContent).not.toContain("superseded");
  });

  it("lists who owns which step and marks what the waiting revision adds", () => {
    show(proposedYou, "?tab=steps");
    const rows = screen.getAllByTestId("design-step-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Ward nurse");
    expect(rows[2]).toHaveAttribute("data-mark", "added");
    expect(rows[2]).toHaveTextContent("Added in rev 4");
  });
});
