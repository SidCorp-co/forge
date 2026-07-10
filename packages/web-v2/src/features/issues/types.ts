// web-v2 feature module: issues (Issues view + Issue detail) — ISS-293/294.
//
// Types are re-typed to match the exact rows core returns. The canonical row
// types live in `@forge/contracts` (`Issue`, `Comment`, `ActivityLog`, …) but
// those derive from Drizzle `$inferSelect` and so type date columns as `Date`,
// whereas the REST JSON wire format serializes them as ISO strings. The search
// endpoint also OMITS `pipelineHealth` (only the plain list serializer adds it
// — see `packages/core/src/issues/search.ts`). So the list row is re-typed
// locally with string dates + optional `pipelineHealth`, mirroring how
// `features/sessions/types.ts` re-typed the flat `agent_sessions` row.

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

/** Hydrated agent session summary (search endpoint, `withAgentSessions`). The
 *  runner/heartbeat fields (ISS-377) are optional for back-compat — an older
 *  server that predates the hydrator extension simply omits them, and the
 *  live-agent panel degrades (hides device, falls back to `updatedAt`). */
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

/**
 * One issue row from `GET /api/projects/:id/issues/search`. The raw `issues`
 * row plus `displayId` (`ISS-<issSeq>`) and — when `withAgentSessions=1` —
 * `agentSessions[]` + `agentStatus`. `pipelineHealth` is NOT present on the
 * search response, so per-row pipeline stage is derived from `status`.
 */
export interface IssueRow {
  id: string;
  projectId: string;
  issSeq: number;
  displayId: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  category: string | null;
  complexity: IssueComplexity | null;
  assigneeId: string | null;
  parentIssueId: string | null;
  reopenCount: number;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentSessions?: IssueAgentSession[];
  agentStatus?: IssueAgentStatus;
  /** ISS-437 — per-issue usage rollup in USD, present when the search call
   *  opts in with `withCost=1` (the list always does). 0 = no usage recorded. */
  estimatedCost?: number;
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

/** One dependency edge from `GET /api/issues/:id/dependencies`. Each edge is
 *  enriched (ISS-331) with both endpoints' friendly `displayId` (`ISS-<seq>`),
 *  title, and status so relation chips render a clickable `ISS-X` link without
 *  extra fetches. The enrichment fields are optional/nullable for back-compat
 *  (a deleted endpoint or an older server omits them). */
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

/** Client-side filter tabs → server `status`/`statusNot` arrays. `all` means
 *  literally every issue INCLUDING drafts (ISS-360 reverses the ISS-236 "All
 *  excludes drafts" rule). `draft` and `done` are explicit buckets (ISS-438) —
 *  unlike the removed ISS-236 "All + drafts" split, they narrow rather than
 *  change what "All" means. */
export type IssueFilter = "all" | "draft" | "active" | "review" | "blocked" | "done";

/** Client-side grouping for the list. */
export type GroupBy = "none" | "status" | "priority" | "assignee";

export type IssueSort =
  | "createdAt:desc"
  | "createdAt:asc"
  | "updatedAt:desc"
  | "updatedAt:asc"
  | "priority:desc"
  | "priority:asc";

/** Options passed to the search endpoint via the `useIssues` hook. `priority`
 *  and `assignee` map 1:1 onto the server search params (ISS-436 — the
 *  endpoint always supported them; the UI just never exposed a control). */
export interface IssueSearchOpts {
  q?: string;
  filter?: IssueFilter;
  priority?: IssuePriority;
  /** Member userId. */
  assignee?: string;
  /** Label uuid — maps to `?label=<id>` on the search endpoint (ISS-586). */
  label?: string;
  sort?: IssueSort;
  page?: number;
  pageSize?: number;
}

// ─── Detail (Part B) ────────────────────────────────────────────────────────

/** Full issue row from `GET /api/issues/:id` — includes `pipelineHealth`,
 *  joined `labels[]`, `mergedAt`, `reopenCount`, `metadata`, `plan`, AC. */
export interface IssueLabel {
  id: string;
  projectId: string;
  name: string;
  color: string | null;
}

export interface IssueDetail extends IssueRow {
  plan: string | null;
  acceptanceCriteria: string | null;
  aiAcceptanceCriteria: string[] | null;
  suggestedSolution: string | null;
  labels?: IssueLabel[];
  metadata: Record<string, unknown> | null;
  pipelineHealth?: PipelineHealth;
}

/** Why the dispatcher hasn't picked up the issue's next step. Mirrors core
 *  `PipelineWaitingReason` (`issues/pipeline-health.ts`). */
export type WaitingReason =
  | "issue_busy"
  | "waiting_on_dep"
  | "waiting_on_decomp_parent"
  | "project_full"
  | "runner_full";

/** Server-derived pipeline health for one issue. Mirrors core `PipelineHealth`
 *  (`issues/pipeline-health.ts:69-79`); `stage` is the single status→stage
 *  projection (do not re-derive a second mapping). */
export interface PipelineHealth {
  stage: string;
  activeSession?: { id: string; status: "queued" | "running"; skill: string };
  waitingOn?: { reason: WaitingReason; since: string; details: Record<string, unknown> };
  queuedAt?: string;
  lastTickAt?: string;
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

/**
 * Resolved actor identity (ISS-519) — server-resolved `(type,id)` → display
 * identity. `user` → a human member (email); `device` → an agent (device name,
 * `isAgent: true`, optionally the owning member's email). An unresolvable actor
 * degrades to `displayName: "Unknown"`. Mirrors core `actor-resolution.ts`.
 */
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
  /** Non-null when posted by an agent/device (ISS-519). */
  authorDeviceId?: string | null;
  body: string;
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

/** Attachment row from `GET /api/issues/:id/attachments` — `url` is the
 *  download path, render through `coreFileUrl`. */
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

/** Lifecycle comment kind derived from the body (no server field). */
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
  | "comment";

export type { StageKey, StatusKey };
