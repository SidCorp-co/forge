// @vitest-environment jsdom

import type { DevelopmentOverview, OverviewNeed } from "@forge/contracts/development-overview";
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { needHref, needPeekHref } from "../routes";
import { DevelopmentOverviewScreen } from "./development-overview-screen";
import { ticksOf } from "./lease-lanes";
import { ModuleBars } from "./module-bars";
import { needRowView } from "./needs-you";
import { SignalsStrip } from "./signals-strip";
import { StuckChains } from "./stuck-chains";

expect.extend(matchers);
afterEach(cleanup);

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const waiting = (kind: "you" | "run" | "master" | "issue" | "none", who: string, act: string) => ({ kind, who, act, rule: "rule", ref: null });

const NEED_ISSUE: OverviewNeed = {
  kind: "issue",
  key: "ISS-7",
  ref: "ISS-7",
  title: "Weekly outcome export",
  facts: ["reporting", "REQ-12 BC-5"],
  state: { family: "issue", value: "draft", step: null, tone: "you" },
  waitingOn: waiting("you", "You", "take on or drop"),
  owner: { name: "Lan", kind: "human" },
  touchedAt: "2026-10-03T10:00:00.000Z",
};
const NEED_RELEASE: OverviewNeed = {
  kind: "release",
  key: "0.42.2",
  ref: "run-1",
  title: "Release 0.42.2",
  facts: ["Evidence from preview"],
  state: { family: "release", value: "pending" },
  waitingOn: waiting("you", "You", "approve the release"),
  owner: null,
  touchedAt: null,
};
const NEED_CONTRACT: OverviewNeed = {
  kind: "contract",
  key: "hop/dischargeSummary 2.0.0",
  ref: "hop/dischargeSummary@2.0.0",
  title: "hop/dischargeSummary 2.0.0 is proposed",
  facts: ["Measured breaking"],
  state: { family: "classification", value: "breaking" },
  waitingOn: waiting("you", "You", "approve 2.0.0"),
  owner: null,
  touchedAt: null,
};

const DATA = (over: Partial<DevelopmentOverview> = {}): DevelopmentOverview => ({
  generatedAt: "2026-10-03T22:30:00.000Z",
  signals: {
    ci: { available: false, reason: "no check reading for a branch head" },
    postMerge: { available: false, reason: "no post-merge event" },
    contracts: { windows: [{ contract: "autoflow/api", version: "2.0.0", dueAt: "2099-01-01T00:00:00.000Z", feedback: "FB-1" }], openWindows: 1, awaitingApproval: 1 },
    master: { masters: 1, runs: 3, capacity: null, capacityNote: "the runner keeps max_job_panes locally" },
  },
  flow: {
    windowDays: 14,
    total: 6,
    stages: [
      { id: "draft", count: 1, parts: [{ group: "needs_you", count: 1 }] },
      { id: "open", count: 2, parts: [{ group: "queued", count: 2 }] },
      { id: "in_progress", count: 2, parts: [{ group: "moving", count: 2 }] },
      { id: "awaiting_release", count: 0, parts: [] },
      { id: "closed", count: 1, parts: [{ group: "done", count: 1 }] },
    ],
  },
  moving: {
    count: 1,
    window: { from: "2026-10-03T20:00:00.000Z", to: "2026-10-03T23:30:00.000Z", now: "2026-10-03T22:30:00.000Z" },
    lanes: [
      {
        key: "ISS-9",
        title: "Quiet hours",
        status: "in_progress",
        step: "build",
        holder: "claude:iss-9",
        box: "forge-box-1",
        branch: "iss-9",
        segments: [
          { step: "plan", startedAt: "2026-10-03T21:00:00.000Z", endedAt: "2026-10-03T21:40:00.000Z" },
          { step: "build", startedAt: "2026-10-03T21:40:00.000Z", endedAt: null },
        ],
        heldSince: "2026-10-03T21:00:00.000Z",
        lease: { verdict: "live", expiresAt: "2026-10-03T23:00:00.000Z" },
        waitingOn: waiting("run", "Run", "Build · 50 min"),
      },
    ],
  },
  stuck: {
    count: 2,
    chains: [
      {
        id: "contract:autoflow/api@2.0.0",
        held: 1,
        levels: [
          [{ kind: "contract", key: "autoflow/api", title: "Needs 2.0.0; the provider has published 1.4.0", status: null, step: null, tone: null, waitingOn: null, held: false }],
          [{ kind: "issue", key: "ISS-4", title: "Publish", status: "open", step: null, tone: "ready", waitingOn: waiting("master", "Master", "free slot"), held: true }],
        ],
      },
    ],
  },
  modules: {
    rows: [
      { id: "m1", path: "reminders", name: "Reminders", open: 3, parts: [{ group: "moving", count: 2 }, { group: "stuck", count: 1 }], shipped: 2, lastLandingAt: "2026-10-01T00:00:00.000Z" },
      { id: "m2", path: "quiet", name: "Quiet", open: 0, parts: [], shipped: 1, lastLandingAt: null },
    ],
    max: 3,
    unassigned: { id: null, path: "", name: "No module", open: 0, parts: [], shipped: 0, lastLandingAt: null },
  },
  needsYou: { count: 3, rows: [NEED_ISSUE, NEED_RELEASE, NEED_CONTRACT] },
  coverage: { open: 5, openRead: 5, limit: 500, flowTruncated: false },
  ...over,
});

