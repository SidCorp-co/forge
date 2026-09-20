
import type { BodyNode, ForgeRecordView, RecordLens } from "@forge/contracts";
import {
  REGISTRY_ISSUE_COMPLEXITIES,
  REGISTRY_ISSUE_PRIORITIES,
  REGISTRY_ISSUE_STATUSES,
} from "@forge/contracts/pipeline-registry";
import type { StageKey } from "@/design/stages";
import type { StatusKey } from "@/design/status";

/** Lifecycle status enum — derived from `@forge/contracts`, which is
 *  parity-tested against core `db/schema.ts` (`core/pipeline/registry.test.ts`). */
export type IssueStatus = (typeof REGISTRY_ISSUE_STATUSES)[number];

export type IssuePriority = (typeof REGISTRY_ISSUE_PRIORITIES)[number];
export type IssueComplexity = (typeof REGISTRY_ISSUE_COMPLEXITIES)[number];

/** Runtime arrays for inline-edit option lists (registry order). */
export const ISSUE_STATUSES: IssueStatus[] = [...REGISTRY_ISSUE_STATUSES];
export const ISSUE_PRIORITIES: IssuePriority[] = [...REGISTRY_ISSUE_PRIORITIES];
export const ISSUE_COMPLEXITIES: IssueComplexity[] = [...REGISTRY_ISSUE_COMPLEXITIES];

/** Agent run status hydrated by the search endpoint (`withAgentSessions=1`). */
export type IssueAgentStatus = "running" | "queued" | "completed" | "failed" | null;

export interface IssueAgentSession {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  deviceId?: string | null;
  /** ISS-411 — friendly runner name (`devices.name`) so the live-run UI shows
   *  WHERE a run executes by name, not a raw deviceId UUID. Optional for
   *  back-compat with a pre-411 server. */
  deviceName?: string | null;
  startedAt?: string | null;
  lastHeartbeatAt?: string | null;
  pipelineRunId?: string | null;
  claudeSessionId?: string | null;
}

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

export type {
  ModuleAttributionCounts,
  ModuleCounts,
  ModuleRollupResponse,
  ModuleRollupRow,
} from "@forge/contracts";

/** One module attributed to an issue. Primary first in every array core sends. */
export interface ModuleAttribution {
  labelId: string;
  name: string;
  color: string;
  isPrimary: boolean;
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
  mergeMark?: "unmarked" | "asserted" | "observed";
  createdAt: string;
  updatedAt: string;
  agentSessions?: IssueAgentSession[];
  agentStatus?: IssueAgentStatus;
  estimatedCost?: number;
  failureInfo?: IssueFailureInfo | null;
  /** ISS-764 — set when a batch release has claimed this issue. Non-null means
   *  the issue is locked into a batch and cannot be selected for a new one. */
  releaseBatchRunId?: string | null;
  pipelineHealth?: PipelineHealth;
  modules?: ModuleAttribution[];
  dependencies?: IssueDependencies;
}

/** Project member row from `GET /api/projects/:projectId/members`. */
export interface ProjectMember {
  userId: string;
  email: string;
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
  fromDisplayId?: string | null;
  fromTitle?: string | null;
  fromStatus?: IssueStatus | null;
  toDisplayId?: string | null;
  toTitle?: string | null;
  toStatus?: IssueStatus | null;
}

export interface IssueDependencies {
  outgoing: IssueDependencyEdge[];
  incoming: IssueDependencyEdge[];
}

export type IssueFilter = "all" | "draft" | "findings" | "you" | "agent" | "done";

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

export type WaitingCause = "needs_decision" | "needs_resource";

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
  waitingOn?: { reason: WaitingReason; since: string; details: Record<string, unknown> };
  queuedAt?: string;
  queuedStep?: PipelineHealthQueuedStep;
  /** Only set when `stage === "waiting"`. */
  waitingCause?: { kind: WaitingCause };
  /** ISS-853 — the issue's paused pipeline run. Present whatever the issue's own
   *  status says and whether or not a step is queued behind it, which is the
   *  whole point: `waitingOn` reaches a pause only through a queued job. */
  pausedRun?: PipelineHealthPausedRun;
}

export type PauseResumer = "operator" | "machine" | "sweeper";

export interface PipelineHealthPausedRun {
  runId: string;
  pauseReason: string | null;
  kind: string | null;
  detail: string | null;
  resumer: PauseResumer;
  since: string;
}

/** One step-handoff row from `GET /api/issue-step-contexts` (kind=handoff).
 *  `payload` is free-form jsonb — render defensively. */
export interface StepHandoffRow {
  id: string;
  projectId: string;
  issueId: string;
  pipelineRunId: string | null;
  kind: string;
  step: string;
  attempt: number;
  payload: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** One row from `GET /api/pipeline/step-durations` (project-window, filtered to
 *  this issue client-side). Per-stage duration + cost source (ISS-377 gap E). */
export interface StepDurationRow {
  runId: string;
  issueId: string | null;
  projectId: string;
  step: string;
  startedAt: string;
  finishedAt: string;
  durationSeconds: number;
  costUsd: number;
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
  /** ISS-1089 — the `forge-record` block core parsed, with the project's lens. */
  record: (ForgeRecordView & { lens: RecordLens }) | null;
  /** ISS-932 wave 4 — the BOX a credential was issued to. Answers *where*, never *who*. */
  authorDeviceId?: string | null;
  /** ISS-969 — who was at the keyboard, from the credential. NULL is "no evidence", not 'human'.
   *  The rendered marker is `author.isAgent`, which the server has already OR'd this into
   *  (ISS-1093); this field is here so a reader can tell an un-evidenced row from a human one. */
  authorAgency?: "human" | "agent" | null;
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

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done";

/** Task row from `GET /api/issues/:id/tasks`. */
export interface TaskRow {
  id: string;
  issueId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: IssuePriority;
  assigneeId: string | null;
  sortOrder: number;
  isAgentTask: boolean;
  createdAt: string;
  updatedAt: string;
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
