/**
 * ISS-164 — the wire shapes of `pipelineHealth`.
 *
 * Split from `pipeline-health.ts` so its two halves — the loader/classifier and
 * the per-gate reason builders in `pipeline-health-reasons.ts` — can both name
 * these without importing each other. Declarations only; no db, no logic.
 * `pipeline-health.ts` re-exports every name here, which is the path consumers
 * import from.
 */

import type { IssueStatus, WaitingKind } from '../db/schema.js';
import type { RunnerAvailability } from '../jobs/dispatch-gates.js';

// cm:guard `job_held` is the ONLY thing that makes RFC 0002 honest — a held job leaves the issue at its stage entry-status, so without this reason the board shows an issue that looks idle and actionable while a step is in fact waiting on a machine. Delete it and you have rebuilt the ambiguity the RFC removed, on the other axis.
// cm:guard every reason the dispatch CASE can return needs a member here, or the issue renders as idle-and-actionable while the picker refuses it — `run_not_running` and `runner_stale` were the two missing ones, and they are the two that never clear on their own: measured 2026-08-14, forge-dev ISS-576/ISS-652 sat under a `paused` run since 08-11 and 11 jobs across 5 projects sat behind dead runners for 6-22 days, all of them showing NO waitingOn at all.
// cm:edge lockstep -> packages/core/src/jobs/dispatch-gates.ts#buildGateReasonCase — that CASE is the authority on which gates exist; a reason added there and not here is invisible to every UI
export type PipelineWaitingReason =
  | 'issue_busy'
  | 'job_held'
  | 'run_not_running'
  | 'retry_cooldown'
  | 'stale_trigger'
  | 'waiting_on_dep'
  | 'waiting_on_decomp_children'
  | 'project_full'
  | 'runner_stale'
  | 'runner_full';

/**
 * Why an issue is at `status='waiting'` — AUTHORED by whoever parked it, never
 * derived. Both values mean "a human is needed"; they differ in what the human
 * has to supply.
 */
// cm:guard this is now a pass-through of `issues.waiting_kind`, and it must stay one (RFC 0002 INV-5) — the five-way derivation it replaced read `merged_at`, the decompose-child count and a best-effort jsonb `pauseReason`, and on ISS-163 that jsonb write had silently failed, so a reopen-cap park read back as `merged_parked` and the UI rendered no override button at all. A NULL kind renders generic copy; inferring one is how that bug returns.
export type WaitingCause = WaitingKind;

export interface PipelineHealth {
  stage: IssueStatus;
  activeSession?: { id: string; status: 'queued' | 'running'; skill: string };
  waitingOn?: {
    reason: PipelineWaitingReason;
    since: string;
    details: Record<string, unknown>;
  };
  queuedAt?: string;
  /** ISS-903 — the identity of the step the oldest queued job represents, set
   *  whenever the issue HAS a queued job, gated or not. `waitingOn` says why it
   *  has not dispatched; this says what has not dispatched. */
  // cm:guard set this from the queued candidate even when `waitingOn` reports a HELD sibling — a queued step that is invisible on the surfaces derived from `agent_sessions` is exactly the blind spot ISS-903 closed, and a held-plus-queued issue is the case where the queued half is easiest to drop
  queuedStep?: PipelineHealthQueuedStep;
  lastTickAt?: string;
  /** Only set when `stage === 'waiting'`. */
  waitingCause?: { kind: WaitingCause };
}

/** ISS-903 — the queued candidate, projected for a human surface. */
export interface PipelineHealthQueuedStep {
  jobId: string;
  jobType: string;
  /** `payload.stageStatus` — null for jobs nobody declared a trigger for. */
  stageStatus: string | null;
  queuedAt: string;
  /** `jobs.retry_after_at` — the next attempt time, when the step has one. */
  retryAfterAt: string | null;
}

export interface PipelineHealthSession {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
}

export interface PipelineHealthJob {
  id: string;
  type: string;
  status: string;
  queuedAt: Date;
  runnerId: string | null;
  agentSessionId: string | null;
  /** The hold reason when `status === 'held'` (`jobs/hold.ts`). */
  failureReason?: string | null;
  /** Parent `pipeline_runs.status`. The picker requires `running`. */
  pipelineRunStatus?: string | null;
  /** `payload.stageStatus` — the trigger status the enqueuer declared this job
   *  answers. Null for jobs nobody declared one for (pm, custom). */
  stageStatus?: string | null;
  /** `jobs.retry_after_at` — the picker's L1 cooldown gate outranks the
   *  staleness arm, so a job inside the fixed inter-attempt wait is not
   *  reported stale however stale it is. */
  retryAfterAt?: Date | null;
}

export interface PipelineHealthDep {
  fromIssueId: string;
  kind: string;
  fromStatus: string;
  /** Blocker's `issues.merged_at` — the L2 gate keys on this, not status. */
  fromMergedAt: Date | null;
}

/** Outgoing `kind='decomposes'` edge: this issue is the decompose PARENT and
 *  its forward jobs wait for every child to land (gate
 *  `decomposeChildrenPending`). */
export interface PipelineHealthDecompChild {
  childIssueId: string;
  status: string;
  mergedAt: Date | null;
}

export interface PipelineHealthRunnerSat {
  type: string;
  cap: number;
  inFlight: number;
}

export interface ClassifyInput {
  issue: { id: string; status: string; mergedAt: Date | null; waitingKind: WaitingKind | null };
  sessions: PipelineHealthSession[];
  jobs: PipelineHealthJob[];
  deps: PipelineHealthDep[];
  decompChildren: PipelineHealthDecompChild[];
  runningIssueIds: ReadonlySet<string>;
  runningIssueCount: number;
  cap: number;
  runnerInFlight: ReadonlyMap<string, PipelineHealthRunnerSat>;
  /** From `freshRunnerAvailability` — the picker's own runner-pool counts. */
  runnerPool: RunnerAvailability;
  lastTickAt: Date | null;
  /** Injectable clock for the retry-cooldown comparison; defaults to now. */
  now?: Date;
}
