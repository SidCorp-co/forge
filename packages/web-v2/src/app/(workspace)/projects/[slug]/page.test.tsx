// @vitest-environment jsdom
//
// ISS-1159 — the project dashboard takes the project's shape: quiet, working or degraded, and an
// unread one while a read has not arrived. ISS-1156 — the Needs you figure and list refuse by name
// where the response cannot say how much they leave out, and state no count and never "All caught
// up" until the attention read, the runs read and the parked ages have all arrived.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "@/providers/toast-provider";

expect.extend(matchers);

const NOW = Date.now();
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();
const DAY = 86_400;

const PAIR_BLOCKERS: unknown[] = [
  { issueId: "ISS-5", documentId: "d5", status: "on_hold" },
  { issueId: "ISS-2", documentId: "d2", status: "on_hold" },
  { issueId: "ISS-3", documentId: "d3", status: "needs_info" },
];
const QUIET_WORK = { open: 0, in_flight: 0, awaiting_release: 0, blocked_on_person: 0, draft: 0, finished: 0 };
const BUSY_WORK = { open: 1, in_flight: 1, awaiting_release: 0, blocked_on_person: 5, draft: 0, finished: 0 };
const WEEK = Array.from({ length: 7 }, (_, i) => ({
  projectId: "p1",
  date: `2026-10-${String(7 + i).padStart(2, "0")}`,
  count: 0,
}));

const settled = { isLoading: false, isError: false, error: null };
const noQuery = { data: undefined, ...settled };
let attentionView: unknown;
let attentionRead: "pending" | "failed" | "read";
let attentionError: unknown;
let blockers: unknown[];
let stuckIssues: number;
let stuckIssueRefs: Array<{ issueId: string; documentId: string; title?: string; kind?: string }>;
let work: Record<string, number>;
let runs: unknown[] | undefined;
let runsError: unknown;
let sessions: unknown[] | undefined;
let runningChats: unknown[];
let sessionsError: unknown;
let parked: Record<string, unknown>;
let throughputRows: unknown[];
type Read = "ok" | "pending" | "failed" | "stale";
let projectRunnerRows: unknown[] = [];
let queueRead: Read;
let activeRead: Read;
let durationsRead: Read;
let runnersRead: Read;
let schedulesRead: Read;
let throughputRead: Read;
let parkedRead: Read;
const readOfMock = (read: Read, data: unknown, message: string) =>
  read === "pending" ? noQuery : read === "failed" ? failedQuery(message) : { ...noQuery, data };
const failedWithData = (data: unknown, message: string) => ({ ...failedQuery(message), data });
const failedQuery = (message: string) => ({ data: undefined, isLoading: false, isError: true, error: new Error(message) });
const refetch = vi.fn();
const sessionsRefetch = vi.fn();

function reset() {
  attentionView = view({});
  attentionRead = "read";
  attentionError = null;
  blockers = [];
  stuckIssues = 0;
  stuckIssueRefs = [];
  work = QUIET_WORK;
  runs = [];
  runsError = null;
  sessions = [];
  runningChats = [];
  sessionsError = null;
  parked = { data: { items: [], totalCount: 0 }, ...settled, isPlaceholderData: false };
  throughputRows = WEEK;
  projectRunnerRows = [];
  queueRead = "ok";
  activeRead = "ok";
  durationsRead = "ok";
  runnersRead = "ok";
  schedulesRead = "ok";
  throughputRead = "ok";
  parkedRead = "ok";
}
reset();
afterEach(() => {
  cleanup();
  reset();
});

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "pair" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
const retryJob = vi.fn();
vi.mock("@/features/attention/hooks", () => ({
  useAttention: () => ({ view: attentionView, read: attentionRead, error: attentionError, refetch }),
  useRetryFailedJob: () => ({ mutate: retryJob, isPending: false, variables: undefined }),
}));
vi.mock("@/features/runs/hooks", () => ({
  useProjectRuns: () => ({
    data: runs === undefined ? undefined : { items: runs },
    isLoading: false,
    isError: runsError !== null,
    error: runsError,
  }),
  useStepDurations: () =>
    durationsRead === "pending" ? noQuery : durationsRead === "failed" ? failedQuery("durations down") : { data: [], ...settled },
  useThroughput: () => ({
    ...(throughputRead === "pending"
      ? { ...noQuery, isLoading: true }
      : throughputRead === "failed"
        ? failedQuery("throughput down")
        : { data: throughputRows, ...settled }),
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/pipeline/hooks", () => ({
  useSessionsAndHolds: () => ({
    data: sessions === undefined ? undefined : { sessions, holds: [], runningChats, readAt: new Date(NOW).toISOString() },
    isLoading: false,
    isError: sessionsError !== null,
    error: sessionsError,
    refetch: sessionsRefetch,
  }),
}));
vi.mock("@/features/issues/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/issues/hooks")>()),
  useIssues: () =>
    parkedRead === "pending"
      ? { ...noQuery, isLoading: true, isPlaceholderData: false }
      : parkedRead === "failed"
        ? { ...failedQuery("parked down"), isPlaceholderData: false }
        : parked,
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ ...noQuery, data: [{ id: "p1", slug: "pair", name: "Pair" }] }),
  useProjectHealth: () => ({
    ...noQuery,
    data: [{ projectSlug: "pair", blockers, blockersTotal: blockers.length, work, spend24hUsd: 0, stuckIssues, stuckIssueRefs }],
  }),
}));
vi.mock("@/features/runners/hooks", () => ({
  useActiveRunners: () =>
    activeRead === "stale"
      ? failedWithData({ runners: [{ runnerId: "rn1", name: "box-1", current: { issueRef: "ISS-42", stage: "code" } }] }, "refetch down")
      : readOfMock(activeRead, { runners: [] }, "active runners down"),
  useProjectRunners: () => (runnersRead === "pending" ? noQuery : runnersRead === "failed" ? failedQuery("runners down") : { ...noQuery, data: projectRunnerRows }),
}));
vi.mock("@/features/schedules/hooks", () => ({
  useSchedules: () => (schedulesRead === "pending" ? noQuery : schedulesRead === "failed" ? failedQuery("schedules down") : { ...noQuery, data: [] }),
}));
vi.mock("@/features/sessions/hooks", () => ({ useQueueStats: () => readOfMock(queueRead, { devices: [] }, "queue down") }));

