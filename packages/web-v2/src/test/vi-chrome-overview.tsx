import type { DevelopmentOverview } from "@forge/contracts/development-overview";
import type { PulseResponse } from "@forge/contracts/pulse";
import { fireEvent } from "@testing-library/react";
import { AwaitingReleaseCard } from "@/features/development/activity/awaiting-release-card";
import { KpiBand } from "@/features/development/activity/kpi-band";
import { LiveRunsCard } from "@/features/development/activity/live-runs-card";
import { RunnersCard } from "@/features/development/activity/runners-card";
import { SpendCard } from "@/features/development/activity/spend-card";
import { StatusDonut } from "@/features/development/activity/status-donut";
import { DevelopmentOverviewScreen } from "@/features/development/components/development-overview-screen";
import { LeaseLanes } from "@/features/development/components/lease-lanes";
import { ModuleBars } from "@/features/development/components/module-bars";
import { needsYouKey } from "@/features/needs-you/hooks";
import { ActionQueue } from "@/features/overview/components/action-queue";
import { FlowSection } from "@/features/overview/components/flow-section";
import { LivenessBand } from "@/features/overview/components/liveness-band";
import { QualitySection } from "@/features/overview/components/quality-section";
import { WorkSitting } from "@/features/overview/components/work-sitting";
import type { PipelineRunListItem } from "@/features/pipeline/types";
import { Seeded } from "./vi-chrome-requirements";

// The Development overview and the workspace Overview for the vi walking test. Content is
// placeholder words; core's sentences (a signal it cannot read, a turn's rule, a record's detail)
// are the real ones core writes.

const P = "p1";
const AT = "2026-10-07T08:00:00.000Z";
const NOW = "2026-10-07T12:00:00.000Z";
const waitRun = { kind: "run", who: "Run", act: "Build · 12 min", rule: "lease held by box-1", ref: null, dueAt: null } as const;

const DEV: DevelopmentOverview = {
  generatedAt: NOW,
  signals: {
    ci: { available: false, reason: "Core stores check runs for pull requests only, never for a branch head, so it holds no reading of dev itself." },
    postMerge: { available: false, reason: "A push to a gated branch carries its post-merge jobs on GitHub; core receives no event for them and stores none." },
    contracts: { windows: [{ contract: "don-hang", version: "2.0.0", dueAt: "2026-10-09T08:00:00.000Z", feedback: "FB-3" }], openWindows: 4, awaitingApproval: 1 },
    master: { masters: 0, state: "none", slots: null, slotsNote: "No live master serves this project, so no box has declared slots for it." },
  },
  flow: {
    windowDays: 14,
    total: 9,
    stages: [
      { id: "draft", count: 0, parts: [] },
      { id: "open", count: 4, parts: [{ group: "queued", count: 3 }, { group: "needs_you", count: 1 }] },
      { id: "in_progress", count: 3, parts: [{ group: "moving", count: 2 }, { group: "stuck", count: 1 }] },
      { id: "awaiting_release", count: 1, parts: [{ group: "queued", count: 1 }] },
      { id: "closed", count: 1, parts: [{ group: "done", count: 1 }] },
    ],
  },
  moving: {
    count: 2,
    window: { from: "2026-10-07T09:00:00.000Z", to: "2026-10-07T13:00:00.000Z", now: NOW },
    lanes: [
      {
        key: "ISS-1",
        title: "Muc mot",
        status: "in_progress",
        step: "build",
        holder: "sess-1",
        box: "box-1",
        branch: "ISS-1",
        segments: [{ step: "plan", startedAt: "2026-10-07T09:10:00.000Z", endedAt: "2026-10-07T10:30:00.000Z" }, { step: "build", startedAt: "2026-10-07T10:30:00.000Z", endedAt: null }],
        heldSince: "2026-10-07T09:10:00.000Z",
        lease: { verdict: "live", expiresAt: "2026-10-07T12:40:00.000Z" },
        waitingOn: waitRun,
      },
      { key: "ISS-2", title: "Muc hai", status: "in_progress", step: null, holder: null, box: null, branch: null, segments: [], heldSince: "2026-10-07T11:00:00.000Z", lease: null, waitingOn: { ...waitRun, act: "working" } },
    ],
  },
  stuck: {
    count: 2,
    chains: [
      {
        id: "ISS-3",
        held: 1,
        levels: [
          [{ kind: "issue", key: "ISS-3", title: "Muc ba", status: "in_progress", step: "test", tone: "blocked", waitingOn: { kind: "none", who: "No holder", act: "in progress with no live run", rule: "in_progress, but no lease is live and no job or run is in flight", ref: null, dueAt: null }, held: false }],
          [{ kind: "issue", key: "ISS-4", title: "Muc bon", status: "open", step: null, tone: null, waitingOn: null, held: true }],
        ],
      },
    ],
  },
  modules: {
    rows: [
      { id: "m1", path: "kho/don", name: "Don", open: 3, parts: [{ group: "moving", count: 2 }, { group: "stuck", count: 1 }], shipped: 4, lastLandingAt: AT },
      { id: "m2", path: "kho/xe", name: "Xe", open: 0, parts: [], shipped: 1, lastLandingAt: null },
    ],
    max: 3,
    unassigned: { id: null, path: "", name: "No module", open: 1, parts: [{ group: "queued", count: 1 }], shipped: 0, lastLandingAt: null },
  },
  coverage: { open: 300, openRead: 200, limit: 200, flowTruncated: false },
} as DevelopmentOverview;