let current: { data?: DevelopmentOverview; isLoading: boolean; isError: boolean; error: unknown; refetch: () => void } = {
  data: DATA(),
  isLoading: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
};
vi.mock("../hooks", () => ({ useDevelopmentOverview: () => current }));

const scope = { projectId: "p", slug: "hop" };

beforeEach(() => {
  sessionStorage.clear();
  push.mockClear();
  current = { data: DATA(), isLoading: false, isError: false, error: null, refetch: vi.fn() };
});

describe("the signals strip", () => {
  it("says a signal core has no source for is not available, with the reason on hover, and never a value", () => {
    render(<SignalsStrip data={DATA()} />);
    const ci = screen.getByTestId("signal-ci");
    const post = screen.getByTestId("signal-post-merge");
    expect(within(ci).getByTestId("signal-unavailable")).toHaveTextContent("Not available");
    expect(within(post).getByTestId("signal-unavailable")).toHaveTextContent("Not available");
    expect(ci).not.toHaveTextContent(/passed|failed|green|red/i);
  });

  it("reads contract windows and versions to approve, and slots in use without inventing a cap", () => {
    render(<SignalsStrip data={DATA()} />);
    expect(screen.getByTestId("signal-contracts")).toHaveTextContent("Windows open 1");
    expect(screen.getByTestId("signal-contracts")).toHaveTextContent("To approve 1");
    expect(screen.getByTestId("signal-master")).toHaveTextContent("Slots in use 3");
    expect(screen.getByTestId("capacity-unavailable")).toHaveTextContent("of ?");
    expect(screen.getByTestId("signal-master")).toHaveTextContent("Masters live 1");
  });

  it("says no window is open when none is and nothing awaits approval", () => {
    const d = DATA();
    render(<SignalsStrip data={{ ...d, signals: { ...d.signals, contracts: { windows: [], openWindows: 0, awaitingApproval: 0 } } }} />);
    expect(screen.getByTestId("signal-contracts")).toHaveTextContent("No window open");
  });

  it("draws a cap when core one day reports it", () => {
    const d = DATA();
    render(<SignalsStrip data={{ ...d, signals: { ...d.signals, master: { ...d.signals.master, capacity: 4 } } }} />);
    expect(screen.queryByTestId("capacity-unavailable")).toBeNull();
    expect(screen.getByTestId("signal-master")).toHaveTextContent("of 4");
  });
});

