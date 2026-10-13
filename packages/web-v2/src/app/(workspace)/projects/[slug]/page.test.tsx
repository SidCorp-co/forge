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
let work: Record<string, number>;
let runs: unknown[] | undefined;
let runsError: unknown;
let parked: Record<string, unknown>;
let throughputRows: unknown[];
type Read = "ok" | "pending" | "failed" | "stale";
let projectRunnerRows: unknown[] = [];
let queueRead: Read;
let activeRead: Read;
let durationsRead: Read;
let runnersRead: Read;
let schedulesRead: Read;
const readOfMock = (read: Read, data: unknown, message: string) =>
  read === "pending" ? noQuery : read === "failed" ? failedQuery(message) : { ...noQuery, data };
const failedWithData = (data: unknown, message: string) => ({ ...failedQuery(message), data });
const failedQuery = (message: string) => ({ data: undefined, isLoading: false, isError: true, error: new Error(message) });
const refetch = vi.fn();

function reset() {
  attentionView = view({});
  attentionRead = "read";
  attentionError = null;
  blockers = [];
  work = QUIET_WORK;
  runs = [];
  runsError = null;
  parked = { data: { items: [], totalCount: 0 }, ...settled, isPlaceholderData: false };
  throughputRows = WEEK;
  projectRunnerRows = [];
  queueRead = "ok";
  activeRead = "ok";
  durationsRead = "ok";
  runnersRead = "ok";
  schedulesRead = "ok";
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
vi.mock("@/features/attention/hooks", () => ({
  useAttention: () => ({ view: attentionView, read: attentionRead, error: attentionError, refetch }),
}));
vi.mock("@/features/pipeline/hooks", () => ({
  useProjectRuns: () => ({
    data: runs === undefined ? undefined : { items: runs },
    isLoading: false,
    isError: runsError !== null,
    error: runsError,
  }),
  useStepDurations: () =>
    durationsRead === "pending" ? noQuery : durationsRead === "failed" ? failedQuery("durations down") : { data: [], ...settled },
  useThroughput: () => ({ data: throughputRows, ...settled, refetch: vi.fn() }),
}));
vi.mock("@/features/issues/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/issues/hooks")>()),
  useIssues: () => parked,
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ ...noQuery, data: [{ id: "p1", slug: "pair", name: "Pair" }] }),
  useProjectHealth: () => ({
    ...noQuery,
    data: [{ projectSlug: "pair", blockers, blockersTotal: blockers.length, work, spend24hUsd: 0 }],
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
      "Live runs",
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
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 1, awaitingOutsideBlockers: 0, failedJobs: 0 } }, {
      awaitingInput: [attentionItem(7, ago(2 * 3600))],
    });
    work = { ...BUSY_WORK, blocked_on_person: 1 };
    const { container } = mount();
    expect(shape(container)).toBe("working");
    expect(headline()).toHaveTextContent("2 runs are live and 1 item needs a person.");
    expect(figure("Runs live").getByText(/runners busy/)).toBeInTheDocument();
    expect(figure("Needs you").getByText(/oldest 2h/)).toBeInTheDocument();
  });

  it("gives each waiting row its age chip and the action that clears it", () => {
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 2, awaitingOutsideBlockers: 0, failedJobs: 0 } }, {
      awaitingInput: [attentionItem(7, ago(2 * 3600)), attentionItem(8, ago(5 * DAY))],
    });
    mount();
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(within(list).getAllByTestId("age-chip").map((c) => c.getAttribute("data-band"))).toEqual(["fresh", "stale"]);
    expect(within(list).getAllByRole("button", { name: "Provide info" })).toHaveLength(2);
  });

  it("is degraded by a failed job the response counts though its capped list shows none", () => {
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 0, awaitingOutsideBlockers: 0, failedJobs: 1 } });
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
    expect(screen.getByTestId("degraded-band")).toHaveTextContent("Work is failing — 1 failed job");
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
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 0, awaitingOutsideBlockers: 0, failedJobs: 1 } }, {
      failedJobs: [{ kind: "failed_job", title: "build failed", link: "/projects/pair/issues/d9", since: ago(3 * DAY), issueRef: "ISS-9", projectSlug: "pair" }],
      awaitingInput: [attentionItem(7, ago(112 * DAY))],
    });
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
    const band = screen.getByTestId("degraded-band");
    expect(band).toHaveTextContent("Work is blocked and failing — 1 failed job · 1 item waiting on a person for over 14 days");
    const link = within(band).getByRole("link");
    expect(link).toHaveTextContent("Action needed — oldest item waiting 112d");
    expect(link).toHaveAttribute("href", "/projects/pair/issues/d7");
    expect(within(band).getAllByRole("link")).toHaveLength(1);
    expect(figures()).toBeNull();
  });

  it("is degraded by a run stuck with no job, and offers the pipeline", () => {
    runs = [run({ liveJobs: 0, startedAt: ago(5 * 3600), lastSessionBeatAt: null })];
    mount();
    expect(screen.getByTestId("degraded-band")).toHaveTextContent("1 run stuck with no job running");
    expect(within(screen.getByTestId("degraded-band")).getByRole("link")).toHaveAttribute("href", "/projects/pair/pipeline");
  });

  it("does not degrade on a parked issue aged only from its last write, though its chip shows the 112 days", () => {
    blockers = [{ issueId: "ISS-5", documentId: "d5", status: "on_hold" }];
    parked = {
      data: { items: [{ id: "d5", updatedAt: ago(112 * DAY), waitingOnPersonSince: null }], totalCount: 1 },
      ...settled,
      isPlaceholderData: false,
    };
    work = BUSY_WORK;
    const { container } = mount();
    expect(shape(container)).toBe("working");
    const chip = screen.getByTestId("age-chip");
    expect(chip).toHaveAttribute("data-band", "overdue");
    expect(chip).toHaveTextContent("112d since last write");
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

describe("a project whose reads have not all arrived", () => {
  it("is unread while the runs read is out, and does not say nothing needs anyone", () => {
    runs = undefined;
    const { container } = mount();
    expect(shape(container)).toBe("unread");
    expect(headline()).toHaveTextContent("Reading what is going on…");
    expect(screen.getByTestId("headline-unread")).toHaveTextContent("The project's runs are still being read.");
    expect(figure("Runs live").queryByText("0")).toBeNull();
    expect(screen.queryByText(/Nothing needs anyone/)).toBeNull();
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
  const RUNS_ZEROS = ["none live right now", "nothing waiting on a release decision"];

  it.each([
    ["pending", "The project's runs are still being read."],
    ["failed", "The project's runs could not be read: Gateway Timeout"],
  ] as const)("names the runs read in Live runs and Awaiting release while it is %s, stating no zero", (read, statement) => {
    runs = undefined;
    if (read === "failed") runsError = new Error("Gateway Timeout");
    mount();
    for (const title of ["Live runs", "Awaiting release"]) {
      const section = screen.getByRole("region", { name: title });
      expect(section, title).toHaveTextContent(statement);
      expect(section, title).not.toHaveTextContent(/none live|nothing waiting|no release run/);
    }
    expect(screen.queryByText(/run (has|have) no job running|runs have no job running/)).toBeNull();
    for (const zero of RUNS_ZEROS) expect(screen.queryByText(zero), zero).toBeNull();
  });

  it("names the step-durations read in 7-day spend, not 'none recorded'", () => {
    durationsRead = "failed";
    mount();
    expect(screen.getByRole("region", { name: "7-day spend" })).toHaveTextContent("The 7-day spend could not be read: durations down");
    expect(screen.queryByText("none recorded")).toBeNull();
  });

  it("names the runners read in Runners and in the Runs live caption, not 'none bound' or '0 of 0 runners busy'", () => {
    runnersRead = "pending";
    runs = [run()];
    mount();
    expect(screen.getByRole("region", { name: "Runners" })).toHaveTextContent("The project's runners are still being read.");
    expect(screen.queryByText("none bound")).toBeNull();
    expect(figure("Runs live").getByText("runners not read")).toBeInTheDocument();
    expect(screen.queryByText(/0 of 0 runners busy/)).toBeNull();
  });

  it.each([
    ["queue", "queueRead", "pending", "What the runners are doing is still being read."],
    ["active-runner", "activeRead", "failed", "What the runners are doing could not be read: active runners down"],
  ] as const)("calls no online runner idle or busy while the %s read is out", (_name, which, read, statement) => {
    runnersRead = "ok";
    if (which === "queueRead") queueRead = read;
    else activeRead = read;
    runs = [run()];
    projectRunnerRows = [{ runnerId: "rn1", deviceId: "dv1", deviceName: "box-1", deviceStatus: "online", runnerStatus: "enabled", platform: "linux" }];
    mount();
    const section = screen.getByRole("region", { name: "Runners" });
    expect(section).toHaveTextContent(statement);
    expect(section).toHaveTextContent("activity not read");
    expect(section).not.toHaveTextContent(/\bidle\b|\bbusy\b/);
    expect(figure("Runs live").getByText("1 runners online · activity not read")).toBeInTheDocument();
    expect(figure("Runs live").queryByText(/0 of 1 runners busy/)).toBeNull();
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
    expect(screen.getByRole("region", { name: "Live runs" })).toHaveTextContent("none live right now");
    expect(screen.getByRole("region", { name: "Awaiting release" })).toHaveTextContent("nothing waiting on a release decision");
  });
});

// ISS-1159 round 2 — the page's figures are reconcilable with the counts beside it.
describe("a page whose figures sit beside other counts of the same things", () => {
  it("does not say all caught up under a band a stuck run caused", () => {
    runs = [run({ liveJobs: 0, startedAt: ago(5 * 3600), lastSessionBeatAt: null })];
    const { container } = mount();
    expect(shape(container)).toBe("degraded");
    const list = screen.getByRole("region", { name: "Needs your attention" });
    expect(list).not.toHaveTextContent("All caught up");
    expect(list).toHaveTextContent("What is wrong is named above");
  });

  it("says how many runs are open where the figure counts only those with a job, as the navigation rail counts them", () => {
    runs = [
      run(),
      run({ id: "r2", liveJobs: 0, startedAt: ago(600), lastSessionBeatAt: ago(30) }),
      run({ id: "r3", currentStep: "tested", liveJobs: 0 }),
    ];
    mount();
    expect(figure("Runs live").getByText("1")).toBeInTheDocument();
    expect(figure("Runs live").getByText(/3 runs open in all/)).toBeInTheDocument();
  });

  it("says nothing of open runs where every one has a job", () => {
    runs = [run(), run({ id: "r2" })];
    mount();
    expect(figure("Runs live").queryByText(/open in all/)).toBeNull();
  });

  it("does not count fewer people than Open work counts blocked on one: 2 listed, 5 blocked is 'at least 5'", () => {
    work = BUSY_WORK;
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 2, awaitingOutsideBlockers: 0, failedJobs: 0 } }, {
      awaitingInput: [attentionItem(7, ago(2 * 3600)), attentionItem(8, ago(3 * 3600))],
    });
    mount();
    expect(headline()).toHaveTextContent("At least 5 items need a person.");
    expect(screen.getByText("Showing 2 of at least 5.", { exact: false })).toBeInTheDocument();
    expect(figure("Needs you").getByText(/2 of at least 5$/u)).toBeInTheDocument();
  });

  // The class contract only: jsdom lays nothing out, so where the chip falls at 390px is the judge's read of the running page.
  it("gives each attention row's chip the first-line classes beside its kind and ref, and its title a full-width basis", () => {
    attentionView = view({ pair: { needsReview: 0, awaitingInput: 2, awaitingOutsideBlockers: 0, failedJobs: 0 } }, {
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
  it("says 3 of at least 4 where the viewer's own waiting issue is owed and none of it is listed (j4's F1)", () => {
    blockers = PAIR_BLOCKERS;
    work = { ...BUSY_WORK, blocked_on_person: 4 };
    attentionView = view({
      pair: { needsReview: 0, awaitingInput: 1, awaitingOutsideBlockers: 1, failedJobs: 0 },
    });
    mount();
    const n = figure("Needs you");
    expect(n.getByText("3")).toBeInTheDocument();
    expect(n.getByText(/3 of at least 4$/u)).toBeInTheDocument();
    expect(screen.getByText("Showing 3 of at least 4.", { exact: false })).toBeInTheDocument();
    expect(headline()).toHaveTextContent("At least 4 items need a person.");
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
      attentionView = view({ pair: { needsReview: 0, awaitingInput: 0, awaitingOutsideBlockers: 0, failedJobs: 0 } });
      attentionRead = "failed";
      attentionError = new Error("offline");
      const { container } = mount();
      expect(figure("Needs you").getByText("—")).toBeInTheDocument();
      expect(screen.queryByText("All caught up")).toBeNull();
      expect(shape(container)).toBe("unread");
    });

    it("still says All caught up once the answer is read and holds nothing for this project", () => {
      runs = [run()];
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
