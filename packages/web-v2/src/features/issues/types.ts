import type { IssueMove } from "@forge/contracts/issue-machine";

import type { BodyNode } from "@forge/contracts/body-components";
import type { CommentIntent } from "@forge/contracts/record-events";
import type { ForgeRecordView, RecordLens } from "@forge/contracts/forge-record";
import type { ReleaseNotes } from "@forge/contracts/issues";
import type { NeedsInfoKind, WorkStep } from "@forge/contracts/issue-vocabulary";
import {
  ISSUE_STATUSES as MACHINE_ISSUE_STATUSES,
  type IssueStatus,
} from "@forge/contracts/issue-machine";
import {
  REGISTRY_ISSUE_COMPLEXITIES,
  REGISTRY_ISSUE_PRIORITIES,
} from "@forge/contracts/pipeline-registry";
import type { StageKey } from "@/design/stages";
import type { StatusKey } from "@/design/status";

/** The kinds of merged mark core reads off an issue (`merge-record.ts`). */
export type MergeMarkKind = "unmarked" | "asserted" | "landed" | "observed";
/** `git`: work lands as commits. `outside_git`: it lands as a live resource, and a mark names it. */
export type LandingShape = "git" | "outside_git";

export type { IssueStatus };

export type IssuePriority = (typeof REGISTRY_ISSUE_PRIORITIES)[number];
export type IssueComplexity = (typeof REGISTRY_ISSUE_COMPLEXITIES)[number];

/** Runtime arrays for inline-edit option lists (registry order). */
export const ISSUE_STATUSES: IssueStatus[] = [...MACHINE_ISSUE_STATUSES];
export const ISSUE_PRIORITIES: IssuePriority[] = [...REGISTRY_ISSUE_PRIORITIES];
export const ISSUE_COMPLEXITIES: IssueComplexity[] = [...REGISTRY_ISSUE_COMPLEXITIES];

/** Agent run status hydrated by the search endpoint (`withAgentSessions=1`). */
export type IssueAgentStatus = "running" | "queued" | "completed" | "failed" | "cancelled" | null;

export interface IssueAgentSession {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  deviceId?: string | null;
  /** The runner's name (`devices.name`), so the live-run UI shows where a run executes. */
  deviceName: string | null;
  startedAt?: string | null;
  lastHeartbeatAt?: string | null;
  pipelineRunId?: string | null;
  claudeSessionId?: string | null;
  /** Core's reading of `lastHeartbeatAt` against the loop monitor's heartbeat timeout. */
  heartbeat: "alive" | "stale" | "unknown";
  /** Whether it resumed its group's Claude session or started fresh, and why (core's). */
  continuity: SessionContinuity;
  freshReason: FreshReason | null;
}

export type SessionContinuity = "resumed" | "fresh" | "unknown";
export type FreshReason = "first-in-group" | "different-device" | "prior-failed" | "new-session";

/** ISS-700 — the latest failed job for this issue, present when the search
 *  call opts in with `withFailureInfo=1` (the list always does). `null` means
 *  no failed job exists for the issue. */
export interface IssueFailureInfo {
  /** Job type: triage|clarify|plan|code|review|test|release|fix|… */
  failedStep: string;
  failureReason: string | null;
  failureKind: string | null;
  failedAt: string;
}

/** A label's taxonomy role. Modules ARE labels; `kind` is the only thing that separates them. */
export type LabelKind = "label" | "module";

export type { IssuePark, IssueParkResponse, ParkOwes, ParkResume } from "@forge/contracts/park";

/** One step a run entered inside its status, as core's `issue_work_state.steps` log holds it. */
export interface WorkStepEntry {
  step: WorkStep;
  startedAt: string;
  endedAt: string | null;
}

/**
 * ISS-54 — where an issue's work stands inside its status, as a list row carries it (core
 * `issues/work-state.ts` `WorkStateListView`). The status says who the issue waits on; this says
 * the run's step, who holds it, what it built, and the status a park (`needs_info`, `on_hold`) left
 * and returns to. `null` on the row where the issue has no work state at all.
 */
export interface IssueWorkStateRow {
  step: WorkStep | null;
  stepStartedAt: string | null;
  leaseHolder: string | null;
  branch: string | null;
  headSha: string | null;
  leftStatus: IssueStatus | null;
}

