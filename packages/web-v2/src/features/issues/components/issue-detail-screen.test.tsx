// @vitest-environment jsdom
//
// ISS-1150 — what the issue says comes first. An empty secondary panel (Steps) is one line, never a
// card that outranks the description, and the attachments sit inside the description rather than
// after it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDetailScreen } from "./issue-detail-screen";

expect.extend(matchers);

const ok = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

let handoffs: ReturnType<typeof ok> | Record<string, unknown> = ok([]);
let durations: ReturnType<typeof ok> = ok([]);
let attachments: ReturnType<typeof ok> = ok([]);

const ISSUE = {
  id: "11111111-1111-4111-8111-111111111111",
  displayId: "ISS-7",
  projectId: "p1",
  title: "A title long enough that a single truncated line would cut it before the end of the sentence",
  description: "What the issue says.",
  descriptionFormat: "markdown",
  status: "open",
  agentStatus: null,
  priority: "medium",
  complexity: "m",
  labels: [],
  agentSessions: [],
  reopenCount: 0,
  createdAt: "2026-09-21T11:01:17.765Z",
  mergedAt: null,
};

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: [{ id: "p1", role: "admin" }] }) }));
vi.mock("@/features/pipeline/hooks", () => ({ useResumeRun: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/features/questions/components/decision-panel", () => ({
  DECISION_PANEL_ANCHOR: "decisions",
  DecisionPanel: () => null,
}));
vi.mock("@/features/shell", () => ({ buildShareLink: (p: string) => p, useRecents: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./awaiting-release-banner", () => ({ AwaitingReleaseBanner: () => null }));
vi.mock("./use-guarded-transition", () => ({
  useGuardedTransition: () => ({ requestTransition: vi.fn(), dialog: null, isPending: false }),
}));
vi.mock("./properties-rail", () => ({ PropertiesRail: () => <div>rail</div> }));
vi.mock("./module-picker", () => ({ ModulePicker: () => null }));
vi.mock("./comment-thread", () => ({ CommentThread: () => <div>comments</div> }));
vi.mock("./step-artifact-card", () => ({
  StepArtifactCard: ({ outcome }: { outcome: { step: string } }) => <div>step {outcome.step}</div>,
}));
vi.mock("./html-attachment-card", () => ({
  HtmlAttachmentCard: ({ name }: { name: string }) => <div>preview {name}</div>,
}));
vi.mock("../detail-hooks", () => ({
  useIssue: () => ok(ISSUE),
  useComments: () => ok({ items: [], totalCount: 0 }),
  useActivity: () => ok({ items: [] }),
  useTasks: () => ok([]),
  useAttachments: () => attachments,
  useStepHandoffs: () => handoffs,
  useStepDurations: () => durations,
}));
vi.mock("../hooks", () => ({
  useIssueCost: () => ok(undefined),
  useIssueDeps: () => ok(undefined),
  usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
  useProjectMembers: () => ok([]),
  useSaveDescription: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <IssueDetailScreen projectId="p1" slug="forge-dev" id="ISS-7" />
    </QueryClientProvider>,
  );
}

/** True when `a` comes before `b` in document order. */
const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

beforeEach(() => {
  handoffs = ok([]);
  durations = ok([]);
  attachments = ok([]);
});
afterEach(cleanup);

describe("the issue detail's main column", () => {
  it("draws an empty Steps panel as one line, not a card with an empty state", () => {
    renderScreen();
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(steps).toHaveTextContent("None yet");
    expect(steps.className).toContain("h-10");
    expect(screen.queryByText("No steps yet")).toBeNull();
  });

  it("puts the description ahead of the Steps panel", () => {
    renderScreen();
    const description = screen.getByText("What the issue says.");
    expect(precedes(description, screen.getByRole("region", { name: "Steps" }))).toBe(true);
  });

  it("keeps a populated Steps card after the description too", () => {
    durations = ok([
      { step: "code", runId: "r1", durationSeconds: 12, costUsd: 0, startedAt: "2026-09-21T11:00:00Z", finishedAt: "2026-09-21T11:00:12Z" },
    ]);
    renderScreen();
    expect(precedes(screen.getByText("What the issue says."), screen.getByText("step code"))).toBe(true);
  });

  it("says the steps could not be loaded rather than that there are none", () => {
    handoffs = { data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch: vi.fn() };
    renderScreen();
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(steps).toHaveTextContent("Couldn't load");
    expect(steps).not.toHaveTextContent("None yet");
  });

  it("says the steps could not be loaded when only the durations read failed", () => {
    durations = { data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch: vi.fn() } as never;
    renderScreen();
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(steps).toHaveTextContent("Couldn't load");
    expect(steps).not.toHaveTextContent("None yet");
  });

  it("shows attachments inside the description, above its text, and no separate Attachments card", () => {
    attachments = ok([{ id: "a1", name: "detail-audit-report.html", mime: "text/html", size: 400_000, url: "/api/attachments/a1/download" }]);
    renderScreen();
    const region = screen.getByRole("region", { name: "Attachments" });
    expect(within(region).getByText("preview detail-audit-report.html")).toBeInTheDocument();
    expect(precedes(region, screen.getByText("What the issue says."))).toBe(true);
    expect(screen.queryByText("Attachments")).toBeNull();
  });

  it("renders no attachments panel and no 'No attachments' line for an issue with none", () => {
    renderScreen();
    expect(screen.queryByRole("region", { name: "Attachments" })).toBeNull();
    expect(screen.queryByText("No attachments.")).toBeNull();
  });

  it("lets the header title wrap rather than truncate", () => {
    renderScreen();
    const title = screen.getByRole("heading", { name: ISSUE.title });
    expect(title.className).not.toMatch(/\btruncate\b/);
    expect(title.className).toContain("break-words");
  });

  it("sizes the rail as a clamped share of the grid rather than a fixed column", () => {
    renderScreen();
    const grid = screen.getByText("What the issue says.").closest(".grid");
    expect(grid?.className).toContain("lg:grid-cols-[minmax(0,1fr)_clamp(16rem,32%,22.5rem)]");
    expect(grid?.className).not.toContain("_360px]");
  });
});