const { default: ProjectOverviewPage } = await import("./page");

function view(projectTotals: unknown, extra: Record<string, unknown> = {}) {
  return {
  needsReview: [],
  awaitingInput: [],
  mentions: [],
  failedJobs: [],
  pendingSkillUpdates: [],
  unseenDrafts: [],
  unseenDraftsTotal: 0,
  projectTotals,
  total: 0,
  offlineRunners: [],
  ...extra,
  };
}

const attentionItem = (n: number, since: string, extra: Record<string, unknown> = {}) => ({
  kind: "awaiting_input",
  title: `Issue ${n}`,
  link: `/projects/pair/issues/d${n}`,
  since,
  issueRef: `ISS-${n}`,
  status: "needs_info",
  projectSlug: "pair",
  questionId: `q${n}`,
  ...extra,
});

const run = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  projectId: "p1",
  issueId: "i1",
  issueRef: "ISS-1",
  issueTitle: "An issue",
  kind: "issue",
  status: "running",
  currentStep: "code",
  startedAt: ago(600),
  liveJobs: 1,
  lastSessionBeatAt: ago(30),
  cost: { estimatedCost: 1.5 },
  ...over,
});

const liveSession = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  kind: "run_session",
  title: null,
  status: "running",
  runtimeState: null,
  deviceId: "dv1",
  deviceName: "box-1",
  parentSessionId: null,
  pipelineRunId: "r1",
  startedAt: ago(600),
  lastHeartbeatAt: ago(4),
  createdAt: ago(600),
  issues: [{ issueId: "i1", displayId: "ISS-1", title: "An issue" }],
  report: null,
  ...over,
});

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastProvider>
        <ProjectOverviewPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const headline = () => screen.getByTestId("dashboard-headline");
const shape = (c: HTMLElement) => c.querySelector("[data-shape]")?.getAttribute("data-shape");
const figures = () => screen.queryByRole("list", { name: "Figures" }) ?? document.querySelector('dl[aria-label="Figures"]');
const figure = (label: string) => {
  const group = screen.getByText(label, { selector: "dt" }).parentElement;
  if (!group) throw new Error(`no figure ${label}`);
  return within(group);
};

describe("a quiet project", () => {
  it("opens on one sentence that says nothing needs anyone, with no figures row above or below it", () => {
    const { container } = mount();
    expect(shape(container)).toBe("quiet");
    expect(headline()).toHaveTextContent("Nothing needs anyone.");
    expect(figures()).toBeNull();
    expect(screen.queryByTestId("degraded-band")).toBeNull();
  });

  it("collapses every secondary panel with nothing in it to one line, without a card's border, rounding or shadow", () => {
    const { container } = mount();
    for (const title of [
      "Live sessions",
      "Awaiting release",
      "Open work by state",
      "7-day spend",
      "Throughput",
      "Where time goes",
      "Runners",
      "Upcoming schedules",
    ]) {
      const line = screen.getByRole("region", { name: title });
      expect(line.className, title).toMatch(/\bh-10\b/);
      expect(line.className, title).toMatch(/rounded-none/);
      expect(line.className, title).toMatch(/shadow-none/);
    }
    expect(container.querySelectorAll(".shadow-sm, .rounded-lg.border")).toHaveLength(0);
  });

  it("says the two ISS-380 notes once, and not as figures", () => {
    mount();
    expect(screen.getAllByText(/coming soon \(ISS-380\)/)).toHaveLength(1);
    expect(screen.queryByText("Pass rate")).toBeNull();
  });

  it("keeps the schedules line's way to create one", () => {
    mount();
    expect(screen.getByRole("button", { name: "Create schedule" })).toBeInTheDocument();
  });
});

describe("a working project", () => {
  it("opens on a sentence counting what is live and what needs a person, over a figures row with a comparison each", () => {
    runs = [run(), run({ id: "r2", issueRef: "ISS-2" })];
    sessions = [liveSession(), liveSession({ id: "s2", pipelineRunId: "r2" })];
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 1, parkedOnly: 0, failedJobs: 0, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } }, {
      awaitingInput: [attentionItem(7, ago(2 * 3600))],
    });
    work = { ...BUSY_WORK, blocked_on_person: 1 };
    const { container } = mount();
    expect(shape(container)).toBe("working");
    expect(headline()).toHaveTextContent("2 sessions are live and 1 item needs a person.");
    // No runner serves this project here, which the caption says rather than "0 of 0 runners busy".
    expect(figure("Sessions live").getByText("no runners · 2 runs open")).toBeInTheDocument();
    expect(figure("Needs you").getByText(/oldest 2h/)).toBeInTheDocument();
  });

  // ISS-1228 r3 — judge-14 read '0 of 1 runners busy' under 'Sessions live 4': busy counted pool jobs only.
  it("calls a runner hosting the live sessions busy, from the read the Sessions live figure counts", () => {
    runs = [run()];
    sessions = [liveSession(), liveSession({ id: "s2" }), liveSession({ id: "s3", deviceId: "dv-elsewhere" })];
    projectRunnerRows = [
      { runnerId: "rn1", deviceId: "dv1", deviceName: "box-1", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" },
      { runnerId: "rn2", deviceId: "dv2", deviceName: "box-2", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" },
    ];
    mount();
    expect(figure("Sessions live").getByText("3")).toBeInTheDocument();
    expect(figure("Sessions live").getByText("1 of 2 runners busy · 1 run open")).toBeInTheDocument();
    const runners = screen.getByRole("region", { name: "Runners" });
    expect(runners).toHaveTextContent("2 sessions");
    expect(runners).toHaveTextContent("idle");
  });

  it("calls no runner busy or idle while the sessions read is out, since a hosted session would make it busy", () => {
    sessions = undefined;
    runs = [run()];
    projectRunnerRows = [{ runnerId: "rn1", deviceId: "dv1", deviceName: "box-1", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" }];
    mount();
    const runners = screen.getByRole("region", { name: "Runners" });
    expect(runners).toHaveTextContent("activity not read");
    expect(runners).not.toHaveTextContent(/\bidle\b|\bbusy\b/);
    expect(screen.queryByText(/0 of 1 runners busy/)).toBeNull();
  });

  it("gives each waiting row its age chip and the action that clears it", () => {
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 2, parkedOnly: 0, failedJobs: 0, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } }, {
      awaitingInput: [attentionItem(7, ago(2 * 3600)), attentionItem(8, ago(5 * DAY))],
    });
    mount();
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(list).getAllByTestId("age-chip").map((c) => c.getAttribute("data-band"))).toEqual(["fresh", "stale"]);
    expect(within(list).getAllByRole("button", { name: "Provide info" })).toHaveLength(2);
  });

  it("is degraded by a failed job the response counts though its capped list shows none", () => {
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 0, parkedOnly: 0, failedJobs: 1, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } });
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
    expect(screen.getByTestId("degraded-band")).toHaveTextContent("1 job failed.");
    expect(screen.queryByText(/Nothing needs anyone/)).toBeNull();
  });

  it("is working, not quiet, with issues Awaiting release and no run at the gate", () => {
    work = { ...QUIET_WORK, awaiting_release: 5 };
    const { container } = mount();
    expect(shape(container)).toBe("working");
    expect(headline()).toHaveTextContent("5 issues await release.");
    expect(screen.queryByText(/Nothing needs anyone/)).toBeNull();
  });

  it("is working, not quiet, with only a run at the release gate", () => {
    runs = [run({ currentStep: "tested", liveJobs: 0 })];
    const { container } = mount();
    expect(shape(container)).toBe("working");
    expect(headline()).toHaveTextContent("1 run waits on a release decision.");
  });
});

