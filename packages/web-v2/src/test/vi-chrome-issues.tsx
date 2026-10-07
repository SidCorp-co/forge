import type { IssueStandingDetail, IssueStandingRow } from "@forge/contracts/issue-standing";
import type { QueryKey } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { fireEvent } from "@testing-library/react";
import { ISSUES_PAGE_SIZE } from "@/features/issues/api";
import { ActivityFeed } from "@/features/issues/components/activity-feed";
import { AwaitingReleaseBanner } from "@/features/issues/components/awaiting-release-banner";
import { BatchReleaseDialog } from "@/features/issues/components/batch-release-dialog";
import { BlockerBanner } from "@/features/issues/components/blocker-banner";
import { BulkActionBar } from "@/features/issues/components/bulk-action-bar";
import { CommentThread } from "@/features/issues/components/comment-thread";
import { CriteriaTab, OverviewTab, RunsTab } from "@/features/issues/components/detail/issue-tabs";
import { IssueDetailScreen } from "@/features/issues/components/issue-detail-screen";
import { IssuePeek } from "@/features/issues/components/issue-peek";
import { IssuesBoard } from "@/features/issues/components/issues-board";
import { IssuesListView } from "@/features/issues/components/issues-list-view";
import { IssuesEmptyState } from "@/features/issues/components/list/issues-empty-state";
import { LiveAgentPanel } from "@/features/issues/components/live-agent-panel";
import { MergeMarkerControl } from "@/features/issues/components/merge-marker-control";
import { ModulePicker } from "@/features/issues/components/module-picker";
import { PropertiesRail } from "@/features/issues/components/properties-rail";
import { StagedFileList } from "@/features/issues/components/staged-files";
import { TransitionReasonDialog } from "@/features/issues/components/transition-reason-dialog";
import type { CommentNode, IssueDetail, IssueRow } from "@/features/issues/types";
import { type ProductCopyKey, productCopy } from "@/lib/i18n/product-copy";
import { Seeded } from "./vi-chrome-requirements";

// a control found by its label in either language: the rail test draws each screen in en as well
const labelled = (key: ProductCopyKey) => `[aria-label="${productCopy("vi")(key)}"],[aria-label="${productCopy("en")(key)}"]`;

// The Issues screens of the Development space for the vi walking test: the table and the three
// grouped views, the peek, the full page and its tabs, the rail, the banners, the dialogs. Content
// is placeholder words; core's sentences (whom an issue waits on, why it is blocked, a gate) are the
// real ones core writes, since they reach the screen through standing-copy patterns.

const P = "p1";
const AT = "2026-10-07T08:00:00.000Z";
const project = { id: P, slug: "hop", name: "Hop", role: "admin", orgId: null };
const noop = () => {};

const click = (selector: string, nth = 0) => () => {
  const hit = document.querySelectorAll(selector)[nth];
  if (!hit) throw new Error(`nothing to open at ${selector}`);
  fireEvent.click(hit.closest("[aria-haspopup]") ?? hit);
};

const standing = (over: Partial<IssueStandingRow["standing"]> = {}): IssueStandingRow["standing"] =>
  ({
    state: "in_progress",
    step: "build",
    stepStartedAt: AT,
    moves: [{ to: "on_hold", kind: "bounce", needsReason: true, startsGroup: false }],
    tone: "run",
    attentionGroup: "moving",
    waitingOn: { kind: "run", who: "Run", act: "Build · 12 min", rule: "lease held by box-1", ref: null, dueAt: null },
    criteria: { total: 4, passing: 2, failing: 1, skipped: 0 },
    requirement: { key: "REQ-1", title: "Dang nhap", criteria: ["BC-1"], plannedRevision: 1, currentRevision: 2, changedSincePlan: true },
    module: { id: "m1", path: "kho/don", name: "Don" },
    feedback: ["FB-3"],
    blockedBy: [],
    blocks: [{ key: "ISS-9", title: "Muc chin", status: "open", group: "queued", landed: false, designHold: null }],
    lease: { holder: "box-1", verdict: "live" },
    inFlight: true,
    branch: "ISS-1",
    headSha: "abcdef1234567",
    owner: { id: "u1", name: "Lan", kind: "human" },
    wave: 0,
    touchedAt: AT,
    withheld: null,
    ...over,
  }) as IssueStandingRow["standing"];

