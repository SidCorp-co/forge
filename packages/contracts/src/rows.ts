import type { schema } from '@forge/core/public';

export type User = Pick<
  typeof schema.users.$inferSelect,
  'id' | 'email' | 'emailVerifiedAt' | 'createdAt'
>;

export type Project = typeof schema.projects.$inferSelect;

type PipelineWaitingReason =
  | 'issue_busy'
  | 'job_held'
  | 'run_not_running'
  | 'retry_cooldown'
  | 'runner_stale'
  | 'runner_too_old';

type WaitingCause = 'needs_answer' | 'needs_decision' | 'needs_resource';

export interface PipelineHealth {
  stage: schema.IssueStatus;
  activeSession?: { id: string; status: 'queued' | 'running'; skill: string };
  waitingOn?: {
    reason: PipelineWaitingReason;
    since: string;
    details: Record<string, unknown>;
  };
  queuedAt?: string;
  /** Only set when `stage === 'needs_info'`: what the park is stopped on. */
  waitingCause?: { kind: WaitingCause };
}

export type ModelTier = schema.ModelTier;

export type ProjectMember = typeof schema.projectMembers.$inferSelect;

export interface ModuleCounts {
  total: number;
  open: number;
  closed: number;
  dropped: number;
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

// ISS-271 — runner row now carries the per (device × project) repo checkout
// (`repoPath`/`branch`), the server source of truth for the runner working dir.
// ISS-546/ISS-556 — improvement-message registry type (cross-app parity).
// Pure data shape; no DB import needed — the registry is a git-committed module.
