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

import type { StageKey } from "@/design/stages";
import type { StatusKey } from "@/design/status";

/** Lifecycle status enum (`issueStatuses` in core schema). */
export type IssueStatus =
  | "open"
  | "confirmed"
  | "clarified"
  | "waiting"
  | "approved"
  | "in_progress"
  | "developed"
  | "deploying"
  | "testing"
  | "tested"
  | "pass"
  | "staging"
  | "released"
  | "closed"
  | "reopen"
  | "on_hold"
  | "needs_info"
  | "draft";

export type IssuePriority = "critical" | "high" | "medium" | "low" | "none";
export type IssueComplexity = "xs" | "s" | "m" | "l" | "xl";

/** Runtime arrays for inline-edit option lists — kept in lockstep with the
 *  unions above (the source of truth is `db/schema.ts`). */
export const ISSUE_STATUSES: IssueStatus[] = [
  "open", "confirmed", "clarified", "waiting", "approved", "in_progress", "developed",
  "deploying", "testing", "tested", "pass", "staging", "released", "closed",
  "reopen", "on_hold", "needs_info", "draft",
];
export const ISSUE_PRIORITIES: IssuePriority[] = ["critical", "high", "medium", "low", "none"];
export const ISSUE_COMPLEXITIES: IssueComplexity[] = ["xs", "s", "m", "l", "xl"];

/** Agent run status hydrated by the search endpoint (`withAgentSessions=1`). */
export type IssueAgentStatus = "running" | "queued" | "completed" | "failed" | null;

/** Hydrated agent session summary (search endpoint, `withAgentSessions`). */
export interface IssueAgentSession {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  title: string | null;
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
  manualHold: boolean;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentSessions?: IssueAgentSession[];
  agentStatus?: IssueAgentStatus;
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
 *  excludes drafts" rule); there is no separate drafts tab. */
export type IssueFilter = "all" | "active" | "review" | "blocked";

/** Client-side grouping for the list. */
export type GroupBy = "none" | "status" | "priority" | "assignee";

export type IssueSort =
  | "createdAt:desc"
  | "createdAt:asc"
  | "updatedAt:desc"
  | "updatedAt:asc"
  | "priority:desc"
  | "priority:asc";

/** Options passed to the search endpoint via the `useIssues` hook. */
export interface IssueSearchOpts {
  q?: string;
  filter?: IssueFilter;
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
  pipelineHealth?: { stage: string; [key: string]: unknown };
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

/** Comment node (tree) from `GET /api/issues/:id/comments`. */
export interface CommentNode {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  replies: CommentNode[];
  attachments: CommentAttachment[];
}

/** Activity log entry from `GET /api/issues/:id/activity`. */
export interface ActivityItem {
  id: string;
  issueId: string;
  action: string;
  actorType: string;
  actorId: string | null;
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