const run = (n: number, over: Partial<PipelineRunListItem> = {}): PipelineRunListItem =>
  ({
    id: `r${n}`,
    status: "running",
    kind: "issue",
    currentStep: "code",
    issueId: `i${n}`,
    issueRef: `ISS-${n}`,
    issueTitle: `Muc ${n}`,
    issueStatus: "in_progress",
    startedAt: AT,
    liveJobs: 1,
    cost: { estimatedCost: 1.5 },
    ...over,
  }) as PipelineRunListItem;

const runners = {
  lines: [
    { id: "a", name: "box-1", platform: "linux", online: true, draining: false, busy: true, running: 1, queued: 0, limit: null, activeIssueRef: "ISS-1", activeStage: "code" },
    { id: "b", name: "box-2", platform: "macos", online: true, draining: false, busy: false, running: 0, queued: 0, limit: null, activeIssueRef: null, activeStage: null },
    { id: "c", name: "box-3", platform: "windows", online: false, draining: true, busy: false, running: 0, queued: 0, limit: null, activeIssueRef: null, activeStage: null },
    { id: "d", name: "box-4", platform: "linux", online: false, draining: false, busy: false, running: 0, queued: 0, limit: null, activeIssueRef: null, activeStage: null },
  ],
  onlineCount: 2,
  busyCount: 1,
  total: 4,
} as const;

const PULSE: PulseResponse = {
  generatedAt: NOW,
  thresholds: { abandonedIssueSeconds: 3600, releaseWaitingSeconds: 3600, projectSilenceSeconds: 86400, silenceWarnSeconds: 600, silenceAlarmSeconds: 3600 * 6, identityCap: 20 },
  liveness: {
    jobsRunning: 2,
    jobsQueued: 1,
    jobsHeld: 1,
    liveJobs: { total: 1, shown: [{ jobId: "j1", runId: "r1", type: "code", projectSlug: "hop", issueRef: "ISS-1", issueDocId: "i1", ageSeconds: 300 }] },
    stuckRuns: { total: 2, shown: [{ runId: "r2", projectSlug: "hop", issueRef: null, issueDocId: null, ageSeconds: 7200 }] },
    lastJobAt: AT,
    silenceSeconds: 4000,
    heartbeat: [{ date: "2026-10-06", issueRuns: 3 }, { date: "2026-10-07", issueRuns: 5 }],
    devices: { online: 2, draining: 1, total: 4 },
  },
  work: {
    buckets: { open: 4, inProgress: 3, awaitingRelease: 1, humanBlocked: 2 },
    abandoned: { total: 0, shown: [] },
    releaseWaiting: { total: 0, shown: [] },
    notOnLive: { total: 0, shown: [] },
    liveUnmeasured: { total: 0, shown: [] },
    silentProjects: { total: 0, shown: [] },
    neverRanProjects: { total: 0, shown: [] },
    humanBlockedAges: [3600, 200000],
    perProject: [
      { id: "p1", slug: "hop", name: "Hop", open: 4, inProgress: 3, awaitingRelease: 1, humanBlocked: 2, stuckRuns: 0, abandonedIssues: 0, lastIssueRunAt: AT },
      { id: "p2", slug: "kho", name: "Kho", open: 1, inProgress: 0, awaitingRelease: 0, humanBlocked: 0, stuckRuns: 0, abandonedIssues: 0, lastIssueRunAt: null },
    ],
  },
  flow: [
    { weekStart: "2026-09-28", created: 5, closed: 3, reopened: 0, backlog: 10 },
    { weekStart: "2026-10-05", created: 2, closed: 4, reopened: 1, backlog: 9 },
  ],
  quality: {
    finished: { merged: 6, closedUnmerged: 1, dropped: 1 },
    reopened: { issues: 1, events: 2 },
    rework: { fix: 2, code: 7 },
    runFailure: { pipeline: { failed: 1, total: 9 }, other: { failed: 0, total: 3 } },
    sessionFailures: [],
    pipelineFlow: [{ type: "plan", count: 5, medianSeconds: 600 }, { type: "code", count: 4, medianSeconds: 3000 }, { type: "fix", count: 2, medianSeconds: null }],
  },
  actions: [
    { key: "stuckRuns", label: "Runs claimed but empty", hint: "", owner: "machine", count: 2, oldestSeconds: 7200, records: [{ key: "r2", label: "Run", detail: "hop", href: "/ops?run=r2", ageSeconds: 7200 }] },
    { key: "neverRanProjects", label: "Projects holding a backlog with no pipeline", hint: "", owner: "person", count: 3, oldestSeconds: Number.MAX_SAFE_INTEGER, records: [{ key: "p2", label: "Kho", detail: "1 issue waiting", href: "/projects/kho", ageSeconds: Number.MAX_SAFE_INTEGER }] },
    { key: "notOnLive", label: "Closed, not on production", hint: "", owner: "person", count: 1, oldestSeconds: null, records: [{ key: "i5", label: "ISS-5", detail: "Muc nam · abcdef12 not on prod", href: "/projects/hop/issues/i5", ageSeconds: 60 }] },
  ],
};