const srow = (n: number, over: Partial<IssueStandingRow["standing"]> = {}, status = "in_progress"): IssueStandingRow =>
  ({
    id: `i${n}`,
    key: `ISS-${n}`,
    title: `Muc ISS-${n}`,
    status,
    priority: n === 1 ? "critical" : "medium",
    category: "bug",
    complexity: "s",
    assigneeId: null,
    createdById: "u1",
    createdAt: AT,
    updatedAt: AT,
    standing: standing({ state: status as never, ...over }),
  }) as IssueStandingRow;

const STANDING_ROWS: IssueStandingRow[] = [
  srow(1),
  srow(2, { attentionGroup: "needs_you", tone: "you", waitingOn: { kind: "you", who: "You", act: "answer a question", rule: "r", ref: null, dueAt: null }, wave: 1, blockedBy: [{ key: "ISS-1", title: "Muc", status: "in_progress", group: "moving", landed: false, designHold: null }] }, "needs_info"),
  srow(3, { attentionGroup: "stuck", tone: "blocked", waitingOn: { kind: "issue", who: "ISS-1", act: "landed, waits on a judge", rule: "r", ref: "ISS-1", dueAt: null }, wave: 2, module: null }, "open"),
  srow(4, { attentionGroup: "queued", tone: "ready", waitingOn: { kind: "master", who: "Master", act: "dispatch a run", rule: "r", ref: null, dueAt: null }, wave: null }, "open"),
  srow(5, { attentionGroup: "paused", tone: "neutral", waitingOn: { kind: "person", who: "A project writer", act: "resume it", rule: "r", ref: null, dueAt: null } }, "on_hold"),
  srow(6, { attentionGroup: "done", tone: "done", waitingOn: { kind: "none", who: "Nobody", act: "shipped", rule: "r", ref: null, dueAt: null }, wave: null }, "closed"),
];

const STANDING_LIST = {
  issues: STANDING_ROWS,
  counts: { open: 5, closed: 1, all: 6, needsYou: 1, blocked: 1, blocking: 1 },
  returned: 6,
  limit: 6,
  releaseApproval: true,
};

const row = (n: number, over: Partial<IssueRow> = {}): IssueRow =>
  ({
    id: `i${n}`,
    projectId: P,
    issSeq: n,
    displayId: `ISS-${n}`,
    title: `Muc ISS-${n}`,
    status: "in_progress",
    priority: "high",
    category: "bug",
    complexity: "m",
    assigneeId: null,
    createdById: "u1",
    creatorEmail: "lan@hop.vn",
    creatorIsAgent: false,
    creatorLabel: "Lan",
    reopenCount: 0,
    mergedAt: null,
    createdAt: AT,
    updatedAt: "2026-10-05T08:00:00.000Z",
    moves: [{ to: "on_hold", kind: "bounce", needsReason: true, startsGroup: false }],
    agentStatus: "running",
    agentSessions: [{ id: "s1", status: "running", deviceName: "box-1" }] as never,
    workState: { step: "build" } as never,
    ...over,
  }) as IssueRow;

const ROWS: IssueRow[] = [
  row(1, {
    waitingOnPersonSince: "2026-10-06T08:00:00.000Z",
    dependencies: {
      incoming: [{ id: "e1", kind: "blocks", fromIssueId: "i9", toIssueId: "i1", fromDisplayId: "ISS-9", holds: true, fromMergedAt: AT } as never],
      outgoing: [{ id: "e2", kind: "blocks", fromIssueId: "i1", toIssueId: "i3", toDisplayId: "ISS-3" } as never, { id: "e3", kind: "decomposes", fromIssueId: "i1", toIssueId: "i4", toDisplayId: "ISS-4" } as never],
    },
  }),
  row(2, { status: "open", agentStatus: "failed", failureInfo: { failedStep: "build", failedAt: AT, failureReason: "loi" } as never, priority: "none" }),
  row(3, {
    status: "open",
    agentStatus: undefined,
    agentSessions: [],
    pipelineHealth: {
      stage: "open",
      queuedStep: { jobId: "j1", jobType: "triage", stageStatus: null, queuedAt: AT, retryAfterAt: null },
      waitingOn: { reason: "runner_stale", since: AT, details: {}, reading: { short: "No runner online", detail: "No runner is online for this project — every host is offline, stale, or rate-limited.", who: "Bring a runner back (check the Runners tab); the step dispatches on the next tick.", needsAction: true } },
    },
  }),
  row(4, { status: "awaiting_release", agentStatus: "completed", releaseBatchRunId: null }),
];