describe("the screen", () => {
  it("names each part with its server count, label first", () => {
    render(<DevelopmentOverviewScreen scope={scope} />);
    expect(screen.getByRole("heading", { name: /Moving\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Stuck\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Issue flow" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Modules" })).toBeInTheDocument();
    expect(screen.getAllByTestId("list-group").map((g) => g.dataset.group)).toEqual(["needs_you"]);
  });

  it("draws every stage of the flow with the count core gave it", () => {
    render(<DevelopmentOverviewScreen scope={scope} />);
    const stages = [...document.querySelectorAll("[data-stage]")] as HTMLElement[];
    expect(stages.map((s) => [s.dataset.stage, s.textContent])).toEqual([
      ["draft", "Draft1"],
      ["open", "Open2"],
      ["in_progress", "In progress2"],
      ["awaiting_release", "Awaiting release0"],
      ["closed", "Closed1"],
    ]);
  });

  it("lists what waits on the viewer as one group of three kinds, each a link to its own page", () => {
    render(<DevelopmentOverviewScreen scope={scope} />);
    const rows = screen.getAllByTestId("list-row");
    expect(rows.map((r) => r.dataset.key)).toEqual(["ISS-7", "0.42.2", "hop/dischargeSummary 2.0.0"]);
    expect(rows.map((r) => r.getAttribute("href"))).toEqual([
      "/projects/hop/issues/ISS-7",
      "/projects/hop/releases",
      "/projects/hop/contracts/hop/dischargeSummary",
    ]);
    for (const r of rows) expect(within(r).getByTestId("waiting-on")).toHaveAttribute("data-kind", "you");
  });

  it("opens an issue in the Issues peek and the others on their page, never a peek of its own", () => {
    render(<DevelopmentOverviewScreen scope={scope} />);
    const rows = screen.getAllByTestId("list-row");
    fireEvent.click(rows[0] as HTMLElement);
    fireEvent.click(rows[1] as HTMLElement);
    expect(push.mock.calls.map((c) => c[0])).toEqual(["/projects/hop/issues?peek=ISS-7", "/projects/hop/releases"]);
    expect(screen.queryByTestId("peek-panel")).toBeNull();
  });

  it("says a partial read is partial, and a complete one says nothing", () => {
    const { unmount } = render(<DevelopmentOverviewScreen scope={scope} />);
    expect(screen.queryByTestId("overview-partial")).toBeNull();
    unmount();
    current = { ...current, data: DATA({ coverage: { open: 800, openRead: 500, limit: 500, flowTruncated: false } }) };
    render(<DevelopmentOverviewScreen scope={scope} />);
    expect(screen.getByTestId("overview-partial")).toHaveTextContent("newest 500 of 800 open issues");
  });

  it("says the flow is short when the closed read hit its limit", () => {
    current = { ...current, data: DATA({ coverage: { open: 5, openRead: 5, limit: 500, flowTruncated: true } }) };
    render(<DevelopmentOverviewScreen scope={scope} />);
    expect(screen.getByTestId("overview-partial")).toHaveTextContent("newest 500 closed issues");
  });

  it("says each empty part in words and keeps the page", () => {
    const d = DATA();
    current = {
      ...current,
      data: DATA({
        flow: { ...d.flow, total: 0, stages: d.flow.stages.map((s) => ({ ...s, count: 0, parts: [] })) },
        moving: { count: 0, window: null, lanes: [] },
        stuck: { count: 0, chains: [] },
        needsYou: { count: 0, rows: [] },
      }),
    };
    render(<DevelopmentOverviewScreen scope={scope} />);
    expect(screen.getByText(/No issue was touched in the last 14 days/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is running/)).toBeInTheDocument();
    expect(screen.getByText("Nothing is stuck.")).toBeInTheDocument();
    expect(screen.getByText(/Nothing waits on you/)).toBeInTheDocument();
  });

  it("refuses to pass a failed read for an empty page", () => {
    current = { isLoading: false, isError: true, error: new Error("boom"), refetch: vi.fn() };
    render(<DevelopmentOverviewScreen scope={scope} />);
    expect(screen.queryByTestId("signals-strip")).toBeNull();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
});

describe("the run lanes", () => {
  it("draws one lane per run with a segment per step it has been in, and the open one in the run colour", () => {
    render(<DevelopmentOverviewScreen scope={scope} />);
    const lane = screen.getByTestId("lane");
    expect(lane.dataset.key).toBe("ISS-9");
    expect(within(lane).getByText("Plan")).toBeInTheDocument();
    expect(within(lane).getByText("Build")).toBeInTheDocument();
  });

  it("puts axis ticks on round clock times and never more than the labels can hold", () => {
    const from = Date.parse("2026-10-03T20:07:00Z");
    const to = Date.parse("2026-10-03T23:30:00Z");
    const t = ticksOf(from, to);
    expect(t.length).toBeLessThanOrEqual(5);
    for (const x of t) {
      expect(x).toBeGreaterThanOrEqual(from);
      expect(x).toBeLessThanOrEqual(to);
      expect(x % 900_000).toBe(0);
    }
  });
});

describe("stuck chains", () => {
  it("roots a chain at a contract version, in its own words, and draws what it holds back after it", () => {
    render(<StuckChains stuck={DATA().stuck} slug="hop" />);
    const nodes = screen.getAllByTestId("chain-node");
    expect(nodes.map((n) => n.dataset.key)).toEqual(["autoflow/api", "ISS-4"]);
    expect(nodes[0]).toHaveTextContent("Waiting for a version");
    expect(nodes[1]).toHaveAttribute("data-held", "true");
  });
});

describe("modules", () => {
  it("draws open issues on one scale, folds quiet modules away, and opens them on request", () => {
    render(<ModuleBars modules={DATA().modules} />);
    expect(screen.getAllByTestId("module-row").map((r) => r.dataset.module)).toEqual(["reminders"]);
    fireEvent.click(screen.getByRole("button", { name: /Quiet 1/ }));
    expect(screen.getAllByTestId("module-row").map((r) => r.dataset.module)).toEqual(["reminders", "quiet"]);
  });

  it("says a project with no module has none, not that nothing is open", () => {
    render(<ModuleBars modules={{ rows: [], max: 0, unassigned: { id: null, path: "", name: "No module", open: 0, parts: [], shipped: 0, lastLandingAt: null } }} />);
    expect(screen.getByText(/No module is defined/)).toBeInTheDocument();
  });

  it("still shows issues that sit under no module when the project has defined none", () => {
    render(<ModuleBars modules={{ rows: [], max: 4, unassigned: { id: null, path: "", name: "No module", open: 4, parts: [{ group: "queued", count: 4 }], shipped: 1, lastLandingAt: null } }} />);
    expect(screen.getAllByTestId("module-row").map((r) => r.dataset.module)).toEqual(["none"]);
  });
});

describe("where a need leads", () => {
  it("sends an issue to its page and, from a click, to its peek; a release to its list and a contract to its page", () => {
    expect(needHref("hop", NEED_ISSUE)).toBe("/projects/hop/issues/ISS-7");
    expect(needPeekHref("hop", NEED_ISSUE)).toBe("/projects/hop/issues?peek=ISS-7");
    expect(needHref("hop", NEED_RELEASE)).toBe("/projects/hop/releases");
    expect(needPeekHref("hop", NEED_RELEASE)).toBe("/projects/hop/releases");
    expect(needHref("hop", NEED_CONTRACT)).toBe("/projects/hop/contracts/hop/dischargeSummary");
  });

  it("draws a row's state as the shared badge of its family, never the raw value", () => {
    const row = needRowView("hop")(NEED_RELEASE);
    render(<div>{row.state}</div>);
    expect(screen.getByTestId("status-badge")).toHaveTextContent("Awaiting approval");
    expect(screen.getByTestId("status-badge")).toHaveAttribute("data-value", "pending");
  });
});