/** The detail read's work state: the list row's, plus the step log. */
interface IssueWorkState extends IssueWorkStateRow {
  steps: WorkStepEntry[];
}


export interface IssueRow {
  id: string;
  projectId: string;
  issSeq: number;
  displayId: string;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  category: string | null;
  complexity: IssueComplexity | null;
  assigneeId: string | null;
  createdById: string;
  /** ISS-756 — never rendered raw; always go through `creatorLabelOf`. */
  creatorEmail: string | null;
  creatorIsAgent: boolean;
  creatorLabel: string;
  reopenCount: number;
  mergedAt: string | null;
  /** ISS-959 — the commit, present only on a merge Forge observed. */
  mergedCommitSha?: string | null;
  /** ISS-1126 — which kind of record `mergedAt` is. Derived by core, never here. */
  mergeMark?: MergeMarkKind;
  /** ISS-1327 — where the work landed outside git, on a mark that named one. */
  mergedLanding?: string | null;
  /** ISS-1327 — what this issue's project accepts as landed; core's answer, never re-derived.
   *  `null` where the project declares no project document, so no `source.type`. */
  landingShape?: LandingShape | null;
  /** ISS-1217 — whether the merged work is on the live branch. Core's reading; null where none. */
  liveReach?: LiveReach | null;
  createdAt: string;
  updatedAt: string;
  /** ISS-1257 — the oldest open question blocked on a person; null or absent when none is. */
  waitingOnPersonSince?: string | null;
  agentSessions?: IssueAgentSession[];
  agentStatus?: IssueAgentStatus;
  failureInfo?: IssueFailureInfo | null;
  /** ISS-764 — set when a batch release has claimed this issue. Non-null means
   *  the issue is locked into a batch and cannot be selected for a new one. */
  releaseBatchRunId?: string | null;
  pipelineHealth?: PipelineHealth;
  dependencies?: IssueDependencies;
  /** ISS-54 — the run's step and the status a park left; absent from a server older than ISS-54. */
  workState?: IssueWorkStateRow | null;
  /** The moves a person may offer from its status, from core's list read. */
  moves: IssueMove[];
}

/** Project member row from `GET /api/projects/:projectId/members`. */
export interface ProjectMember {
  userId: string;
  email: string;
  /** The name an admin or the member typed; null until somebody has. */
  displayName: string | null;
  /** ISS-1137 — an agent account is a project member like any other. */
  kind: "human" | "agent";
  role: string;
  createdAt: string;
}