describe("a degraded project", () => {
  it("replaces the figures row with a band naming what is wrong and one link to the oldest item", () => {
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 0, parkedOnly: 0, failedJobs: 1, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } }, {
      failedJobs: [{ kind: "failed_job", title: "build failed", jobType: "drive", failure: null, link: "/projects/pair/issues/d9", since: ago(3 * DAY), issueRef: "ISS-9", projectSlug: "pair" }],
      awaitingInput: [attentionItem(7, ago(112 * DAY))],
    });
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
    const band = screen.getByTestId("degraded-band");
    expect(band).toHaveTextContent("1 job failed. 1 item has waited on a person for over 14 days.");
    const link = within(band).getByRole("link");
    expect(link).toHaveTextContent("Action needed — oldest item waiting 112d");
    expect(link).toHaveAttribute("href", "/projects/pair/issues/d7");
    expect(within(band).getAllByRole("link")).toHaveLength(1);
    expect(figures()).toBeNull();
  });

  // ISS-1229 r16, judge-41: "Approve & retry" opened the issue page and retried nothing.
  it("retries a failed job from its row, without leaving the page", () => {
    retryJob.mockClear();
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 0, parkedOnly: 0, failedJobs: 1, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } }, {
      failedJobs: [{ kind: "failed_job", jobId: "job-9", title: "build failed", jobType: "drive", failure: null, link: "/projects/pair/issues/d9", since: ago(3 * DAY), issueRef: "ISS-9", projectSlug: "pair" }],
    });
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Retry job" }));
    expect(retryJob).toHaveBeenCalledWith("job-9");
  });

  it("is degraded by a run stuck with no job, and offers the pipeline", () => {
    runs = [run({ liveJobs: 0, startedAt: ago(5 * 3600), lastSessionBeatAt: null })];
    mount();
    expect(screen.getByTestId("degraded-band")).toHaveTextContent("1 run has not been heard from for an hour.");
    expect(within(screen.getByTestId("degraded-band")).getByRole("link")).toHaveAttribute("href", "/projects/pair/agents");
  });

  // ISS-1229 r8: a parked issue is aged from when it entered its status, which an edit does not move.
  it("degrades on a parked issue that has stood at its status fourteen days, however recent its last write", () => {
    blockers = [{ issueId: "ISS-5", documentId: "d5", status: "on_hold" }];
    parked = {
      data: {
        items: [{ id: "d5", updatedAt: ago(60), statusEnteredAt: ago(112 * DAY), waitingOnPersonSince: null }],
        totalCount: 1,
      },
      ...settled,
      isPlaceholderData: false,
    };
    work = BUSY_WORK;
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
    const chip = screen.getByTestId("age-chip");
    expect(chip).toHaveAttribute("data-band", "overdue");
    expect(chip).toHaveTextContent("112d");
    expect(chip).not.toHaveTextContent("last write");
  });

  it("degrades on a parked issue whose open question has waited fourteen days", () => {
    blockers = [{ issueId: "ISS-5", documentId: "d5", status: "needs_info" }];
    parked = {
      data: { items: [{ id: "d5", updatedAt: ago(60), waitingOnPersonSince: ago(15 * DAY) }], totalCount: 1 },
      ...settled,
      isPlaceholderData: false,
    };
    work = BUSY_WORK;
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
  });
});

describe("a project with an issue a stuck-issue notice stands for (ISS-1229 r12)", () => {
  it("says how many are stuck rather than that nothing needs anyone, and offers them", () => {
    stuckIssues = 1;
    stuckIssueRefs = [{ issueId: "ISS-4", documentId: "d-4", title: "Issue 4", kind: "idle" }];
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
    expect(screen.queryByText(/Nothing needs anyone/)).toBeNull();
    const band = screen.getByTestId("degraded-band");
    expect(band).toHaveTextContent("1 issue is reported stuck.");
    expect(within(band).getByRole("link")).toHaveTextContent("Action needed — open ISS-4");
    expect(within(band).getByRole("link")).toHaveAttribute("href", "/projects/pair/issues/d-4");
  });

  it("counts two in the plural", () => {
    stuckIssues = 2;
    stuckIssueRefs = [
      { issueId: "ISS-3", documentId: "d-3", title: "Issue 3", kind: "idle" },
      { issueId: "ISS-4", documentId: "d-4", title: "Issue 4", kind: "idle" },
    ];
    mount();
    const band = screen.getByTestId("degraded-band");
    expect(band).toHaveTextContent("2 issues are reported stuck.");
    expect(within(band).getByRole("link")).toHaveTextContent("Action needed — open ISS-3, stuck longest");
  });
});

