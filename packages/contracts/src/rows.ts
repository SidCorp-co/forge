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
  | 'stale_trigger'
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
  lastTickAt?: string;
  /** Only set when `stage === 'waiting'`. */
  waitingCause?: { kind: WaitingCause };
}

// cm:edge contract -> packages/core/src/db/schema.ts — the `model_tier` enum, shared so a client's model picker cannot offer a tier POST /api/agent-sessions/{start,send} would reject (ISS-718)
export type ModelTier = schema.ModelTier;

export type ProjectMember = typeof schema.projectMembers.$inferSelect;

export type Label = typeof schema.labels.$inferSelect;

// Core serializes issues with a `displayId: "ISS-N"` added on top of the
// stored row (see `packages/core/src/issues/routes.ts:serializeIssue`).
// `agentSessions` / `agentStatus` are populated only when the caller opts in
// with `?withAgentSessions=1` (see ISS-128).
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
  // ISS-437 — search endpoint only, when the caller opts in with `?withCost=1`:
  // per-issue usage rollup in USD (0 when the issue never produced usage).
  estimatedCost?: number;
  // ISS-164 — list + single + by-display endpoints always populate this.
  pipelineHealth: PipelineHealth;
};

export type Comment = typeof schema.comments.$inferSelect;

export type Job = typeof schema.jobs.$inferSelect;

export type JobEvent = typeof schema.jobEvents.$inferSelect;

export type Device = typeof schema.devices.$inferSelect;

// ISS-305 — runner browser-approve device-login grant code (mints a device
// token, distinct from the desktop user-JWT pairing flow).
export type DeviceLoginCode = typeof schema.deviceLoginCodes.$inferSelect;

// ISS-271 — runner row now carries the per (device × project) repo checkout
// (`repoPath`/`branch`), the server source of truth for the runner working dir.
export type Runner = typeof schema.runners.$inferSelect;

export type ActivityLog = typeof schema.activityLog.$inferSelect;

export type SkillActivityEventRow = typeof schema.skillActivityEvents.$inferSelect;

export type UpdatePacketRow = typeof schema.updatePackets.$inferSelect;

// ISS-564 — Knowledge subsystem P0. Foundation row type only; no reader/writer yet.
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

// ISS-554 — improvement message draft (bottom-up proposal from a graduated candidate).
export interface ImprovementMessageDraft {
  id: string;
  key: string;
  title: string;
  message: string;
  rationale: string;
  appliesWhen: string | null;
  appliesToSkills: string[];
  category: string;
  status: 'pending_review' | 'published' | 'dismissed';
  source: 'bottom_up';
  candidateId: string | null;
  signalKey: string;
  sourceProjectId: string | null;
  createdAt: string;
  updatedAt: string;
}

// cm:why ISS-800 — Divergence Charter row type, Update Pipeline §5
export type DivergenceCharterRow = typeof schema.divergenceCharters.$inferSelect;
