// @vitest-environment jsdom
//
// ISS-1150 — what the issue says comes first. An empty secondary panel (Steps) is one line, never a
// card that outranks the description, and the attachments sit inside the description rather than
// after it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDetailScreen } from "./issue-detail-screen";

expect.extend(matchers);

const ok = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

let handoffs: ReturnType<typeof ok> | Record<string, unknown> = ok([]);
let durations: ReturnType<typeof ok> = ok([]);
let attachments: ReturnType<typeof ok> = ok([]);
let pipelineHealth: Record<string, unknown> | undefined;
let status = "open";
let park: Record<string, unknown> = { state: "ready", park: null };
let role: string | null = "admin";
let intake: "auto" | "manual" = "auto";
let sessionContext: Record<string, unknown> | null = null;
let workState: Record<string, unknown> | null = null;
let policyError: Error | null = null;
const startIssue = vi.fn();

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
vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: [{ id: "p1", role }] }) }));
vi.mock("@/features/project-settings/config-hooks", () => ({
  usePolicyDocument: () =>
    policyError
      ? { data: undefined, isLoading: false, isError: true, error: policyError, refetch: vi.fn() }
      : ok({ declared: true, revision: 1, document: { intake: { mode: intake } } }),
}));
vi.mock("@/features/pipeline/hooks", () => ({ useResumeRun: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/features/questions/components/decision-panel", () => ({
  DecisionPanel: () => null,
  focusDecisionPanel: vi.fn(),
}));
vi.mock("@/features/shell", () => ({ buildShareLink: (p: string) => p, useRecents: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./awaiting-release-banner", () => ({ AwaitingReleaseBanner: () => null }));
vi.mock("./use-guarded-transition", () => ({
  useGuardedTransition: () => ({ requestTransition: vi.fn(), requestParkLeave: vi.fn(), dialog: null, isPending: false }),
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
  useIssue: () => ok({ ...ISSUE, status, pipelineHealth, sessionContext, workState }),
  useComments: () => ok({ items: [], totalCount: 0 }),
  useActivity: () => ok({ items: [] }),
  useTasks: () => ok([]),
  useAttachments: () => attachments,
  useStepHandoffs: () => handoffs,
  useStepDurations: () => durations,
  useCreateComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../park", () => ({ useIssuePark: () => park }));
vi.mock("../hooks", () => ({
  useIssueCost: () => ok(undefined),
  useIssueDeps: () => ok(undefined),
  useIssueStandingOf: () => ok(undefined),
  usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
  useProjectMembers: () => ok([]),
  useSaveDescription: () => ({ mutate: vi.fn(), isPending: false }),
  useRunPipelineStep: () => ({ mutate: startIssue, isPending: false }),
  useStatusExits: () => ({ exits: EXITS, isPending: false, isError: false }),
}));

/** Core's exits rows for the statuses these tests stand at (`pipeline/state-machine.ts`). */
const EXITS = {
  open: ["in_progress", "needs_info", "on_hold", "dropped"],
  in_progress: ["approved", "awaiting_release", "closed", "needs_info", "on_hold", "dropped"],
  awaiting_release: ["closed", "reopen", "needs_info", "on_hold", "dropped"],
  closed: ["reopen"],
  on_hold: ["needs_info", "dropped"],
};

function renderScreen(tab?: string) {
  window.history.replaceState(null, "", `/projects/forge-dev/issues/ISS-7${tab ? `?tab=${tab}` : ""}`);
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
  pipelineHealth = undefined;
  status = "open";
  park = { state: "ready", park: null };
  role = "admin";
  intake = "auto";
  sessionContext = null;
  workState = null;
  policyError = null;
  startIssue.mockClear();
});
afterEach(cleanup);

describe("the issue detail's main column", () => {
  it("draws an empty Steps panel on the Runs tab as one line, not a card with an empty state", () => {
    renderScreen("runs");
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(steps).toHaveTextContent("None yet");
    expect(steps.className).toContain("h-10");
    expect(screen.queryByText("No steps yet")).toBeNull();
  });

  it("opens on the description, with the Steps panel kept to its own tab", () => {
    renderScreen();
    expect(screen.getByText("What the issue says.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Steps" })).toBeNull();
    expect(screen.getByRole("tab", { name: /Overview/ })).toHaveAttribute("aria-selected", "true");
  });

  it("lists recorded steps on the Runs tab", () => {
    durations = ok([
      { step: "code", runId: "r1", durationSeconds: 12, costUsd: 0, startedAt: "2026-09-21T11:00:00Z", finishedAt: "2026-09-21T11:00:12Z" },
    ]);
    renderScreen("runs");
    expect(screen.getByText("step code")).toBeInTheDocument();
  });

  it("says the steps could not be loaded rather than that there are none", () => {
    handoffs = { data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch: vi.fn() };
    renderScreen("runs");
    const steps = screen.getByRole("region", { name: "Steps" });
    expect(steps).toHaveTextContent("Couldn't load");
    expect(steps).not.toHaveTextContent("None yet");
  });

  it("says the steps could not be loaded when only the durations read failed", () => {
    durations = { data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch: vi.fn() } as never;
    renderScreen("runs");
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

  it("lets the narrow-screen title wrap rather than truncate", () => {
    renderScreen();
    const title = within(screen.getByTestId("detail-mobile-title")).getByText(ISSUE.title);
    expect(title.className).not.toMatch(/\btruncate\b/);
    expect(title.className).toContain("break-words");
  });

  it("names the back control after the list it returns to", () => {
    renderScreen();
    const back = screen.getByTestId("detail-back");
    expect(back).toHaveTextContent("Issues");
    expect(back.getAttribute("href")).toBe("/projects/forge-dev/issues");
  });

  it("keeps the session and pipeline jumps in the actions menu beside the one primary action", () => {
    renderScreen();
    expect(screen.queryByRole("button", { name: "Open session" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Issue actions" }));
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toContain("Open session");
  });

  it("puts the facts in a rail beside the tabs, the properties inside it", () => {
    renderScreen();
    const rail = screen.getByRole("complementary", { name: "Facts" });
    expect(within(rail).getByText("rail")).toBeInTheDocument();
  });
});

// ISS-1277 — a job no runner has claimed yet has no session, and the header still reads it as a queued run.
describe("the issue header's run", () => {
  // The top bar's key and badges; the narrow-screen title repeats them under it.
  const headerChips = () => screen.getAllByText("ISS-7")[0]?.parentElement as HTMLElement;

  it("shows a queued job with no session as a Queued run chip and offers Pause", () => {
    pipelineHealth = {
      stage: "open",
      queuedStep: { jobId: "j1", jobType: "drive", stageStatus: null, queuedAt: "2026-09-05T14:16:00Z", retryAfterAt: null },
    };
    renderScreen();
    expect(within(headerChips()).getByText("Queued")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run pipeline" })).toBeNull();
  });

  it("shows no run chip and offers Run pipeline when nothing is queued and no session exists", () => {
    pipelineHealth = { stage: "open" };
    renderScreen();
    expect(within(headerChips()).queryByText("Queued")).toBeNull();
    expect(within(headerChips()).queryByText("Running")).toBeNull();
    expect(screen.getByRole("button", { name: "Run pipeline" })).toBeInTheDocument();
  });
});

// ISS-1257 — a question marks its issue and leaves its rung alone; ISS-1310 — the banner reads it off the park view.
describe("the issue page of work a person owes an answer", () => {
  const WAITING_FOR_INFORMATION = /waiting for information/;

  it("says so above an issue in progress holding an open question blocked on a person", () => {
    status = "in_progress";
    park = {
      state: "ready",
      park: {
        shape: "question",
        status: "in_progress",
        owes: "information",
        since: null,
        reason: null,
        resume: { at: null, why: "not stopped" },
        record: null,
        readings: [],
        answer: null,
        openQuestionIds: ["q1"],
      },
    };
    renderScreen();
    expect(screen.getByText(WAITING_FOR_INFORMATION)).toBeInTheDocument();
  });

  it("says nothing of the kind once that question is answered", () => {
    status = "in_progress";
    park = { state: "ready", park: null };
    renderScreen();
    expect(screen.queryByText(WAITING_FOR_INFORMATION)).toBeNull();
  });
});

// ISS-54 — the issue menu offers Pause and Reopen only where core's exits row has them.
describe("the issue actions menu", () => {
  const menu = () => {
    fireEvent.click(screen.getByRole("button", { name: "Issue actions" }));
    return screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
  };

  it("offers Pause and no Reopen on an open issue, which cannot be reopened", () => {
    status = "open";
    renderScreen();
    const items = menu();
    expect(items).toContain("Pause (hold)");
    expect(items).not.toContain("Reopen");
  });

  it("offers Reopen and no Pause on a closed issue", () => {
    status = "closed";
    renderScreen();
    const items = menu();
    expect(items).toContain("Reopen");
    expect(items).not.toContain("Pause (hold)");
  });

  it("offers neither on a hold that left in_progress, whose way back is that status", () => {
    status = "on_hold";
    workState = { step: null, leftStatus: "in_progress", steps: [] };
    renderScreen();
    const items = menu();
    expect(items).not.toContain("Reopen");
    expect(items).not.toContain("Pause (hold)");
  });

  it("offers Reopen on a hold that recorded no status it left, as core lets a person name one", () => {
    status = "on_hold";
    workState = null;
    renderScreen();
    expect(menu()).toContain("Reopen");
  });
});

// ISS-29 — a project whose intake is manual holds an open issue until a person starts it.
describe("the issue header's start on a manual-intake project", () => {
  it.each(["member", "admin"])("offers a %s Start, which calls the start route for this issue", (r) => {
    intake = "manual";
    role = r;
    renderScreen();
    screen.getByRole("button", { name: "Start" }).click();
    expect(startIssue).toHaveBeenCalledWith({ id: ISSUE.id }, expect.anything());
    expect(screen.queryByRole("button", { name: "Run pipeline" })).toBeNull();
  });

  it("shows a viewer no Start, only who it waits for", () => {
    intake = "manual";
    role = "viewer";
    renderScreen();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.getByText("Waits for a project member to start it")).toBeInTheDocument();
  });

  it("shows an org member with no project role no Start either", () => {
    intake = "manual";
    role = null;
    renderScreen();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.getByText("Waits for a project member to start it")).toBeInTheDocument();
  });

  it("says an issue already started is waiting for a runner, and offers no second Start", () => {
    intake = "manual";
    sessionContext = { runRelease: new Date().toISOString() };
    renderScreen();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.getByText(/Started .* waiting for a runner/)).toBeInTheDocument();
  });

  it("offers no Start on a project whose intake is auto", () => {
    renderScreen();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.getByRole("button", { name: "Run pipeline" })).toBeInTheDocument();
  });

  it("says the policy could not be read rather than hiding the Start in silence", () => {
    policyError = new Error("500 policy read failed");
    renderScreen();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Intake policy could not be read");
  });

  it("offers no Start once the issue has left Open", () => {
    intake = "manual";
    status = "needs_info";
    renderScreen();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });
});

// Org access without project membership reads; only a member or an admin writes.
describe("the issue header's write actions follow the project role", () => {
  it.each([null, "viewer"])("offers a %s role no Run pipeline, only View pipeline", (r) => {
    role = r;
    renderScreen();
    expect(screen.queryByRole("button", { name: "Run pipeline" })).toBeNull();
    expect(screen.getByRole("button", { name: "View pipeline" })).toBeInTheDocument();
  });

  it.each(["member", "admin"])("offers a %s Run pipeline", (r) => {
    role = r;
    renderScreen();
    expect(screen.getByRole("button", { name: "Run pipeline" })).toBeInTheDocument();
  });
});
