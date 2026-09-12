// Row types derived from Drizzle `$inferSelect` on the canonical DB schema.
// These are the shapes clients receive from `packages/core` REST responses.
//
// Using `$inferSelect` directly (rather than `InferSelectModel<typeof T>`)
// sidesteps cross-package variance on drizzle-orm's protected `Column.config`
// field, which surfaces as a TS2344 constraint violation when the consumer
// resolves a different drizzle-orm copy than `@forge/core`.

import type { schema } from '@forge/core/public';

export type User = Pick<
  typeof schema.users.$inferSelect,
  'id' | 'email' | 'emailVerifiedAt' | 'createdAt'
>;

export type Project = typeof schema.projects.$inferSelect;

// cm:edge contract -> packages/core/src/issues/pipeline-health.ts — ISS-164: that loader derives every member of this union server-side, and the FE renders what it is told rather than re-deriving it; a reason added there and not here renders as nothing at all.
export type PipelineWaitingReason =
  | 'issue_busy'
  | 'job_held'
  | 'run_not_running'
  | 'retry_cooldown'
  | 'runner_stale'
  | 'runner_too_old';

// cm:edge contract -> packages/core/src/db/schema.ts — mirrors `waitingKinds`; a value here that core cannot store renders a banner nothing can produce, and the reverse leaves an authored kind falling through to generic copy
export type WaitingCause = 'needs_decision' | 'needs_resource';

export interface PipelineHealth {
  stage: schema.IssueStatus;
  activeSession?: { id: string; status: 'queued' | 'running'; skill: string };
  waitingOn?: {
    reason: PipelineWaitingReason;
    since: string;
    details: Record<string, unknown>;
  };
  queuedAt?: string;
  /** Only set when `stage === 'waiting'`. */
  waitingCause?: { kind: WaitingCause };
}

// cm:edge contract -> packages/core/src/db/schema.ts — the `model_tier` enum, shared so a client's model picker cannot offer a tier POST /api/agent-sessions/{start,send} would reject (ISS-718)
export type ModelTier = schema.ModelTier;

export type ProjectMember = typeof schema.projectMembers.$inferSelect;

export type Label = typeof schema.labels.$inferSelect;

// cm:edge contract -> packages/core/src/db/schema.ts — `labelKinds`, shared so a client cannot build a filter or a picker on a kind the server would reject
export type LabelKind = schema.LabelKind;

/**
 * ISS-593 — how one module reads on an issue. The shape core returns in every `labels[]` entry
 * (REST issue detail, `by-display`, and the MCP `listIssueLabels` serializers); a client picks
 * the primary module out of that array by `isPrimary`, and there is no other source for it.
 */
export interface ModuleAttribution {
  labelId: string;
  name: string;
  color: string;
  isPrimary: boolean;
}

/**
 * ISS-951 — the drift signal: module pairs the issue stream links that the taxonomy does not
 * declare as connected. `layer` says which graph the report speaks about, and it is not the
 * source-path one; `nearestCommonAncestor` is the parent two undeclared cousins hang under, or
 * null when their subtrees are unrelated.
 */
// cm:edge contract -> packages/core/src/labels/module-drift.ts — the same three interfaces are declared there as the return of `moduleDrift`, and the route serializes that object unchanged; a field added on one side and not the other reads as `undefined` at every consumer
export interface ModuleDriftNode {
  labelId: string;
  name: string;
  slug: string | null;
  knowledgeEntryId: string | null;
}

export interface ModuleDriftEdge {
  a: ModuleDriftNode;
  b: ModuleDriftNode;
  /** Distinct issues carrying both modules — the weight of the edge. */
  issueCount: number;
  /** Of those, the ones where either module is the issue's primary. The rest are secondary×secondary. */
  primaryAnchoredIssueCount: number;
  recentIssueSeqs: number[];
  nearestCommonAncestor: ModuleDriftNode | null;
}

export interface ModuleDriftResponse {
  generatedAt: string;
  layer: 'module-taxonomy';
  minCoOccurrence: number;
  declaration: { state: 'present' | 'absent'; source: 'label-hierarchy'; edgeCount: number };
  observed: { moduleCount: number; edgeCount: number; belowThresholdEdgeCount: number };
  undeclared: ModuleDriftEdge[];
  unobserved: Array<{ a: ModuleDriftNode; b: ModuleDriftNode; issueCount: number }>;
  agreedEdgeCount: number;
}