const searchKey = ["issues", "search", P, { q: "", filter: "open", sort: "createdAt:desc", page: 1, pageSize: ISSUES_PAGE_SIZE }];
const searchPage = { items: ROWS, totalCount: 60, extra: { buckets: { byStatus: { in_progress: 2, open: 2, closed: 3 } } } };
const members = [
  { userId: "u1", email: "lan@hop.vn", displayName: "Lan", kind: "human", role: "admin", createdAt: AT },
  { userId: "a1", email: "tro-ly@hop.vn", displayName: "Tro ly", kind: "agent", role: "member", createdAt: AT },
];

const listQueries = (): [QueryKey, unknown][] => [
  [["projects"], [project]],
  [searchKey, searchPage],
  [["project", P, "members"], members],
  [["project", P, "labels"], [{ id: "l1", name: "nhan", kind: "label" }]],
];

const ISSUE: IssueDetail = {
  ...row(1, { status: "needs_info", agentStatus: "running" }),
  description: "Noi dung",
  descriptionFormat: "markdown",
  plan: null,
  acceptanceCriteria: "- [x] Tieu chi mot\n- [ ] Tieu chi hai",
  labels: [{ id: "m1", name: "Don", kind: "module", isPrimary: true }, { id: "l1", name: "nhan", kind: "label" }],
  mergedAt: AT,
  mergeMark: "asserted",
  landingShape: "git",
  liveReach: { state: "none_waiting", baseBranch: "main", baseSha: "abcdef12345", deploysFrom: "prod", liveSha: "1234567abcd", measuredAt: AT, unowned: [{ sha: "9999999aaaa", subject: "sua" }] },
  releaseNotes: { userFacing: "", section: "Skip" },
  sessionContext: null,
  pipelineHealth: {
    stage: "needs_info",
    queuedStep: { jobId: "j2", jobType: "build", stageStatus: null, queuedAt: AT, retryAfterAt: "2026-10-07T09:00:00.000Z" },
    waitingOn: { reason: "retry_cooldown", since: AT, details: {}, reading: { short: "Retry cooldown", detail: "The step failed and is waiting out a cooldown before its next attempt.", who: "No action — the retry fires itself. If the attempts keep failing, read the step's error rather than waiting.", needsAction: false } },
  },
} as unknown as IssueDetail;

const DETAIL: IssueStandingDetail = {
  ...srow(1, { attentionGroup: "needs_you", tone: "you", waitingOn: { kind: "you", who: "You", act: "answer a question", rule: "r", ref: null, dueAt: null } }, "needs_info"),
  steps: [],
  releaseApproval: true,
  blocker: {
    tone: "attention",
    reason: "This issue is waiting for information — an answer to a question.",
    whoMustAct: "Anyone on the project can answer it; the question is below.",
    act: { label: "Answer it", kind: "provide_info" },
    runId: null,
    resumeAt: null,
    blockingRefs: [{ key: "ISS-9", title: "Muc chin", status: "open", group: "queued", landed: false, designHold: null }],
    detail: "Nothing says where this issue picks up again — Move anyway… in the status menu lists every move.",
  },
  stepOutcomes: [
    { step: "plan", state: "done", outcomeLabel: null, durationSeconds: 3725, costUsd: 0.42, handoff: null, ranAt: AT },
    { step: "build", state: "failed", outcomeLabel: null, durationSeconds: 75, costUsd: null, handoff: null, ranAt: AT },
  ],
} as unknown as IssueStandingDetail;

const comment = (id: string, over: Partial<CommentNode> = {}): CommentNode =>
  ({
    id,
    body: "Noi dung",
    format: "markdown",
    nodes: null,
    authorId: "u1",
    author: { displayName: "Lan", isAgent: false },
    intent: null,
    attachments: [],
    replies: [],
    createdAt: AT,
    ...over,
  }) as unknown as CommentNode;

const COMMENTS = [
  comment("c1", { body: "## Ghi chu\n\nphan loai", replies: [comment("c2", { author: { displayName: "Tro ly", isAgent: true, ownerEmail: "lan@hop.vn" } as never })] }),
  comment("c3", { intent: "decision" } as never),
];

const ACTIVITY = [
  { id: "a1", action: "issue.statusChanged", payload: { from: "open", to: "in_progress" }, actorType: "user", actor: { displayName: "Lan", isAgent: false }, createdAt: AT },
  { id: "a2", action: "issue.created", payload: {}, actorType: "device", actor: { displayName: "box-1", isAgent: true }, createdAt: AT },
  { id: "a3", action: "issue.updated", payload: { changes: [] }, actorType: "user", actor: null, createdAt: AT },
  { id: "a4", action: "issue.dependency.added", payload: {}, actorType: "user", actor: null, createdAt: AT },
  { id: "a5", action: "issue.priorityChanged", payload: { from: "low", to: "high" }, actorType: "user", actor: null, createdAt: AT },
];

