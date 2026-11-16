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

// ISS-271 — runner row now carries the per (device × project) repo checkout
// (`repoPath`/`branch`), the server source of truth for the runner working dir.