// cm:edge contract -> packages/core/src/labels/module-rollup.ts — ISS-949: the rollup's response, re-declared for the same reason `ModuleAttribution` is, and because one more module reached from `public.ts` trips the coordinator-blob limit; a field added there and not here reaches no client
export interface ModuleCounts {
  total: number;
  open: number;
  closed: number;
  recentlyActive: number;
}

/** ISS-949 — primary and secondary attributions, counted apart and never summed. */
export interface ModuleAttributionCounts {
  primary: ModuleCounts;
  secondary: ModuleCounts;
}

export interface ModuleRollupRow {
  id: string;
  name: string;
  slug: string | null;
  color: string;
  parentId: string | null;
  depth: number;
  /** Issues attributed to this module itself. */
  own: ModuleAttributionCounts;
  /** Issues attributed to a descendant, minus what `own` already counts for that kind. */
  inherited: ModuleAttributionCounts;
  /** `own + inherited`, which is addition exactly because `inherited` excluded the overlap. */
  rollup: ModuleAttributionCounts;
}

export interface ModuleRollupResponse {
  activeWithinDays: number;
  generatedAt: string;
  modules: ModuleRollupRow[];
  /** Issues carrying no module attribution at all. */
  unassigned: ModuleCounts;
}

// cm:edge contract -> packages/core/src/issues/routes.ts — `serializeIssue` is what adds `displayId` on top of the stored row, and `agentSessions`/`agentStatus` arrive ONLY under `?withAgentSessions=1` (ISS-128); no database row carries any of the three, so a client that reads them off a plain issue row gets `undefined` and no type error.
export type Issue = typeof schema.issues.$inferSelect & {
  displayId: string;
  agentSessions?: Array<{
    id: string;
    status: string;
    metadata: Record<string, unknown> | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    title: string | null;
  }>;
  agentStatus?: 'running' | 'queued' | 'completed' | 'failed' | null;
  /** ISS-437 — search endpoint only, under `?withCost=1`: per-issue usage rollup in USD,
   *  0 when the issue never produced any. */
  estimatedCost?: number;
  /** ISS-594 — search endpoint only, under `?withModules=1`: the issue's `kind='module'`
   *  attributions, primary first, `[]` when it has none. */
  modules?: ModuleAttribution[];
  pipelineHealth: PipelineHealth;
};

export type Comment = typeof schema.comments.$inferSelect;

export type Job = typeof schema.jobs.$inferSelect;

export type JobEvent = typeof schema.jobEvents.$inferSelect;

export type Device = typeof schema.devices.$inferSelect;

// cm:why ISS-305 — this grant code mints a DEVICE token; the desktop user-JWT pairing flow is a separate path and the two are not interchangeable
export type DeviceLoginCode = typeof schema.deviceLoginCodes.$inferSelect;

// ISS-271 — runner row now carries the per (device × project) repo checkout
// (`repoPath`/`branch`), the server source of truth for the runner working dir.
export type Runner = typeof schema.runners.$inferSelect;

export type ActivityLog = typeof schema.activityLog.$inferSelect;

export type SkillActivityEventRow = typeof schema.skillActivityEvents.$inferSelect;

export type UpdatePacketRow = typeof schema.updatePackets.$inferSelect;

export type KnowledgeEntry = typeof schema.knowledgeEntries.$inferSelect;

// ISS-546/ISS-556 — improvement-message registry type (cross-app parity).
// Pure data shape; no DB import needed — the registry is a git-committed module.
export type ImprovementMessageCategory =
  | 'code-quality'
  | 'testing'
  | 'documentation'
  | 'performance'
  | 'security'
  | 'dx'
  | 'ops'
  | 'pipeline-correctness'
  | 'quality'
  | 'steward'
  | 'general';

export interface ImprovementMessage {
  key: string;
  title: string;
  message: string;
  rationale: string;
  appliesToSkills?: readonly string[];
  appliesWhen?: string;
  category: ImprovementMessageCategory;
  version: number;
  recommended: boolean;
  defaultMode: 'propose' | 'auto';
  /** When true, the dispatch engine bypasses the appliedMessageVersions gate and fires every run. */
  standing?: boolean;
}

export interface ImprovementMessageEntry extends ImprovementMessage {
  enablement: {
    enabled: boolean;
    scheduleId: string;
    mode: string;
    cron: string;
  } | null;
}

export type UxContractRuleRow = typeof schema.uxContractRules.$inferSelect;
export type UxFindingRow = typeof schema.uxFindings.$inferSelect;


// cm:why ISS-800 — Divergence Charter row type, Update Pipeline §5
export type DivergenceCharterRow = typeof schema.divergenceCharters.$inferSelect;
