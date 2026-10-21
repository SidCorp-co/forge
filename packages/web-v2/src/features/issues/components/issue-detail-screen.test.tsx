// @vitest-environment jsdom
//
// ISS-1150 — what the issue says comes first. An empty secondary panel (Runs) is one line, never a
// card that outranks the description, and the attachments sit inside the description rather than
// after it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { createQueryClient } from "@/providers/query-provider";
import { markUnreachable, UNREACHABLE_SENTENCE } from "@/lib/api/transport-failure";
import { IssueDetailScreen } from "./issue-detail-screen";

expect.extend(matchers);

const ok = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

let journal: ReturnType<typeof ok> | Record<string, unknown> = ok([]);
let attachments: ReturnType<typeof ok> | Record<string, unknown> = ok([]);
let comments: ReturnType<typeof ok> | Record<string, unknown> = ok({ items: [], totalCount: 0 });
let costRead: ReturnType<typeof ok> | Record<string, unknown> = ok(undefined);
let depsRead: ReturnType<typeof ok> | Record<string, unknown> = ok(undefined);
let pipelineHealth: Record<string, unknown> | undefined;
let status = "open";
let issueOver: Record<string, unknown> = {};
let park: Record<string, unknown> = { state: "ready", park: null };
/** The issue read itself, where a case makes it fail after it answered; null reads it as answering. */
let issueRead: Record<string, unknown> | null = null;
const requestTransition = vi.hoisted(() => vi.fn());

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
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: [{ id: "p1", role: "admin" }] }),
  useProjectsIncludingArchived: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/features/project-settings/hooks", () => ({ useUnarchiveProject: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/features/runs/hooks", () => ({ useResumeRun: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/features/questions/components/decision-panel", () => ({
  DecisionPanel: () => null,
  focusDecisionPanel: vi.fn(),
}));
vi.mock("@/features/shell", () => ({ buildShareLink: (p: string) => p, useRecents: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./awaiting-release-banner", () => ({ AwaitingReleaseBanner: () => null }));
vi.mock("./lease-disagreement-notice", () => ({ LeaseDisagreementNotice: () => null }));
vi.mock("./use-guarded-transition", () => ({
  useGuardedTransition: () => ({ requestTransition, requestParkLeave: vi.fn(), dialog: null, isPending: false }),
}));
vi.mock("./properties-rail", () => ({ PropertiesRail: () => <div>rail</div> }));
vi.mock("./module-picker", () => ({ ModulePicker: () => null }));
vi.mock("./comment-thread", () => ({ CommentThread: () => <div>comments</div> }));
vi.mock("./html-attachment-card", () => ({
  HtmlAttachmentCard: ({ name }: { name: string }) => <div>preview {name}</div>,
}));
vi.mock("@/lib/api/auth-api", () => ({ getAccessToken: () => "test-token" }));
// The rest of the module stays real, so a read added back to it reaches `fetch` below instead of vanishing into a mock.
vi.mock("../detail-hooks", async (importActual) => ({
  ...(await importActual<typeof import("../detail-hooks")>()),
  useIssue: () => ({ ...ok({ ...ISSUE, ...issueOver, status, pipelineHealth }), ...issueRead }),
  useComments: () => comments,
  useActivity: () => ok({ items: [] }),
  useAttachments: () => attachments,
  useRunJournal: () => journal,
  useCreateComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../park", () => ({ useIssuePark: () => park }));
vi.mock("../hooks", () => ({
  useIssueCost: () => costRead,
  useIssueDeps: () => depsRead,
  usePatchIssue: () => ({ mutate: vi.fn(), isPending: false }),
  useProjectMembers: () => ok([]),
  useRunPipelineStep: () => ({ mutate: vi.fn(), isPending: false }),
  useSaveDescription: () => ({ mutate: vi.fn(), isPending: false }),
}));

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <IssueDetailScreen projectId="p1" slug="forge-dev" id="ISS-7" />
    </QueryClientProvider>,
  );
}

/** True when `a` comes before `b` in document order. */
const precedes = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

const fetchMock = vi.fn();
/** What every read a case does not plant answers: the decisions read its own shape, the rest an empty list. */
const answerOther = (url: string) =>
  new Response(String(url).includes("/api/questions") ? JSON.stringify({ questions: [] }) : "[]", {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => answerOther(url));
  vi.stubGlobal("fetch", fetchMock);
  journal = ok([]);
  attachments = ok([]);
  comments = ok({ items: [], totalCount: 0 });
  costRead = ok(undefined);
  depsRead = ok(undefined);
  pipelineHealth = undefined;
  status = "open";
  issueOver = {};
  park = { state: "ready", park: null };
  issueRead = null;
  requestTransition.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the issue detail's main column", () => {
  it("draws an empty Runs panel as one line, not a card with an empty state", () => {
    renderScreen();
    const steps = screen.getByRole("region", { name: "Runs" });
    expect(steps).toHaveTextContent("None yet");
    expect(steps.className).toContain("h-10");
    expect(screen.queryByText("No steps yet")).toBeNull();
  });

  it("puts the description ahead of the Runs panel", () => {
    renderScreen();
    const description = screen.getByText("What the issue says.");
    expect(precedes(description, screen.getByRole("region", { name: "Runs" }))).toBe(true);
  });

  it("keeps a populated Runs section after the description too", () => {
    journal = ok([{ runId: "r1", ordinal: 1, kind: "issue", status: "completed", group: null, startedAt: "2026-09-21T11:00:00Z", finishedAt: "2026-09-21T11:00:12Z", costUsd: null, attempts: [{ phase: "code", attempt: 1, source: "agent", outcome: "ok", startedAt: "2026-09-21T11:00:00Z", endedAt: "2026-09-21T11:00:12Z", durationSeconds: 12, artifact: null, handoff: null, handoffAt: null }] }]);
    renderScreen();
    expect(precedes(screen.getByText("What the issue says."), screen.getByText("code"))).toBe(true);
  });

  it("says the runs could not be loaded rather than that there are none", () => {
    journal = { data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch: vi.fn() };
    renderScreen();
    const runs = screen.getByRole("region", { name: "Runs" });
    expect(runs).toHaveTextContent("Couldn't load");
    expect(runs).not.toHaveTextContent("None yet");
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
    const actions = screen.getByRole("button", { name: "Issue actions" }).closest("[class*='basis-full']");
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

  it("draws Runs, Acceptance criteria and the Agent plan as flat sections in that order", () => {
    journal = ok([{ runId: "r1", ordinal: 1, kind: "issue", status: "completed", group: null, startedAt: "2026-09-21T11:00:00Z", finishedAt: "2026-09-21T11:00:12Z", costUsd: null, attempts: [{ phase: "code", attempt: 1, source: "agent", outcome: "ok", startedAt: "2026-09-21T11:00:00Z", endedAt: "2026-09-21T11:00:12Z", durationSeconds: 12, artifact: null, handoff: null, handoffAt: null }] }]);
    issueOver = { acceptanceCriteria: "- [ ] it works", plan: "the plan" };
    renderScreen();
    const steps = screen.getByRole("region", { name: "Runs" });
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
  const openRun = (over: Record<string, unknown>) =>
    ok([{ runId: "r1", ordinal: 1, kind: "issue", status: "running", group: null, startedAt: "2026-09-05T14:16:00Z", finishedAt: null, costUsd: null, attempts: [], reading: "queued", runningSince: null, ...over }]);

  it("shows an open run whose job is queued as a Queued run chip and offers Pause", () => {
    journal = openRun({ reading: "queued" });
    renderScreen();
    expect(within(headerChips()).getByText("Queued")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Run$/ })).toBeNull();
  });

  // ISS-1228 r9: the chip carried the step and a caption beside it named it again, and at phone width the chip cut it.
  it("names a running step once, in words, in the header", () => {
    issueOver = { agentStatus: "running" };
    pipelineHealth = { stage: "in_progress", activeSession: { id: "s1", status: "running", skill: "forge-code", jobType: "drive" } };
    journal = openRun({ reading: "running", runningSince: "2026-09-05T14:17:00Z" });
    renderScreen();
    const said = headerChips().textContent ?? "";
    expect(said).toContain("Issue work");
    expect(said.split("Issue work").length - 1).toBe(1);
    expect(said).not.toMatch(/forge-code|\bdrive\b/);
  });

  it("shows no run chip and offers Run when the issue has no run", () => {
    pipelineHealth = { stage: "open" };
    renderScreen();
    expect(within(headerChips()).queryByText("Queued")).toBeNull();
    expect(within(headerChips()).queryByText("Running")).toBeNull();
    expect(screen.getByRole("button", { name: "Run" })).toBeInTheDocument();
  });

  // ISS-1228 r20 (judge-62): the header painted Failed beside Run, or Completed, until the journal answered.
  it("shows a placeholder, no run word and no run action, while the run journal is unread", () => {
    issueOver = { agentStatus: "failed" };
    journal = { data: undefined, isLoading: true, isError: false, error: null, refetch: vi.fn() };
    renderScreen();
    expect(within(headerChips()).queryByText(/Failed|Completed|Running|Queued|Held/)).toBeNull();
    expect(screen.getAllByRole("status", { name: "Reading the run" })).toHaveLength(2);
    for (const name of [/^Run$/, "Pause", "Open pipeline"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  // r25 (judge-81, criterion 244): the run's failure sat in the chips above the title, pushing it down.
  const failureRow = () => screen.getByText("ISS-7").closest(".sticky")?.querySelector('[data-header="failure"]') as HTMLElement;

  it("says the run could not be read, and why, on the failure row under the title, with Retry and no run word or run action", () => {
    issueOver = { agentStatus: "completed" };
    const refetch = vi.fn();
    const lost = new TypeError("Failed to fetch");
    markUnreachable(lost);
    journal = { data: undefined, isLoading: false, isError: true, error: lost, refetch };
    renderScreen();
    expect(within(failureRow()).getByText(`The run could not be read. ${UNREACHABLE_SENTENCE}`)).toBeInTheDocument();
    expect(within(headerChips()).queryByText(/could not be read/)).toBeNull();
    expect(within(headerChips()).queryByRole("button", { name: "Retry" })).toBeNull();
    expect(within(headerChips()).queryByText("Completed")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Run$/ })).toBeNull();
    fireEvent.click(within(failureRow()).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("offers Retry for a run read the server refused, and none where it answered 401", () => {
    journal = { data: undefined, isLoading: false, isError: true, error: new ApiError(409, "Try again in a minute.", "X"), refetch: vi.fn() };
    const { unmount } = renderScreen();
    expect(within(failureRow()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    unmount();
    journal = { ...journal, error: new ApiError(401, "Unauthenticated", "UNAUTHENTICATED") };
    renderScreen();
    expect(within(failureRow()).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  // r20 review F2: the Retry lived in the primary action, which a closed issue never reaches.
  it("offers Retry for an unreadable run on a closed issue too", () => {
    issueOver = { status: "closed", mergedAt: "2026-09-05T15:00:00Z" };
    const refetch = vi.fn();
    journal = { data: undefined, isLoading: false, isError: true, error: new Error("boom"), refetch };
    renderScreen();
    fireEvent.click(within(failureRow()).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
  });

  it("draws no failure row while every read the header rests on answers", () => {
    renderScreen();
    expect(failureRow()).toBeNull();
  });

  it("reads a held run Held, never the failed session's verdict, once the journal answers", () => {
    issueOver = { agentStatus: "failed" };
    journal = openRun({ reading: "held", hold: { reason: "all_devices_exhausted", resumesItself: true, recheckAt: null, since: null } });
    renderScreen();
    expect(within(headerChips()).getByText("Held")).toBeInTheDocument();
    expect(within(headerChips()).queryByText("Failed")).toBeNull();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
});

// ISS-1228 r20 (coordinator, 390 scrolled): the comment composer's send row showed through the bar as a ghost
// pill beside the status chip, and the bar met what scrolled under it with no line.
describe("the issue header over scrolled content", () => {
  it("paints a solid background, no see-through blur, and a visible dividing line", () => {
    renderScreen();
    const bar = screen.getByText("ISS-7").closest(".sticky") as HTMLElement;
    const classes = bar.className.split(/\s+/);
    expect(classes).toContain("bg-app");
    expect(classes.filter((c) => c.startsWith("bg-app/") || c.startsWith("backdrop-"))).toEqual([]);
    expect(classes).toContain("border-b");
    expect(classes).toContain("border-line");
  });

  // At 390 the overflow menu wrapped to a row of its own beside Help, Open pipeline and Open session.
  it("shows Help as its icon at phone width, still named Help", () => {
    renderScreen();
    const bar = screen.getByText("ISS-7").closest(".sticky") as HTMLElement;
    const help = within(bar).getByRole("button", { name: "Help" });
    expect(within(help).getByText("Help").className).toContain("max-sm:sr-only");
  });
});

// ISS-1257 — a question marks its issue and leaves its rung alone; ISS-1310 — the banner reads it off the park view.
describe("the issue header at Releasing (ISS-1421)", () => {
  const menuItems = () => screen.queryAllByRole("menuitem").map((el) => el.textContent ?? "");

  it("offers View release for the run carrying it, and no move only a release may make", () => {
    status = "releasing";
    issueOver = { releaseBatchRunId: "run-9" };
    renderScreen();
    expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.getByRole("button", { name: "View release" })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Issue actions"));
    expect(menuItems()).not.toContain("Pause (hold)");
    expect(menuItems()).not.toContain("Reopen");
  });

  it("offers no Pause at Releasing even while a session is live on the issue", () => {
    status = "releasing";
    issueOver = { releaseBatchRunId: "run-9", agentStatus: "running" };
    pipelineHealth = { stage: "releasing", activeSession: { id: "s1", status: "running", skill: "forge-code", jobType: "drive" } };
    renderScreen();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });
});

describe("the issue header at Awaiting release (ISS-1421)", () => {
  const menuItem = (name: string) => screen.queryAllByRole("menuitem").find((el) => el.textContent === name);

  it("puts no Reopen primary in the header, and keeps Reopen in the menu with its meaning", () => {
    status = "awaiting_release";
    renderScreen();
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
    fireEvent.click(screen.getByLabelText("Issue actions"));
    fireEvent.click(menuItem("Reopen") as Element);
    expect(requestTransition).toHaveBeenCalledWith(ISSUE.id, "reopen", expect.anything());
    expect(menuItem("Pause (hold)")).toBeUndefined();
  });

  it("still offers Reopen as the primary on a closed issue", () => {
    status = "closed";
    renderScreen();
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });
});

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

// ISS-1228 round 22 (judge-71, criteria 223–225): a holds read that had never answered went back to
// pending on every poll, and the page read pending as "holds nothing": the header opened the newest
// run's session between retries and the failure sentence dropped out.
describe("which session holds the issue, while it cannot be read", () => {
  const SESSION_RUN = [
    { runId: "r1", ordinal: 1, kind: "issue", status: "running", group: null, startedAt: "2026-09-05T14:16:00Z",
      finishedAt: null, costUsd: null, sessionId: "s-run", attempts: [], reading: "running", runningSince: null },
  ];
  let holds: "fail" | "hang" | "answer" | "refuse" | "forbid" | "missing" = "fail";
  /** A request in flight that has had no answer yet; the browser gives up on it in its own time. */
  const pending: Array<() => void> = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    holds = "fail";
    pending.length = 0;
    journal = ok(SESSION_RUN);
    fetchMock.mockImplementation(async (url: string) => {
      if (!String(url).includes("sessions-and-holds")) return answerOther(url);
      if (holds === "fail") throw new TypeError("Failed to fetch");
      if (holds === "refuse") {
        const refused = { code: "HOLDS_READ_REFUSED", message: "The holds could not be read while a migration holds the table. Try again in a minute." };
        return new Response(JSON.stringify(refused), { status: 409, headers: { "content-type": "application/json" } });
      }
      if (holds === "forbid" || holds === "missing") {
        const [status, code, message] = holds === "forbid" ? [403, "FORBIDDEN", "Not a project member."] : [404, "NOT_FOUND", "Project not found."];
        return new Response(JSON.stringify({ code, message }), { status, headers: { "content-type": "application/json" } });
      }
      if (holds === "hang") {
        return new Promise<Response>((_, reject) => pending.push(() => reject(new TypeError("Failed to fetch"))));
      }
      return json({ readAt: "2026-09-05T14:20:00Z", sessions: [], holds: [
        { issueId: ISSUE.id, displayId: "ISS-7", title: ISSUE.title, status: "in_progress",
          holders: [{ by: "session", sessionId: "s-holder", since: "2026-09-05T14:16:00Z" }] },
      ] });
    });
  });

  function renderLive() {
    const qc = createQueryClient();
    qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false } });
    render(
      <QueryClientProvider client={qc}>
        <IssueDetailScreen projectId="p1" slug="forge-dev" id="ISS-7" />
      </QueryClientProvider>,
    );
    return qc;
  }
  const header = () => screen.getByText("ISS-7").closest(".sticky") as HTMLElement;
  const unread = `Its session could not be read. ${UNREACHABLE_SENTENCE}`;
  const poll = async (qc: QueryClient) => {
    await act(async () => {
      void qc.invalidateQueries({ queryKey: ["sessions-and-holds"] });
      await new Promise((r) => setTimeout(r, 0));
    });
  };

  // Round 23 (master's read of the r23 after-shots): a refused read said to try again with no Retry.
  it("offers Retry when the read is refused", async () => {
    holds = "refuse";
    renderLive();
    expect(await within(header()).findByText(/Its session could not be read\. .*Try again in a minute\./)).toBeInTheDocument();
    expect(within(header()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  // Round 24 (judge-78, criterion 226): a refusal read "You do not have access to this resource." or
  // "Not found." in place of the sentence Forge sent; and the line sat in the action toolbar.
  it.each([
    ["forbid", "Not a project member."],
  ] as const)("says the server's own sentence when the read is refused (%s), under the actions", async (refusal, said) => {
    holds = refusal;
    renderLive();
    const line = await within(header()).findByText(`Its session could not be read. ${said}`);
    expect(line.closest('[data-header="failure"]')).not.toBeNull();
    expect(line.closest('[data-header="actions"]')).toBeNull();
    expect(within(header()).queryByText(/You do not have access to this resource|Not found\./)).toBeNull();
  });

  it("opens no session while the read has not answered", () => {
    holds = "hang";
    renderLive();
    expect(within(header()).queryByRole("link", { name: "Open session" })).toBeNull();
  });

  it("keeps saying it could not be read, and why, across two polls, and opens no other session", async () => {
    const qc = renderLive();
    expect(await within(header()).findByText(unread)).toBeInTheDocument();
    const stillUnread = () => {
      expect(within(header()).getByText(unread)).toBeInTheDocument();
      expect(within(header()).queryByRole("link", { name: "Open session" })).toBeNull();
    };
    for (let n = 0; n < 2; n++) {
      // The poll's request is in flight: the read has still not answered.
      holds = "hang";
      await poll(qc);
      stillUnread();
      // It fails as well.
      await act(async () => {
        pending.shift()?.();
        await new Promise((r) => setTimeout(r, 0));
      });
      stillUnread();
    }
    holds = "answer";
    await poll(qc);
    const open = await within(header()).findByRole("link", { name: "Open session" });
    expect(open).toHaveAttribute("href", "/projects/forge-dev/agents/s-holder");
    expect(within(header()).queryByText(unread)).toBeNull();
  });

  // Round 25 (judge-81, criteria 244 and 248): with both reads failing the header said one above the
  // title and one below the actions, each with its own Retry.
  it("says the run and its session on one row under the actions, with one Retry that reads both again", async () => {
    holds = "forbid";
    const refetchRun = vi.fn();
    journal = { data: undefined, isLoading: false, isError: true, error: new ApiError(403, "Not a project member.", "FORBIDDEN"), refetch: refetchRun };
    renderLive();
    const line = await within(header()).findByText("The run and its session could not be read. Not a project member.");
    expect(line.closest('[data-header="failure"]')).not.toBeNull();
    expect(within(header()).getAllByText(/could not be read/)).toHaveLength(1);
    expect(within(header()).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    const asked = fetchMock.mock.calls.filter(([url]) => String(url).includes("sessions-and-holds")).length;
    await act(async () => {
      fireEvent.click(within(header()).getByRole("button", { name: "Retry" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(refetchRun).toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("sessions-and-holds")).length).toBe(asked + 1);
  });

  it("names each reason once where the two reads failed for different reasons", async () => {
    holds = "fail";
    journal = { data: undefined, isLoading: false, isError: true, error: new ApiError(429, "Too many reads from this account. Try again in a minute.", "RATE_LIMITED"), refetch: vi.fn() };
    renderLive();
    expect(
      await within(header()).findByText(
        `The run could not be read. Too many reads from this account. Try again in a minute. Its session could not be read. ${UNREACHABLE_SENTENCE}`,
      ),
    ).toBeInTheDocument();
    expect(within(header()).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });

  // Round 25 (master's read of judge-81's shots, criterion 252): "Agent running · Heartbeat alive"
  // stayed under a header saying the run and its session could not be read.
  it.each([
    ["the session read", () => { holds = "forbid"; }],
    ["the run read", () => {
      holds = "answer";
      journal = { data: undefined, isLoading: false, isError: true, error: new ApiError(403, "Not a project member.", "FORBIDDEN"), refetch: vi.fn() };
    }],
  ])("draws no agent card claiming a live agent while %s has failed", async (_name, fail) => {
    status = "in_progress";
    issueOver = { agentSessions: [{ id: "s-run", status: "running", skill: "forge-code", startedAt: "2026-09-05T14:16:00Z", lastHeartbeatAt: new Date().toISOString() }] };
    fail();
    renderLive();
    await within(header()).findByText(/could not be read/);
    expect(screen.queryByText(/Agent (running|queued)/)).toBeNull();
    expect(screen.queryByText("Heartbeat alive")).toBeNull();
  });

  it("draws the agent card once both reads answer", async () => {
    status = "in_progress";
    holds = "answer";
    issueOver = { agentSessions: [{ id: "s-run", status: "running", skill: "forge-code", startedAt: "2026-09-05T14:16:00Z", lastHeartbeatAt: new Date().toISOString() }] };
    renderLive();
    expect(await screen.findByText("Agent running")).toBeInTheDocument();
  });

  // Judge-83 (244, 248, 252): once answered, a failed run read still read "Running · Issue work" with
  // Pause and the agent card, and a removed member's Retry re-asked the session read alone.
  const READ_AT = new Date(2026, 9, 21, 14, 2).getTime();
  const refused = new ApiError(403, "Not a project member.", "FORBIDDEN");
  const LIVE = { agentSessions: [{ id: "s-run", status: "running", skill: "forge-code", startedAt: "2026-09-05T14:16:00Z", lastHeartbeatAt: new Date().toISOString() }] };
  const staleRun = (refetch = vi.fn()) => ({ data: SESSION_RUN, dataUpdatedAt: READ_AT, isLoading: false, isError: true, error: refused, refetch });

  it("says a run read that answered and then failed on the failure row, keeps its word as of then, and offers no Pause or agent card", async () => {
    status = "in_progress";
    holds = "answer";
    issueOver = LIVE;
    const refetchRun = vi.fn();
    journal = staleRun(refetchRun);
    renderLive();
    const line = await within(header()).findByText("The run could not be read. Not a project member.");
    expect(line.closest('[data-header="failure"]')).not.toBeNull();
    expect(within(header()).getByText(/as of 14:02/)).toBeInTheDocument();
    expect(within(header()).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(within(header()).queryByRole("button", { name: "Answer" })).toBeNull();
    expect(within(header()).queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.queryByText(/Agent (running|queued)/)).toBeNull();
    expect(screen.queryByText("Heartbeat alive")).toBeNull();
    fireEvent.click(within(header()).getByRole("button", { name: "Retry" }));
    expect(refetchRun).toHaveBeenCalled();
  });

  it("names both reads on its one row once each answered and then failed, and its one Retry reads both again", async () => {
    status = "in_progress";
    holds = "answer";
    issueOver = LIVE;
    const refetchRun = vi.fn();
    journal = staleRun(refetchRun);
    const qc = renderLive();
    expect(await within(header()).findByRole("link", { name: "Open session" })).toBeInTheDocument();

    holds = "forbid";
    await poll(qc);
    const line = await within(header()).findByText("The run and its session could not be read. Not a project member.");
    expect(line.closest('[data-header="failure"]')).not.toBeNull();
    expect(within(header()).getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(within(header()).queryByRole("link", { name: "Open session" })).toBeNull();
    expect(screen.queryByText(/Agent (running|queued)/)).toBeNull();

    const asked = fetchMock.mock.calls.filter(([url]) => String(url).includes("sessions-and-holds")).length;
    await act(async () => {
      fireEvent.click(within(header()).getByRole("button", { name: "Retry" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(refetchRun).toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("sessions-and-holds")).length).toBe(asked + 1);
  });

  it("keeps the issue as read when its own read fails after it answered, names it on the row and offers no write", async () => {
    status = "in_progress";
    holds = "answer";
    const refetchIssue = vi.fn();
    issueRead = { isError: true, error: refused, dataUpdatedAt: READ_AT, refetch: refetchIssue };
    renderLive();
    expect(await within(header()).findByText("The issue could not be read. Not a project member.")).toBeInTheDocument();
    expect(within(header()).getByText(ISSUE.title)).toBeInTheDocument();
    expect(within(header()).getByText("as of 14:02")).toBeInTheDocument();
    expect(within(header()).queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(within(header()).getByRole("button", { name: "Retry" }));
    expect(refetchIssue).toHaveBeenCalled();
  });

  // Round 27 (judge-85, criteria 254 and 265): the time sat inside the chip's label, which the chip cuts
  // at 28 characters, so "Needs an answer · as of 20:24" read "as of 20…" at 1280 and 390.
  it("shows the whole time a kept run word was read beside its chip, never inside the label the chip cuts", async () => {
    status = "in_progress";
    holds = "answer";
    journal = { ...staleRun(), data: [{ ...SESSION_RUN[0], reading: "asking" }] };
    renderLive();
    await within(header()).findByText("The run could not be read. Not a project member.");
    const word = within(header()).getByText("Needs an answer");
    const time = within(header()).getByText("as of 14:02");
    expect(word.className).toContain("truncate");
    expect(word.contains(time)).toBe(false);
    expect(time.className).not.toContain("truncate");
    expect(time.className).toContain("whitespace-nowrap");
  });

  // Round 27 (judge-85 under 262, criterion 266): the line still said an agent "is working" in the
  // present tense while the header said the run could not be read.
  it("says as of then that an agent was working, while the run read is kept through a failure", async () => {
    status = "in_progress";
    holds = "answer";
    issueOver = { ...LIVE, agentStatus: "running" };
    journal = staleRun();
    renderLive();
    expect(
      await screen.findByText(
        "As of 14:02 an agent was working this issue, so an edit to its description or properties would be overwritten.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/An agent is working this issue/)).toBeNull();
  });

  // Round 27 (judge-85 under 233, criterion 270): access back, the header answered while Cost and
  // Relations kept "Not a project member" until each one's own Retry.
  it("asks Cost and Relations again once the issue read answers after a 403", async () => {
    status = "in_progress";
    holds = "answer";
    const refetchCost = vi.fn();
    const refetchDeps = vi.fn();
    costRead = { data: undefined, isLoading: false, isError: true, error: refused, refetch: refetchCost };
    depsRead = { data: undefined, isLoading: false, isError: true, error: refused, refetch: refetchDeps };
    issueRead = { isError: true, error: refused, dataUpdatedAt: READ_AT, refetch: vi.fn() };
    const qc = createQueryClient();
    qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false } });
    const tree = () => (
      <QueryClientProvider client={qc}>
        <IssueDetailScreen projectId="p1" slug="forge-dev" id="ISS-7" />
      </QueryClientProvider>
    );
    const view = render(tree());
    await within(header()).findByText(/The issue could not be read/);
    expect(refetchCost).not.toHaveBeenCalled();

    issueRead = null;
    view.rerender(tree());
    expect(refetchCost).toHaveBeenCalledWith({ cancelRefetch: false });
    expect(refetchDeps).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  // Criterion 257: a deleted project's page spoke of its session beside a Running chip and Pause.
  it("says the project was not found, for the page and with nothing to act on, when its holds read answers 404", async () => {
    status = "in_progress";
    holds = "missing";
    renderLive();
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
    expect(screen.getByText("This project doesn't exist or you don't have access to it.")).toBeInTheDocument();
    expect(screen.queryByText("ISS-7")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

// ISS-1228 r26 (criterion 233): a refresh that failed after it answered replaced what the section showed.
describe("a section of the issue page whose refresh fails after it answered", () => {
  const READ_AT = new Date(2026, 9, 21, 14, 2).getTime();
  const lost = (data: unknown, refetch = vi.fn()) => ({ data, dataUpdatedAt: READ_AT, isLoading: false, isError: true, error: new ApiError(503, "Forge is restarting.", "UNAVAILABLE"), refetch });
  const RUN = { runId: "r1", ordinal: 1, kind: "issue", status: "completed", group: null, startedAt: "2026-09-21T11:00:00Z", finishedAt: "2026-09-21T11:00:12Z", costUsd: null, attempts: [{ phase: "code", attempt: 1, source: "agent", outcome: "ok", startedAt: "2026-09-21T11:00:00Z", endedAt: "2026-09-21T11:00:12Z", durationSeconds: 12, artifact: null, handoff: null, handoffAt: null }] };

  it.each([
    ["Runs", () => { journal = lost([RUN]); }, () => screen.getByText("code"), ""],
    ["the comment thread", () => { comments = lost({ items: [], totalCount: 0 }); }, () => screen.getByText("comments"), ""],
    // Round 27 (criterion 269): under Description the line names what it is about.
    ["the attachments", () => { attachments = lost([{ id: "a1", name: "trace.txt", mime: "text/plain", size: 10, url: "/x", createdAt: "2026-09-21T11:00:00Z" }]); }, () => screen.getByText("trace.txt"), "Attachments: "],
  ])("keeps %s as it was read, with a line saying when and Retry", (_name, fail, kept, about) => {
    fail();
    renderScreen();
    expect(kept()).toBeInTheDocument();
    const line = screen.getByText(new RegExp(`^${about}Could not refresh — showing what was read at 14:02\\. `));
    expect(line).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load/)).toBeNull();
  });
});

// Criteria 260 and 262: one lock line, and no hairline dividing nothing.
describe("the issue page's main column with an agent on the issue", () => {
  it("says once that an edit would be overwritten, not beside Description again", () => {
    status = "in_progress";
    issueOver = { agentStatus: "running" };
    renderScreen();
    expect(screen.getAllByText(/would be overwritten/)).toHaveLength(1);
    expect(screen.getByText("An agent is working this issue, so an edit to its description or properties now would be overwritten.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("draws no hairline above the section that comes first under the header", () => {
    renderScreen();
    const description = screen.getByRole("region", { name: "Description" });
    const column = description.parentElement as HTMLElement;
    expect(column.querySelector(":scope > section")).toBe(description);
    expect(column.className).toContain("[&>section:first-child]:border-t-0");
  });
});