/** Per-issue cost rollup from `GET /api/issues/:id/cost-summary`. */
export interface IssueCostSummary {
  issueId: string;
  projectId: string;
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

export type IssueDependencyKind =
  | "blocks"
  | "relates"
  | "duplicates"
  | "parent"
  | "decomposes";

export interface IssueDependencyEdge {
  id: string;
  fromIssueId: string;
  toIssueId: string;
  kind: IssueDependencyKind;
  reason: string | null;
  createdAt: string;
  validUntil?: string | null;
  /** Retracted: `validUntil` has passed. The server decides it; an expired edge counts as nothing. */
  expired: boolean;
  /** A live `blocks` edge whose blocker still holds this issue back; core decides it. */
  holds: boolean;
  fromDisplayId?: string | null;
  fromTitle?: string | null;
  fromStatus?: IssueStatus | null;
  fromMergedAt?: string | null;
  fromDesignHold?: string | null;
  toDisplayId?: string | null;
  toTitle?: string | null;
  toStatus?: IssueStatus | null;
}

export interface IssueDependencies {
  outgoing: IssueDependencyEdge[];
  incoming: IssueDependencyEdge[];
}

/** The toolbar's status segment. */
export type IssueFilter = "open" | "closed" | "all";

/** Client-side grouping for the list. */
export type GroupBy = "none" | "status" | "priority" | "creator";

export type IssueSort =
  | "createdAt:desc"
  | "createdAt:asc"
  | "updatedAt:desc"
  | "updatedAt:asc"
  | "priority:desc"
  | "priority:asc";

/** Options passed to the search endpoint via the `useIssues` hook. `priority`
 *  maps 1:1 onto the server search params (ISS-436 — the endpoint always
 *  supported them; the UI just never exposed a control). */
export interface IssueSearchOpts {
  q?: string;
  filter?: IssueFilter;
  priority?: IssuePriority;
  /** Member userId, or the literal "agent" (ISS-756). */
  createdBy?: string;
  /** Member userId the issue is assigned to (ISS-47). */
  assignee?: string;
  /** Label uuid — maps to `?label=<id>` on the search endpoint (ISS-586). */
  label?: string;
  /** Module label uuid — maps to `?module=<id>` (ISS-594). Distinct from
   *  `label`: the server resolves it against `kind='module'` rows only. */
  module?: string;
  /** Exact statuses, from the list's `?status=` parameter. When present it
   *  REPLACES the tab filter's status set, so a dashboard figure's destination
   *  is the bucket it was drawn from rather than the nearest tab (ISS-988). */
  status?: IssueStatus[];
  sort?: IssueSort;
  page?: number;
  pageSize?: number;
}

/** Full issue row from `GET /api/issues/:id` — includes `pipelineHealth`,
 *  joined `labels[]`, `mergedAt`, `reopenCount`, `metadata`, `plan`, AC. */
export interface IssueLabel {
  id: string;
  projectId?: string;
  name: string;
  color: string;
  kind: LabelKind;
  parentId?: string | null;
  slug?: string | null;
  knowledgeEntryId?: string | null;
  description?: string | null;
  /** Only on an issue's joined `labels[]` — true for the issue's primary module. */
  isPrimary?: boolean;
}

export interface IssueDetail extends IssueRow {
  description: string | null;
  plan: string | null;
  acceptanceCriteria: string | null;
  /** ISS-898 — the renderer the description was stored for. */
  descriptionFormat?: string | null;
  /** ISS-898 — the root component name, null for prose and every markdown row. */
  descriptionTemplate?: string | null;
  descriptionNodes?: BodyNode[] | null;
  labels?: IssueLabel[];
  metadata: Record<string, unknown> | null;
  /** Opaque to the page except `runRelease`, the time a person started the issue on a manual-intake project. */
  sessionContext?: Record<string, unknown> | null;
  /** ISS-1176 — the release note, whose `userFacing` line is the one sentence written for the person who filed. */
  releaseNotes?: ReleaseNotes | null;
  workState?: IssueWorkState | null;
}

/** Why the dispatcher hasn't picked up the issue's next step. Mirrors core
 *  `PipelineWaitingReason` (`issues/pipeline-health.ts`). */
export type WaitingReason =
  | "issue_busy"
  | "job_held"
  | "run_not_running"
  | "retry_cooldown"
  | "runner_stale"
  | "runner_too_old";

/** What a `needs_info` park is stopped on — required by the server at `needs_info`, null elsewhere. */
export type WaitingCause = NeedsInfoKind;

/** ISS-903 — the queued candidate, as core projects it. */
export interface PipelineHealthQueuedStep {
  jobId: string;
  jobType: string;
  stageStatus: string | null;
  queuedAt: string;
  retryAfterAt: string | null;
}

/** Server-derived pipeline health for one issue. Mirrors core `PipelineHealth`
 *  (`issues/pipeline-health.ts:69-79`); `stage` is the single status→stage
 *  projection (do not re-derive a second mapping). */
export interface PipelineHealth {
  stage: string;
  activeSession?: { id: string; status: "queued" | "running"; skill: string };
  waitingOn?: { reason: WaitingReason; since: string; details: Record<string, unknown>; reading: PipelineReading };
  queuedAt?: string;
  queuedStep?: PipelineHealthQueuedStep;
  /** Only set when `stage === "needs_info"`: what the park is stopped on. */
  waitingCause?: { kind: WaitingCause };
  /** ISS-853 — the issue's paused pipeline run. Present whatever the issue's own
   *  status says and whether or not a step is queued behind it, which is the
   *  whole point: `waitingOn` reaches a pause only through a queued job. */
  pausedRun?: PipelineHealthPausedRun;
}

export type PauseResumer = "operator" | "machine" | "sweeper";

/** A gate or a pause as core reads it to a person: what holds the step, who acts, whether it clears itself. */
export interface PipelineReading {
  short: string;
  detail: string;
  who: string;
  needsAction: boolean;
}

export interface PipelineHealthPausedRun {
  runId: string;
  pauseReason: string | null;
  kind: string | null;
  detail: string | null;
  resumer: PauseResumer;
  since: string;
  reading: PipelineReading;
}

/** Attachment carried on a comment node (ISS-363) — `url` is the download path,
 *  render through `coreFileUrl`. Mirrors core's `CommentAttachmentLite`. */
export interface CommentAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
  createdAt: string;
}

