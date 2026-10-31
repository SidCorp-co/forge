/**
 * @direct-test-of packages/web-v2/src/features/workflows/components/workflow-design-screen.tsx
 *
 * The design page's header names the flow slug and the row's id in the Developer view only (ISS-805).
 */
import { verbatim } from "@forge/contracts/said";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RULE, say, waitingOn } from "@/test/said";
import type { WorkflowDesign, WorkflowRecord } from "../types";
import { WorkflowDesignScreen } from "./workflow-design-screen";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());
vi.mock("@/features/comments", () => ({ useEntityDecisions: () => ({ data: undefined }) }));

const AT = "2026-10-07T10:00:00.000Z";
const body = { version: 2, project: "p-1", flow: "workspace-onboarding", kind: "flow", title: "Workspace onboarding", summary: "", template: { id: "operational-flow", version: 1 }, steps: [], edges: [] };
const record = { workflowId: "w-uuid-1", writerName: "Ana", document: { ...body, id: "w-uuid-1", createdAt: AT, updatedAt: AT }, revision: 1 } as unknown as WorkflowRecord;
const design = {
  workflowId: "w-uuid-1",
  flow: "workspace-onboarding",
  status: "draft",
  revision: 1,
  proposedRevision: null,
  approvedRevision: null,
  approver: "workflow-designs.approve",
  canDecide: false,
  canWrite: true,
  canDraftRequirement: true,
  waitingOn: waitingOn("you", { who: say("standing.who.you"), act: say("standing.act.approveDesign", { what: "x" }), rule: RULE }),
  revisions: [],
  builds: [],
  gate: { open: false, rule: "held", says: { rule: verbatim("held") } },
  requirements: [],
  matchingRequirement: null,
  approvalBlocked: null,
  approvalLeavesStale: [],
  pinOnly: null,
} as unknown as WorkflowDesign;

vi.mock("../hooks", async (importOriginal) => {
  const q = (data: unknown) => ({ data, isLoading: false, error: null });
  return {
    ...(await importOriginal<typeof import("../hooks")>()),
    useWorkflows: () => q({ workflows: [record], returned: 1, canWrite: true }),
    useWorkflowTemplates: () => q({ templates: [] }),
    useWorkflowDesign: () => q(design),
    useWorkflowHealth: () => q(undefined),
    useDesignDecision: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  };
});

const atView = (view: "person" | "developer") => window.history.replaceState(null, "", view === "developer" ? "/?view=developer" : "/");
const open = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WorkflowDesignScreen projectId="p-1" slug="acme" flow="workspace-onboarding" />
    </QueryClientProvider>,
  );

afterEach(() => atView("person"));

describe("the design page header (ISS-805)", () => {
  it("shows no flow slug or row id in the Person view", () => {
    atView("person");
    open();
    expect(screen.getByTestId("workflow-design-screen")).toBeInTheDocument();
    expect(screen.getByTestId("workflow-design-screen").textContent).not.toMatch(/workspace-onboarding|w-uuid-1/);
  });

  it("shows the flow slug in the Developer view", () => {
    atView("developer");
    open();
    expect(screen.getAllByText("workspace-onboarding").length).toBeGreaterThan(0);
  });
});