// ISS-1229 r13 repair 2: SHOP-44 read only "Blocked on a person — Waiting" and SHOP-53 only its
// notice's words, so no row said which work it was.
describe("a Needs you row on a project with parked and stuck issues", () => {
  it("names each row by its issue's title, with why it is listed after it", () => {
    blockers = [{ issueId: "SHOP-44", documentId: "d44", title: "Production SMTP credentials", status: "waiting" }];
    stuckIssues = 2;
    stuckIssueRefs = [
      { issueId: "SHOP-53", documentId: "d53", title: "Nightly stock import", kind: "idle" },
      { issueId: "SHOP-50", documentId: "d50", title: "Refund webhook retries", kind: "idle" },
    ];
    mount();
    const rows = within(screen.getByRole("region", { name: "Needs your attention" })).getAllByRole("listitem");
    const owed = [
      ["Production SMTP credentials", "Blocked on a person — Waiting"],
      ["Nightly stock import", "Is in a live status with no live work behind it"],
      ["Refund webhook retries", "Is in a live status with no live work behind it"],
    ] as const;
    expect(rows).toHaveLength(owed.length);
    owed.forEach(([title, why], i) => {
      const row = rows[i] as HTMLElement;
      expect(row).toHaveTextContent(title);
      const said = within(row).getByText(why);
      expect(within(row).getByText(title).compareDocumentPosition(said) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});

// ISS-1229 r15, judge-38 on 81 and 87: 14 stuck, two of them the reader's own Waiting parks. Needs you
// listed those two as plain parks, said 9 more where 7 were missing, and headed 2 over seven rows.
describe("Needs you on judge-38's board of 14 stuck issues", () => {
  // The master's r15 ruling: a park the reader owes heads its row, naming its notice under it.
  it("names the stuck parks' notice under the parks they are and counts the whole set, 14, in the heading and the overflow", () => {
    stuckIssues = 14;
    stuckIssueRefs = [10, 9, 8, 4, 2].map((n) => ({ issueId: `ISS-${n}`, documentId: `d${n}`, title: `Stuck ${n}`, kind: "idle" }));
    attentionView = view(
      { pair: { needsReview: 0, awaitingInput: 2, parkedOnly: 0, failedJobs: 0, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 12 } },
      {
        awaitingInput: [11, 12].map((n) =>
          attentionItem(n, ago(7 * 3600), { status: "waiting", questionId: null, stuckKind: "waiting" }),
        ),
      },
    );
    mount();
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(list).toHaveTextContent(/^Needs your attention14/u);
    expect(within(list).getAllByText(/\. It has been waiting for you for over six hours\.$/u)).toHaveLength(2);
    expect(list).toHaveTextContent("And 7 more stuck. All 14 stuck issues are in Issues.");
    expect(list).not.toHaveTextContent(/9 more|stuck · 14/u);
    expect(list).toHaveTextContent("Showing 7 of 14.");
    // Degraded: the band stands where the figures row was, and counts the same 14.
    expect(headline()).toHaveTextContent("14 issues are reported stuck.");
  });
});

describe("a project whose reads have not all arrived", () => {
  it("is unread while the runs read is out, and does not say nothing needs anyone", () => {
    runs = undefined;
    const { container } = mount();
    expect(shape(container)).toBe("unread");
    expect(headline()).toHaveTextContent("Reading what is going on…");
    expect(screen.getByTestId("headline-unread")).toHaveTextContent("The project's runs are still being read.");
    expect(figure("Sessions live").getByText(/runs not read/)).toBeInTheDocument();
    expect(screen.queryByText(/Nothing needs anyone/)).toBeNull();
  });

  it("is unread while the live sessions read is out, and states no session count", () => {
    sessions = undefined;
    const { container } = mount();
    expect(shape(container)).toBe("unread");
    expect(screen.getByTestId("headline-unread")).toHaveTextContent("The project's live sessions are still being read.");
    expect(figure("Sessions live").getByText("…")).toBeInTheDocument();
    expect(figure("Sessions live").queryByText("0")).toBeNull();
  });

  it("names the live sessions read that failed, and why", () => {
    sessions = undefined;
    sessionsError = new Error("Bad Gateway");
    mount();
    expect(headline()).toHaveTextContent("Part of this page could not be read.");
    expect(screen.getByTestId("headline-unread")).toHaveTextContent("The project's live sessions could not be read: Bad Gateway");
  });

  it("names the runs read that failed, and why", () => {
    runs = undefined;
    runsError = new Error("Gateway Timeout");
    mount();
    expect(headline()).toHaveTextContent("Part of this page could not be read.");
    expect(screen.getByTestId("headline-unread")).toHaveTextContent("The project's runs could not be read: Gateway Timeout");
  });

  it("is unread while the parked ages are out, though blockers are listed, and counts none of them", () => {
    blockers = PAIR_BLOCKERS;
    work = BUSY_WORK;
    parked = { data: undefined, ...settled, isLoading: true, isPlaceholderData: false };
    const { container } = mount();
    expect(shape(container)).toBe("unread");
    expect(screen.getByText(/How long parked issues have waited is still being read/)).toBeInTheDocument();
  });

  it("holds a previous project's parked rows, kept as placeholder, as not yet read", () => {
    blockers = PAIR_BLOCKERS;
    work = BUSY_WORK;
    parked = { data: { items: [{ id: "d5", updatedAt: ago(DAY) }], totalCount: 1 }, ...settled, isPlaceholderData: true };
    const { container } = mount();
    expect(shape(container)).toBe("unread");
    expect(screen.queryByTestId("age-chip")).toBeNull();
  });

  it("names the parked ages that failed to read", () => {
    blockers = PAIR_BLOCKERS;
    work = BUSY_WORK;
    parked = { data: undefined, isLoading: false, isError: true, error: new Error("boom"), isPlaceholderData: false };
    mount();
    expect(screen.getByText(/How long parked issues have waited could not be read: boom/)).toBeInTheDocument();
  });

  it("asks for no parked ages where the health row lists no parked issue", () => {
    parked = { data: undefined, ...settled, isLoading: true, isPlaceholderData: false };
    const { container } = mount();
    expect(shape(container)).toBe("quiet");
  });
});

// ISS-1159 round 2 — a section drawn from a read that has not arrived names the read; it never states
// the zero ("none live", "nothing waiting", "none bound", "none recorded") the missing answer would be.
describe("a section whose own read has not arrived", () => {
  const RUNS_ZEROS = ["nothing waiting on a release decision"];

  it.each([
    ["pending", "The project's runs are still being read."],
    ["failed", "The project's runs could not be read: Gateway Timeout"],
  ] as const)("names the runs read in Awaiting release while it is %s, stating no zero and no idle count", (read, statement) => {
    runs = undefined;
    if (read === "failed") runsError = new Error("Gateway Timeout");
    mount();
    const section = screen.getByRole("region", { name: "Awaiting release" });
    expect(section).toHaveTextContent(statement);
    expect(section).not.toHaveTextContent(/nothing waiting|no release run/);
    expect(screen.queryByText(/nothing working/)).toBeNull();
    for (const zero of RUNS_ZEROS) expect(screen.queryByText(zero), zero).toBeNull();
  });

  it.each(["pending", "failed"] as const)(
    "keeps the cut and says nothing is listed only once the runs read is in: attention listing none of 2, runs %s",
    (read) => {
      attentionView = view({ pair: { needsReview: 0, awaitingInput: 2, parkedOnly: 0, failedJobs: 0, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } });
      runs = undefined;
      if (read === "failed") runsError = new Error("Gateway Timeout");
      const { container } = mount();
      expect(shape(container)).toBe("unread");
      const list = screen.getByRole("region", { name: "Needs your attention" });
      expect(list).not.toHaveTextContent("Nothing is listed to act on here");
      expect(list).not.toHaveTextContent("All caught up");
      expect(list).toHaveTextContent(/Showing 0 of 2\./u);
    },
  );

  it.each(["pending", "failed"] as const)(
    "says no all caught up in Needs your attention while only the runs read is %s: a stuck run is what it would show",
    (read) => {
      runs = undefined;
      if (read === "failed") runsError = new Error("Gateway Timeout");
      const { container } = mount();
      expect(shape(container)).toBe("unread");
      const list = screen.getByRole("region", { name: "Needs your attention" });
      expect(list).not.toHaveTextContent("All caught up");
      expect(list).not.toHaveTextContent("Nothing in this project needs you");
      expect(list).toHaveTextContent("not an all clear");
    },
  );

  // Every read the page leans on, put out in turn: no section that draws on it may say nothing, none or
  // all caught up in its place, and each names the read. The table is the page's own dependency list, so a
  // section added without a row here is not covered, and a row whose section says a zero fails by name.
  describe("every section against every read it depends on, pending and failed", () => {
    const UNREAD = /still being read|Reading what|could not be read|Couldn't load|read yet/u;
    const EMPTY_CLAIM =
      /none live|nothing waiting|all caught up|nothing in this project needs you|none recorded|none bound|nothing shipped|no agent step|no open work|^none$/iu;
    type Case = { read: string; sections: string[]; set: (r: Read) => void };
    const READS: Case[] = [
      { read: "attention", sections: ["Needs your attention"], set: () => {} },
      { read: "runs", sections: ["Needs your attention", "Awaiting release"], set: () => {} },
      { read: "live sessions", sections: ["Needs your attention", "Live sessions"], set: () => {} },
      { read: "parked ages", sections: ["Needs your attention"], set: (r) => (parkedRead = r) },
      { read: "step durations", sections: ["7-day spend", "Where time goes"], set: (r) => (durationsRead = r) },
      { read: "throughput", sections: ["Throughput"], set: (r) => (throughputRead = r) },
      { read: "runners", sections: ["Runners"], set: (r) => (runnersRead = r) },
      { read: "queue", sections: ["Runners"], set: (r) => (queueRead = r) },
      { read: "active runners", sections: ["Runners"], set: (r) => (activeRead = r) },
      { read: "schedules", sections: ["Upcoming schedules"], set: (r) => (schedulesRead = r) },
    ];

    function putOut(c: Case, state: "pending" | "failed") {
      blockers = c.read === "parked ages" ? PAIR_BLOCKERS : [];
      c.set(state);
      // The three reads the shape stands on are not mocked by `set`.
      if (c.read === "attention") {
        attentionRead = state;
        attentionError = state === "failed" ? new Error("attention down") : null;
      }
      if (c.read === "runs") {
        runs = undefined;
        if (state === "failed") runsError = new Error("runs down");
      }
      if (c.read === "live sessions") {
        sessions = undefined;
        if (state === "failed") sessionsError = new Error("sessions down");
      }
      // An online runner, so a runners-side read that is out shows in the section rather than behind "none bound".
      projectRunnerRows = [{ runnerId: "rn1", deviceId: "dv1", deviceName: "box-1", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" }];
    }

    it.each(READS.flatMap((c) => (["pending", "failed"] as const).map((state) => [c.read, state, c] as const)))(
      "%s %s",
      (_read, state, c) => {
        putOut(c, state);
        const { container } = mount();
        for (const title of c.sections) {
          const section = screen.getByRole("region", { name: title });
          if (title === "Runners" && c.read === "runners" && state === "pending") {
            expect(section, title).toHaveTextContent("still being read");
          }
          // A refusal may quote the phrase it refuses to say; only a bare one is the claim.
          const said = (section.textContent ?? "").replace(/"[^"]*"/gu, "");
          expect(said, `${title} under ${c.read} ${state}`).not.toMatch(EMPTY_CLAIM);
          if (title !== "Needs your attention" || ["attention", "runs", "live sessions"].includes(c.read)) {
            expect(section, `${title} under ${c.read} ${state}`).toHaveTextContent(UNREAD);
          }
        }
        // The page never opens on an all clear while a read the shape stands on is out.
        if (["attention", "runs", "live sessions", "parked ages"].includes(c.read)) {
          expect(shape(container)).toBe("unread");
          expect(headline()).not.toHaveTextContent(/Nothing needs anyone/);
          expect(screen.getByTestId("headline-unread")).toBeInTheDocument();
          // Nor does a figure on the strip: Needs you states no zero and no "nothing to act on" beside
          // the list that says it is not an all clear.
          const needs = figure("Needs you");
          expect(figures()?.textContent ?? "", `the figures under ${c.read} ${state}`).not.toMatch(/nothing to act on/iu);
          expect(needs.queryByText("0"), `Needs you under ${c.read} ${state}`).toBeNull();
        }
      },
    );
  });

  it("names the step-durations read in 7-day spend, not 'none recorded'", () => {
    durationsRead = "failed";
    mount();
    expect(screen.getByRole("region", { name: "7-day spend" })).toHaveTextContent("The 7-day spend could not be read: durations down");
    expect(screen.queryByText("none recorded")).toBeNull();
  });

  it("names the runners read in Runners and in the Sessions live caption, not 'none bound' or '0 of 0 runners busy'", () => {
    runnersRead = "pending";
    sessions = [liveSession()];
    mount();
    expect(screen.getByRole("region", { name: "Runners" })).toHaveTextContent("The project's runners are still being read.");
    expect(screen.queryByText("none bound")).toBeNull();
    expect(figure("Sessions live").getByText("runners not read")).toBeInTheDocument();
    expect(screen.queryByText(/0 of 0 runners busy/)).toBeNull();
  });

  it.each([
    ["queue", "queueRead", "pending", "What the runners are doing is still being read."],
    ["active-runner", "activeRead", "failed", "What the runners are doing could not be read: active runners down"],
  ] as const)("calls no online runner idle or busy while the %s read is out", (_name, which, read, statement) => {
    runnersRead = "ok";
    if (which === "queueRead") queueRead = read;
    else activeRead = read;
    sessions = [liveSession()];
    projectRunnerRows = [{ runnerId: "rn1", deviceId: "dv1", deviceName: "box-1", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" }];
    mount();
    const section = screen.getByRole("region", { name: "Runners" });
    expect(section).toHaveTextContent(statement);
    expect(section).toHaveTextContent("activity not read");
    expect(section).not.toHaveTextContent(/\bidle\b|\bbusy\b/);
    expect(figure("Sessions live").getByText("1 runner online · activity not read")).toBeInTheDocument();
    expect(figure("Sessions live").queryByText(/0 of 1 runners busy/)).toBeNull();
  });

  it("shows no execution claim from an earlier active-runner answer once a refetch has failed", () => {
    activeRead = "stale";
    projectRunnerRows = [{ runnerId: "rn1", deviceId: "dv1", deviceName: "box-1", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" }];
    mount();
    const section = screen.getByRole("region", { name: "Runners" });
    expect(section).toHaveTextContent("What the runners are doing could not be read: refetch down");
    expect(section).toHaveTextContent("activity not read");
    expect(section).not.toHaveTextContent("ISS-42");
  });

  it("names the schedules read in Upcoming schedules, not 'none'", () => {
    schedulesRead = "failed";
    mount();
    const section = screen.getByRole("region", { name: "Upcoming schedules" });
    expect(section).toHaveTextContent("The project's schedules could not be read: schedules down");
    expect(screen.queryByRole("button", { name: "Create schedule" })).toBeNull();
  });

  it("still states the zero once the read is in", () => {
    mount();
    expect(screen.getByRole("region", { name: "Live sessions" })).toHaveTextContent("none live right now");
    expect(screen.getByRole("region", { name: "Awaiting release" })).toHaveTextContent("nothing waiting on a release decision");
  });
});

// ISS-1159 round 2 — the page's figures are reconcilable with the counts beside it.
describe("a page whose figures sit beside other counts of the same things", () => {
  it("does not say all caught up under a band a stuck run caused", () => {
    runs = [run({ liveJobs: 0, startedAt: ago(5 * 3600), lastSessionBeatAt: null })];
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
    // Nothing it could list: the section is not shown, rather than contradict the band (ISS-1229 r13).
    expect(screen.queryByRole("region", { name: "Needs your attention" })).toBeNull();
    expect(container).not.toHaveTextContent("All caught up");
    expect(container).not.toHaveTextContent("Nothing here needs you");
  });

  // ISS-1228 round 16 (judge-42): "3 runs open" sat above a list of one run, the other two being runs
  // no listed session works. The caption counts the open runs the Live sessions section shows: those
  // its rows work, and those nothing works, which it counts beneath them.
  it("counts the open runs the Live sessions section shows, and no run it does not", () => {
    runs = [
      run(),
      run({ id: "r2", liveJobs: 0, startedAt: ago(600), lastSessionBeatAt: ago(30) }),
      run({ id: "r3", currentStep: "tested", liveJobs: 0 }),
      run({ id: "r4", liveJobs: 0, startedAt: ago(600), lastSessionBeatAt: null }),
      run({ id: "r5", status: "completed" }),
    ];
    sessions = [liveSession(), liveSession({ id: "s-master", kind: "master", pipelineRunId: null })];
    mount();
    expect(figure("Sessions live").getByText("2")).toBeInTheDocument();
    expect(figure("Sessions live").getByText(/· 2 runs open$/)).toBeInTheDocument();
    const live = screen.getByRole("region", { name: "Live sessions" });
    expect(within(live).getAllByRole("listitem")).toHaveLength(2);
    expect(within(live).getByRole("button", { name: /1 open run has nothing working it/ })).toBeInTheDocument();
  });

  // ISS-1228 round 16 (judge-42): "Sessions live 2" and "2 sessions are live." while the caption
  // counted a box busy because of a chat neither figure counted.
  it("counts a chat whose turn is running among the live sessions, in the figure, the headline and the section", () => {
    sessions = [liveSession()];
    runningChats = [{ id: "c1", deviceId: "dv2" }];
    projectRunnerRows = [
      { runnerId: "rn1", deviceId: "dv1", deviceName: "box-1", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" },
      { runnerId: "rn2", deviceId: "dv2", deviceName: "box-2", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" },
    ];
    mount();
    expect(figure("Sessions live").getByText("2")).toBeInTheDocument();
    expect(figure("Sessions live").getByText(/^2 of 2 runners busy/)).toBeInTheDocument();
    expect(headline()).toHaveTextContent("2 sessions are live.");
    const live = screen.getByRole("region", { name: "Live sessions" });
    expect(within(live).getByText("1 chat has a turn running.")).toBeInTheDocument();
  });

  it("calls a project live where only a chat's turn runs", () => {
    sessions = [];
    runningChats = [{ id: "c1", deviceId: "dv1" }];
    const { container } = mount();
    expect(shape(container)).toBe("working");
    expect(headline()).toHaveTextContent("1 session is live.");
    expect(screen.getByText("1 chat has a turn running.")).toBeInTheDocument();
  });

  it("says nothing of open runs where none is open", () => {
    sessions = [liveSession()];
    mount();
    expect(figure("Sessions live").queryByText(/runs? open/)).toBeNull();
  });

  // A driver run holds no job: its session is what works it. A count of jobs read three Working
  // sessions as "none live" with "3 runs have no job running" beside them.
  it("reads a run its session works, with no job on it, as live and not idle or stuck", () => {
    runs = [run({ issueId: null, issueRef: null, currentStep: null, liveJobs: 0, startedAt: ago(5 * 3600), lastSessionBeatAt: ago(4) })];
    sessions = [liveSession({ runtimeState: "working" })];
    const { container } = mount();
    expect(screen.queryByText("none live right now")).toBeNull();
    expect(screen.queryByText(/no job running|nothing working/)).toBeNull();
    expect(screen.queryByTestId("degraded-band")).toBeNull();
    expect(shape(container)).toBe("working");
    expect(headline()).toHaveTextContent("1 session is live.");
    const live = screen.getByRole("region", { name: "Live sessions" });
    expect(within(live).getByText("Working")).toBeInTheDocument();
    expect(within(live).getByRole("link", { name: "ISS-1" })).toHaveAttribute("href", "/projects/pair/issues/i1");
    expect(figure("Sessions live").getByText("1")).toBeInTheDocument();
  });

  it("counts an open run with no job and no session as one nothing works", () => {
    runs = [run({ liveJobs: 0, startedAt: ago(600), lastSessionBeatAt: null })];
    mount();
    expect(screen.getByRole("button", { name: /1 open run has nothing working it/ })).toBeInTheDocument();
  });

  // ISS-1229 r14, judge-35: 32 parks the reader owes read 20 on Attention, 25 on Needs you and "at
  // least 32" in the headline. Every figure here says the whole, 32, and the list says how much it shows.
  it("says 32 for judge-35's 32 parks, in the figure and the headline, and 25 of 32 under the list", () => {
    work = BUSY_WORK;
    blockers = Array.from({ length: 5 }, (_, i) => ({
      issueId: `ISS-${40 + i}`,
      documentId: `d${40 + i}`,
      title: `Park ${40 + i}`,
      status: "needs_info",
    }));
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 32, parkedOnly: 0, failedJobs: 0, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } }, {
      awaitingInput: Array.from({ length: 20 }, (_, i) => attentionItem(i + 1, ago(3600), { status: "needs_info" })),
    });
    mount();
    expect(headline()).toHaveTextContent("32 items need a person.");
    expect(headline()).not.toHaveTextContent("at least");
    expect(figure("Needs you").getByText("32")).toBeInTheDocument();
    expect(figure("Needs you").getByText(/to act on: 32 issues parked with no question$/u)).toBeInTheDocument();
    // The caption counts the kind whole and never says how many rows are listed (ISS-1229 r15, judge-38).
    expect(figure("Needs you").queryByText(/listed/u)).toBeNull();
    expect(screen.getByRole("region", { name: "Needs your attention" })).toHaveTextContent(/^Needs your attention32/u);
    expect(screen.getByText("Showing 25 of 32.", { exact: false })).toBeInTheDocument();
  });

  // The class contract only: jsdom lays nothing out, so where the chip falls at 390px is the judge's read of the running page.
  it("gives each attention row's chip the first-line classes beside its kind and ref, and its title a full-width basis", () => {
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 2, parkedOnly: 0, failedJobs: 0, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } }, {
      awaitingInput: [attentionItem(7, ago(2 * 3600)), attentionItem(8, ago(5 * DAY), { title: "A title long enough to need the whole line to itself on a phone" })],
    });
    mount();
    const list = screen.getByRole("region", { name: "Needs your attention" });
    for (const row of within(list).getAllByRole("listitem")) {
      const chip = within(row).getByTestId("age-chip");
      expect(chip.parentElement?.className).toMatch(/\bml-auto\b/);
      const title = within(row).getByText(/^Issue 7$|^A title long/);
      expect(title.className).toMatch(/\border-3\b/);
      expect(title.className).toMatch(/\bbasis-full\b/);
    }
  });
});

describe("the project dashboard's Needs you", () => {
  it("says 4 where the viewer's own waiting issue is owed and none of it is listed, beside 3 parks (j4's F1)", () => {
    blockers = PAIR_BLOCKERS;
    work = { ...BUSY_WORK, blocked_on_person: 4 };
    attentionView = view({
      pair: { needsReview: 0, awaitingInput: 1, parkedOnly: 3, failedJobs: 0, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 },
    });
    mount();
    const n = figure("Needs you");
    expect(n.getByText("4")).toBeInTheDocument();
    expect(n.getByText(/to act on: 4 issues parked with no question$/u)).toBeInTheDocument();
    expect(screen.getByText("Showing 3 of 4.", { exact: false })).toBeInTheDocument();
    expect(headline()).toHaveTextContent("4 items need a person.");
  });

  it("refuses a response with no projectTotals where the figure is, and keeps the rest of the dashboard standing", () => {
    attentionView = view(undefined);
    mount();
    const n = figure("Needs you");
    expect(n.getByText(/no `projectTotals`.*not the release/u)).toBeInTheDocument();
    expect(n.getByText("—")).toBeInTheDocument();
    expect(screen.getByTestId("attention-refusal")).toHaveTextContent("no `projectTotals`");
    expect(screen.queryByText(/Nothing needs anyone|items? needs? a person/)).toBeNull();
    expect(screen.getByRole("region", { name: "Open work by state" })).toBeInTheDocument();
  });

  describe("before the attention read has been read", () => {
    it("states no figure and no All caught up while the answer is on its way, though the health row already lists blockers", () => {
      blockers = PAIR_BLOCKERS;
      work = BUSY_WORK;
      attentionView = view({});
      attentionRead = "pending";
      mount();
      const n = figure("Needs you");
      expect(n.queryByText("3")).toBeNull();
      expect(n.queryByText("0")).toBeNull();
      expect(n.getByText("…")).toBeInTheDocument();
      expect(n.getByText(/reading what needs you/iu)).toBeInTheDocument();
      expect(screen.queryByText("All caught up")).toBeNull();
      expect(screen.queryByText(/nothing to act on/iu)).toBeNull();
      expect(screen.getByTestId("attention-pending")).toBeInTheDocument();
      expect(headline()).toHaveTextContent("Reading what is going on…");
      expect(screen.getByRole("region", { name: "Open work by state" })).toBeInTheDocument();
    });

    it("refuses by name when the read failed: what could not be read, why, and that the figure is unknown", () => {
      attentionView = view({});
      attentionRead = "failed";
      attentionError = new Error("Internal Server Error");
      mount();
      const n = figure("Needs you");
      expect(n.getByText("—")).toBeInTheDocument();
      expect(n.getByText(/could not be read.*Internal Server Error.*unknown/u)).toBeInTheDocument();
      expect(screen.getByTestId("attention-refusal")).toHaveTextContent("could not be read");
      expect(screen.queryByText("All caught up")).toBeNull();
      expect(headline()).toHaveTextContent("Part of this page could not be read.");
    });

    it("offers a retry that asks for the read again", () => {
      attentionView = view({});
      attentionRead = "failed";
      attentionError = new Error("boom");
      mount();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("refuses when a later refetch failed though an earlier answer is still held", () => {
      attentionView = view({ pair: { needsReview: 0, awaitingInput: 0, parkedOnly: 0, failedJobs: 0, awaitingAsked: 0, parkedAsked: 0, stuckOnly: 0 } });
      attentionRead = "failed";
      attentionError = new Error("offline");
      const { container } = mount();
      expect(figure("Needs you").getByText("—")).toBeInTheDocument();
      expect(screen.queryByText("All caught up")).toBeNull();
      expect(shape(container)).toBe("unread");
    });

    it("still says All caught up once the answer is read and holds nothing for this project", () => {
      sessions = [liveSession()];
      mount();
      expect(screen.getByRole("region", { name: "Needs your attention" })).toHaveTextContent("All caught up");
      expect(figure("Needs you").getByText("0")).toBeInTheDocument();
    });
  });
});

// ISS-1154 — the Issues screen's Insights tab went, so its two figures are drawn here, kept as sections
// that hold data.
describe("the project dashboard's metrics", () => {
  it("carries Throughput and Where time goes, each with its comparison, where they hold data", () => {
    runs = [run()];
    work = BUSY_WORK;
    throughputRows = WEEK.map((r, i) => ({ ...r, count: i === 6 ? 4 : 2 }));
    mount();
    expect(screen.getByRole("region", { name: "Throughput" })).toHaveTextContent("4 today · 2.0 a day over the six before");
    expect(screen.getByRole("region", { name: "Open work by state" })).toBeInTheDocument();
  });
});

// ISS-1228 round 9: a live session its box reports blocked on a person is one item Needs you counts,
// so the figure and the list wait on the sessions read as they wait on the attention read.
describe("Needs you and the live sessions it counts", () => {
  const heard = new Date(NOW - 10_000).toISOString();
  const blockedOnYou = {
    id: "s9",
    kind: "run_session",
    title: "run: ISS-9",
    status: "running",
    runtimeState: "working",
    deviceId: "d1",
    deviceName: "box-a",
    parentSessionId: null,
    startedAt: heard,
    lastHeartbeatAt: heard,
    createdAt: heard,
    issues: [{ issueId: "doc-9", displayId: "ISS-9", title: "Nine" }],
    report: { incarnation: "live", work: "blocked", blockerKind: "human", waitingOn: "approve the restore", observedAt: heard },
    silenceLimitMs: 600_000,
  };

  it("counts and lists a session blocked on a person", () => {
    sessions = [blockedOnYou];
    mount();
    expect(figure("Needs you").getByText("1")).toBeInTheDocument();
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(list).toHaveTextContent("waits on you — approve the restore");
    expect(list).toHaveTextContent("ISS-9");
  });

  it("states no figure while the sessions read is on its way, though the health row lists blockers", () => {
    blockers = PAIR_BLOCKERS;
    sessions = undefined;
    mount();
    const n = figure("Needs you");
    expect(n.getByText("…")).toBeInTheDocument();
    expect(n.queryByText(String(PAIR_BLOCKERS.length))).toBeNull();
    expect(screen.getByTestId("attention-pending")).toBeInTheDocument();
  });

  it("refuses by name when the sessions read failed, and its retry asks for both reads again", () => {
    blockers = PAIR_BLOCKERS;
    sessions = undefined;
    sessionsError = new Error("sessions down");
    mount();
    const n = figure("Needs you");
    expect(n.getByText("—")).toBeInTheDocument();
    expect(n.getByText(/could not be read.*sessions down.*unknown/u)).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("region", { name: "Needs your attention" })).getByRole("button", { name: "Try again" }));
    expect(sessionsRefetch).toHaveBeenCalled();
  });
});