const click = (selector: string, nth = 0) => () => {
  const el = document.querySelectorAll(selector)[nth];
  if (!el) throw new Error(`nothing to open at ${selector}`);
  fireEvent.click(el);
};

export const OVERVIEW_SCREENS = [
  {
    name: "Development overview",
    render: () => (
      <Seeded data={[[["issues", "standing", "development-overview", P], DEV], [needsYouKey(P), { items: [] }]]}>
        <DevelopmentOverviewScreen scope={{ projectId: P, slug: "hop" }} />
      </Seeded>
    ),
  },
  {
    name: "Development overview · lanes and modules",
    render: () => (
      <>
        <LeaseLanes moving={{ count: 0, window: null, lanes: [] }} slug="hop" />
        <ModuleBars modules={{ rows: [], max: 0, unassigned: { ...DEV.modules.unassigned, open: 0 } }} />
        <ModuleBars modules={DEV.modules} />
      </>
    ),
    act: click('button[aria-expanded="false"]'),
  },
  {
    name: "Development activity",
    render: () => (
      <Seeded data={[]}>
        <KpiBand liveRuns={2} busyRunners={1} onlineRunners={2} openIssues={9} spendTodayUsd={4.2} inFlightUsd={1.1} />
        <KpiBand liveRuns={0} busyRunners={0} onlineRunners={0} openIssues={0} spendTodayUsd={0} inFlightUsd={0} />
        <LiveRunsCard runs={[run(1), run(2, { issueRef: null, kind: "system" })]} slug="hop" idle={[run(3), run(4)]} />
        <LiveRunsCard runs={[]} slug="hop" idle={[run(3)]} />
        <AwaitingReleaseCard runs={[1, 2, 3, 4, 5, 6].map((n) => run(n, { issueStatus: "awaiting_release", issueRef: n === 6 ? null : `ISS-${n}` }))} slug="hop" projectId={P} />
        <AwaitingReleaseCard runs={[]} slug="hop" projectId={P} />
        <StatusDonut data={{ total: 6, segments: (["active", "attention", "queued", "blocked"] as const).map((key) => ({ key, label: key, color: "red", count: 1, pct: 25 })) }} />
        <StatusDonut data={{ total: 0, segments: [] }} />
        <SpendCard data={{ total: 3, segments: (["test", "code", "plan", "other"] as const).map((key) => ({ key, label: key, color: "red", cost: 0.75, pct: 25 })) }} inFlightUsd={0.5} />
        <SpendCard data={{ total: 0, segments: [] }} inFlightUsd={0} />
        <RunnersCard summary={runners as never} slug="hop" />
        <RunnersCard summary={{ lines: [], onlineCount: 0, busyCount: 0, total: 0 }} slug="hop" />
      </Seeded>
    ),
  },
  {
    name: "Workspace overview",
    render: () => (
      <>
        <LivenessBand liveness={PULSE.liveness} thresholds={PULSE.thresholds} />
        <LivenessBand liveness={{ ...PULSE.liveness, silenceSeconds: null, heartbeat: [] }} thresholds={PULSE.thresholds} />
        <WorkSitting pulse={PULSE} nowMs={Date.parse(NOW)} />
        <ActionQueue pulse={PULSE} />
        <ActionQueue pulse={{ ...PULSE, actions: [] }} />
        <FlowSection flow={PULSE.flow} />
        <FlowSection flow={[]} />
        <QualitySection quality={PULSE.quality} />
        <QualitySection quality={{ ...PULSE.quality, finished: { merged: 0, closedUnmerged: 0, dropped: 0 }, pipelineFlow: [] }} />
      </>
    ),
  },
  { name: "Workspace overview · live jobs", render: () => <LivenessBand liveness={PULSE.liveness} thresholds={PULSE.thresholds} />, act: click("button", 0) },
  { name: "Workspace overview · stuck runs", render: () => <LivenessBand liveness={PULSE.liveness} thresholds={PULSE.thresholds} />, act: click("button", 1) },
  { name: "Workspace overview · action records", render: () => <ActionQueue pulse={PULSE} />, act: click("button", 1) },
  { name: "Workspace overview · records not on live", render: () => <ActionQueue pulse={PULSE} />, act: click("button", 2) },
];