const detailQueries = (): [QueryKey, unknown][] => [
  ...listQueries(),
  [["issue", "i1", P], ISSUE],
  [["issue", "i1"], ISSUE],
  [["issues", "standing", P, "one", "ISS-1"], DETAIL],
  [["comments", "i1"], { items: COMMENTS, totalCount: 3 }],
  [["activities", "i1"], { items: ACTIVITY }],
  [["issue", "i1", "attachments"], []],
  [["issue", "i1", "cost"], { estimatedCost: 1.25, inputTokens: 1200, outputTokens: 3400, cacheReadTokens: 0, cacheCreationTokens: 0 }],
  [["issue", "i1", "dependencies"], { incoming: [], outgoing: [] }],
  [["issue", "i1", "criteria"], { criteria: [{ id: "k1", n: 1, statement: "Tieu chi", position: 1, requirementCriterionId: null, latest: { verdict: "short", reason: "gan du", identityKind: null, authorAgency: "agent", createdAt: AT } }, { id: "k2", n: 2, statement: "Tieu chi hai", position: 2, requirementCriterionId: null, latest: null }] }],
  [["mockups", P, "issue", "ISS-1"], { mockups: [], returned: 0 }],
  [["release-roster", P], { gateStatus: "open", baseBranch: "main", nextCutAt: null, issues: [{ id: "i1", mergedAt: AT, claimedByRunId: null }] }],
];

const wrap = (data: [QueryKey, unknown][], children: ReactNode) => <Seeded data={data}>{children}</Seeded>;

const board = (mode: "attention" | "module" | "waves") => () => wrap([[["issues", "standing", P, "open"], STANDING_LIST]], <IssuesBoard scope={{ projectId: P, slug: "hop" }} mode={mode} />);

const peek = { open: "ISS-1", position: { at: 1, of: 6 }, set: noop, move: noop };
const clock = { lang: "vi" as const, now: Date.parse("2026-10-07T12:00:00Z"), timeZone: "UTC" };

function Dialogs() {
  return (
    <>
      {(["reopen", "needs_info", "on_hold", "dropped", "void_questions", "not_needed"] as const).map((s) => (
        <TransitionReasonDialog key={s} status={s} openQuestions={2} loading={false} onConfirm={noop} onClose={noop} />
      ))}
      <TransitionReasonDialog status="move_anyway" targets={["open", "needs_info"]} loading={false} onConfirm={noop} onClose={noop} />
      <BatchReleaseDialog projectId={P} selectedIssues={[{ id: "i4", displayId: "ISS-4", title: "Muc bon" }]} open onClose={noop} onSuccess={noop} />
    </>
  );
}

const BLOCKERS = [
  DETAIL.blocker,
  { tone: "info", reason: "Blocked by ISS-4, ISS-5, which have landed and wait on a judge.", whoMustAct: "A judge records a verdict on each criterion of ISS-4, ISS-5; this issue is released once they pass.", act: { label: "Open blocking issue", kind: "open_blocker" }, runId: null, resumeAt: null, blockingRefs: [], detail: null },
  { tone: "attention", reason: "The issue is paused.", whoMustAct: "An operator can resume it when the work is wanted again.", act: { label: "Resume at In progress", kind: "resume_park" }, runId: null, resumeAt: "in_progress", blockingRefs: [], detail: null },
  { tone: "attention", reason: "The pipeline run for this issue is paused. No step will dispatch while it is, whatever this issue's status says. An operator paused it.", whoMustAct: "Resume the run — nothing else will. Cancel it instead if the work should not continue.", act: { label: "Resume run", kind: "resume_run" }, runId: "r1", resumeAt: null, blockingRefs: [], detail: null },
] as NonNullable<IssueStandingDetail["blocker"]>[];

