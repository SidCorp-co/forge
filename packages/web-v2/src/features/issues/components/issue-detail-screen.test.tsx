// @vitest-environment jsdom
//
// ISS-1150 — what the issue says comes first. An empty secondary panel (Steps) is one line, never a
// card that outranks the description, and the attachments sit inside the description rather than
// after it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueDetailScreen } from "./issue-detail-screen";

expect.extend(matchers);

const ok = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

let handoffs: ReturnType<typeof ok> | Record<string, unknown> = ok([]);
let durations: ReturnType<typeof ok> = ok([]);
let attachments: ReturnType<typeof ok> = ok([]);
let pipelineHealth: Record<string, unknown> | undefined;
let status = "open";
let issueOver: Record<string, unknown> = {};
let park: Record<string, unknown> = { state: "ready", park: null };

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
vi.mock("@/features/runs/hooks", () => ({ useResumeRun: () => ({ mutate: vi.fn(), isPending: false }) }));
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
vi.mock("@/lib/api/auth-api", () => ({ getAccessToken: () => "test-token" }));
// The rest of the module stays real, so a read added back to it reaches `fetch` below instead of vanishing into a mock.
vi.mock("../detail-hooks", async (importActual) => ({
  ...(await importActual<typeof import("../detail-hooks")>()),
  useIssue: () => ok({ ...ISSUE, ...issueOver, status, pipelineHealth }),
  useComments: () => ok({ items: [], totalCount: 0 }),
  useActivity: () => ok({ items: [] }),
  useAttachments: () => attachments,
  useStepHandoffs: () => handoffs,
  useStepDurations: () => durations,
  useCreateComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../park", () => ({ useIssuePark: () => park }));
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

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  handoffs = ok([]);
  durations = ok([]);
  attachments = ok([]);
  pipelineHealth = undefined;
  status = "open";
  issueOver = {};
  park = { state: "ready", park: null };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

  it("keeps the header's actions on screen at phone width, on a row of their own", () => {
    renderScreen();
    const actions = screen.getByRole("button", { name: "Open session" }).parentElement;
    for (let el: Element | null = actions; el && el !== document.body; el = el.parentElement) {
      expect(el.className.split(/\s+/), "a bare `hidden` removes it below sm").not.toContain("hidden");
    }
    expect(actions?.className.split(/\s+/)).toContain("basis-full");
    expect(actions?.parentElement?.className.split(/\s+/)).toContain("flex-wrap");
  });

  it("sizes the rail as a clamped share of the grid rather than a fixed column", () => {
    renderScreen();
    const grid = screen.getByText("What the issue says.").closest(".grid");
    expect(grid?.className).toContain("lg:grid-cols-[minmax(0,1fr)_clamp(16rem,32%,22.5rem)]");
    expect(grid?.className).not.toContain("_360px]");
  });
});

// The Comments / Activity region is the page's last section: a flat two-way region under a hairline,
// with nothing standing where a third tab would.
describe("the issue detail's Comments / Activity region", () => {
  it("offers exactly the Comments and Activity tabs", () => {
    renderScreen();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Comments0", "Activity0"]);
    expect(screen.queryByRole("tab", { name: /tasks/i })).toBeNull();
  });

  it("is a flat section under a hairline, not a Card, and keeps its #issue-comments anchor", () => {
    renderScreen();
    const region = document.getElementById("issue-comments") as HTMLElement;
    expect(region).not.toBeNull();
    expect(region.contains(screen.getByRole("tablist"))).toBe(true);
    const classes = region.className.split(/\s+/);
    expect(classes).toContain("border-t");
    for (const card of ["rounded-lg", "shadow-sm", "bg-surface", "border"]) {
      expect(classes, `a Card carries ${card}`).not.toContain(card);
    }
  });

  it("asks core for no task list, on first paint or after switching tabs", async () => {
    renderScreen();
    fireEvent.click(screen.getByRole("tab", { name: /Activity/ }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.filter((u) => /\/tasks(\?|\/|$)/.test(u)), `requests: ${urls.join(", ")}`).toEqual([]);
  });

  it("switches between comments and activity inside the region", () => {
    renderScreen();
    const region = document.getElementById("issue-comments") as HTMLElement;
    expect(within(region).getByText("comments")).toBeInTheDocument();
    fireEvent.click(within(region).getByRole("tab", { name: /Activity/ }));
    expect(within(region).queryByText("comments")).toBeNull();
  });
});

describe("the issue detail's sections and rail", () => {
  it("draws the Properties rail flat: a heading and its rows behind a hairline at lg, no Card", () => {
    renderScreen();
    const rail = screen.getByRole("complementary", { name: "Properties" });
    expect(rail.className.split(/\s+/)).toEqual(expect.arrayContaining(["lg:border-l", "lg:border-line-subtle"]));
    expect(within(rail).getByRole("heading", { name: "Properties" })).toBeInTheDocument();
    expect(rail.querySelector(".shadow-sm, .rounded-lg")).toBeNull();
  });

  it("draws the Description as a flat section under a hairline, ahead of the sections below it", () => {
    issueOver = { acceptanceCriteria: "- [ ] it works" };
    renderScreen();
    const description = screen.getByRole("region", { name: "Description" });
    expect(description.className.split(/\s+/)).toContain("border-t");
    expect(description.className).not.toMatch(/\bshadow-sm\b|\brounded-lg\b|\bbg-surface\b/);
    expect(within(description).getByText("What the issue says.")).toBeInTheDocument();
    expect(precedes(description, screen.getByRole("region", { name: "Acceptance criteria" }))).toBe(true);
  });

  it("draws Steps, Acceptance criteria and the Agent plan as flat sections in that order", () => {
    durations = ok([
      { step: "code", runId: "r1", durationSeconds: 12, costUsd: 0, startedAt: "2026-09-21T11:00:00Z", finishedAt: "2026-09-21T11:00:12Z" },
    ]);
    issueOver = { acceptanceCriteria: "- [ ] it works", plan: "the plan" };
    renderScreen();
    const steps = screen.getByRole("region", { name: "Steps" });
    const criteria = screen.getByRole("region", { name: "Acceptance criteria" });
    const plan = screen.getByRole("button", { name: "Agent plan" }).closest("div.border-t") as HTMLElement;
    for (const section of [steps, criteria, plan]) {
      expect(section.className.split(/\s+/)).toContain("border-t");
      expect(section.className).not.toMatch(/\bshadow-sm\b|\brounded-lg\b|\bbg-surface\b/);
    }
    expect(precedes(steps, criteria)).toBe(true);
    expect(precedes(criteria, plan)).toBe(true);
    expect(precedes(plan, document.getElementById("issue-comments") as HTMLElement)).toBe(true);
  });
});

// ISS-1277 — a job no runner has claimed yet has no session, and the header still reads it as a queued run.
describe("the issue header's run", () => {
  const headerChips = () => screen.getByText("ISS-7").parentElement as HTMLElement;

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

  it("says so above an issue at testing holding an open question blocked on a person", () => {
    status = "testing";
    park = {
      state: "ready",
      park: {
        shape: "question",
        status: "testing",
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
    status = "testing";
    park = { state: "ready", park: null };
    renderScreen();
    expect(screen.queryByText(WAITING_FOR_INFORMATION)).toBeNull();
  });
});