export interface ResolvedActor {
  type: "user" | "device";
  id: string;
  displayName: string;
  isAgent: boolean;
  deviceId?: string;
  ownerEmail?: string;
}

/** Comment node (tree) from `GET /api/issues/:id/comments`. */
export interface CommentNode {
  id: string;
  issueId: string;
  authorId: string;
  /** ISS-967 — parsed tree for a `format:'html'` body, null otherwise. */
  nodes: BodyNode[] | null;
  /**
   * ISS-1089 — the comment's `forge-record`, with the project's lens. ISS-56: its content comes
   * from the typed event it was mirrored into (`source: "event"`), or the fence of a legacy comment.
   */
  record:
    | (ForgeRecordView & {
        lens: RecordLens;
        source?: "event" | "comment";
        eventId?: string | null;
      })
    | null;
  /** ISS-56 — what the comment means to do. */
  intent?: CommentIntent;
  /** ISS-56 — what the comment is about (its arc target). */
  scope?: "issue";
  /** ISS-932 wave 4 — the BOX a credential was issued to. Answers *where*, never *who*. */
  authorDeviceId?: string | null;
  body: string;
  /** `markdown` (the default and every pre-existing row) or `html` (ISS-898). */
  format: string;
  template: string | null;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  replies: CommentNode[];
  attachments: CommentAttachment[];
  /** Server-resolved author identity (ISS-519). */
  author?: ResolvedActor | null;
}

/** Activity log entry from `GET /api/issues/:id/activity`. */
export interface ActivityItem {
  id: string;
  issueId: string;
  action: string;
  actorType: string;
  actorId: string | null;
  /** Server-resolved actor identity (ISS-519). */
  actor?: ResolvedActor | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/** Per-file failure from the inline create's `attachments[]`, as core returns it
 *  on the 201 body (`issues/routes.ts` sets `attachmentErrors`). Mirrors core's
 *  `AttachmentErrorEntry`. */
export interface AttachmentErrorEntry {
  index: number;
  name: string;
  code: string;
  message: string;
}

/** `POST /api/projects/:id/issues` — the created issue, plus whatever it could
 *  NOT attach. A create that drops files answers 201 all the same, so a caller
 *  that ignores `attachmentErrors` reports a success the user did not get
 *  (ISS-963). */
export interface CreatedIssue extends IssueRow {
  attachmentErrors?: AttachmentErrorEntry[];
}

export interface AttachmentRow {
  id: string;
  issueId: string;
  uploaderId: string | null;
  name: string;
  mime: string;
  size: number;
  url: string;
  createdAt: string;
}

/**
 * Lifecycle comment kind. Read from `template` when the body is in component
 * form, and matched against the prose otherwise — `derive.ts:deriveCommentKind`.
 */
export type CommentKind =
  | "triage"
  | "clarify"
  | "plan"
  | "code"
  | "review"
  | "changes"
  | "fix"
  | "approved"
  | "qa"
  | "released"
  | "outcome"
  | "blocked"
  | "comment";

export type { StageKey, StatusKey };

export interface LiveReachCommit {
  sha: string;
  subject: string;
}

export interface LiveReachEvidence extends LiveReachCommit {
  via: "merged_commit" | "declares_issue" | "merged_in" | "recorded_head";
}

interface LiveReachMeasured {
  baseBranch: string;
  deploysFrom: string;
  measuredAt: string;
  baseSha: string;
  liveSha: string;
}

export type LiveReach =
  | (LiveReachMeasured & { state: "not_on_live"; evidence: LiveReachEvidence[] })
  | (LiveReachMeasured & { state: "none_waiting"; unowned: LiveReachCommit[] })
  | {
      state: "unmeasured";
      baseBranch: string | null;
      deploysFrom: string;
      measuredAt: string | null;
      reason: string;
    };