export const ISSUE_SCREENS = [
  { name: "Issues table", render: () => wrap(listQueries(), <IssuesListView scope={{ projectId: P, slug: "hop" }} onNewIssue={noop} />) },
  { name: "Issues table · row menu", render: () => wrap(listQueries(), <IssuesListView scope={{ projectId: P, slug: "hop" }} />), act: click(labelled("issues.row.actions")) },
  { name: "Issues table · filter", render: () => wrap(listQueries(), <IssuesListView scope={{ projectId: P, slug: "hop" }} />), act: click('button[aria-expanded="false"]') },
  {
    name: "Issues table · empty and bulk",
    render: () => (
      <>
        {[
          { inModule: true, isFiltered: false, projectHasIssues: true },
          { inModule: false, isFiltered: true, projectHasIssues: true },
          { inModule: false, isFiltered: false, projectHasIssues: true },
          { inModule: false, isFiltered: false, projectHasIssues: false },
        ].map((s) => (
          <IssuesEmptyState key={JSON.stringify(s)} moduleName={null} creatorName={null} onClear={noop} onNewIssue={noop} {...s} />
        ))}
        {wrap([], <BulkActionBar projectId={P} selectedRows={ROWS} onCleared={noop} />)}
        {wrap([], <BulkActionBar projectId={P} selectedRows={[ROWS[3] as IssueRow]} onCleared={noop} />)}
        <StagedFileList files={[new File(["x"], "anh.png", { type: "image/png" })]} warnings={["x"]} remove={noop} />
      </>
    ),
  },
  { name: "Issues board · attention", render: board("attention") },
  { name: "Issues board · module", render: board("module") },
  { name: "Issues board · waves", render: board("waves") },
  { name: "Issue peek", render: () => wrap([], <IssuePeek slug="hop" row={STANDING_ROWS[0] as IssueStandingRow} clock={clock} peek={peek} onOpenFull={noop} />) },
  { name: "Issue detail", render: () => wrap(detailQueries(), <IssueDetailScreen projectId={P} slug="hop" id="i1" />) },
  { name: "Issue detail · actions menu", render: () => wrap(detailQueries(), <IssueDetailScreen projectId={P} slug="hop" id="i1" />), act: click(labelled("issues.actions.menu")) },
  {
    name: "Issue detail · tabs",
    render: () =>
      wrap(
        detailQueries(),
        <>
          <OverviewTab issue={ISSUE} attachmentsQ={{ data: [], isLoading: false, isError: false } as never} canWrite />
          <CriteriaTab issueId="i1" hasCriteriaRows checklist={[]} />
          <CriteriaTab issueId="i2" hasCriteriaRows={false} checklist={[{ key: "a", text: "Tieu chi", checked: true }]} />
          <RunsTab sessions={[]} standingQ={{ isLoading: false, isError: false, data: DETAIL } as never} stepOutcomes={DETAIL.stepOutcomes} expandedStep="build" onToggleStep={noop} />
          <CommentThread issueId="i1" comments={COMMENTS} members={undefined} />
          <ActivityFeed items={ACTIVITY as never} />
        </>,
      ),
  },
  {
    name: "Issue properties",
    render: () =>
      wrap(
        detailQueries(),
        <PropertiesRail issue={ISSUE} slug="hop" cost={{ estimatedCost: 1.2, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } as never} deps={{ incoming: [{ id: "e1", kind: "blocks", fromIssueId: "i9", toIssueId: "i1", fromDisplayId: "ISS-9", expired: true } as never], outgoing: [] }} pending={false} onPatch={noop} onTransition={noop} onEditModules={noop} canMarkMerged moves={[]} />,
      ),
  },
  {
    name: "Issue banners",
    render: () =>
      wrap(
        detailQueries(),
        <>
          {BLOCKERS.map((b) => (
            <BlockerBanner key={b.reason} blocker={b} slug="hop" pending={false} onResumePark={noop} onResumeRun={noop} onProvideInfo={noop} />
          ))}
          <LiveAgentPanel state={{ kind: "live", session: { id: "s1", status: "running", heartbeat: "stale", startedAt: AT, deviceId: "dev-1234567" } as never }} step="build" slug="hop" issueId="i1" />
          <LiveAgentPanel state={{ kind: "queued", step: { jobId: "j1", jobType: "triage", queuedAt: AT, nextAttempt: "", retryAfterAt: "2026-10-08T09:00:00.000Z", gate: { reason: "issue_busy", short: "Another job active", detail: "Another job is already active on this issue.", who: "Wait for the active run to finish.", needsAction: false } } }} step="—" slug="hop" issueId="i1" />
          <AwaitingReleaseBanner projectId={P} issueId="i1" canWrite />
        </>,
      ),
  },
  { name: "Issue dialogs", render: () => wrap(detailQueries(), <Dialogs />) },
  { name: "Mark merged dialog", render: () => wrap([], <MergeMarkerControl issueId="i1" mergedAt={null} suggestedTarget="ISS-1" landingShape="outside_git" />), act: click("button") },
  {
    name: "Module picker",
    render: () =>
      wrap(
        [[["project", P, "labels"], [{ id: "m1", name: "Don", kind: "module" }, { id: "m2", name: "Kho", kind: "module" }]]],
        <ModulePicker open onClose={noop} issueId="i1" projectId={P} slug="hop" labels={[]} />,
      ),
  },
];
