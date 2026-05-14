import { type IssueStatus, issueStatuses } from '../db/schema.js';

export { issueStatuses };
export type { IssueStatus };

// Per docs/modules/issues-pipeline/status-pipeline.md. Each key lists allowed
// NEXT statuses from that state. on_hold is a pause state — it may resume to
// any other status (operator discretion). needs_info bounces back through
// triage.
export const transitions: Record<IssueStatus, readonly IssueStatus[]> = {
  open: ['confirmed', 'needs_info', 'on_hold'],
  confirmed: ['waiting', 'approved', 'needs_info', 'on_hold'],
  waiting: ['approved', 'confirmed', 'on_hold'],
  approved: ['in_progress', 'on_hold'],
  in_progress: ['developed', 'deploying', 'reopen', 'on_hold'],
  developed: ['deploying', 'reopen', 'on_hold'],
  deploying: ['testing', 'reopen', 'on_hold'],
  testing: ['tested', 'pass', 'reopen', 'on_hold'],
  tested: ['pass', 'reopen', 'on_hold'],
  pass: ['staging', 'reopen', 'on_hold'],
  staging: ['released', 'reopen', 'on_hold'],
  released: ['closed', 'on_hold'],
  closed: ['reopen'],
  reopen: ['developed', 'deploying', 'in_progress', 'on_hold'],
  on_hold: issueStatuses.filter((s) => s !== 'on_hold'),
  needs_info: ['open', 'confirmed', 'on_hold'],
  // pipeline_failed is set by the self-healing sweeper when a recovery
  // budget is exhausted or a permanent failure is classified. From here
  // the only forward paths are: human re-triages back to `confirmed` (the
  // sweeper itself does this once per recovery window when the window
  // expires, giving the issue a fresh chance), `closed` (drop), or
  // `on_hold` (pause). It is NOT auto-progressed by the orchestrator.
  pipeline_failed: ['confirmed', 'closed', 'on_hold'],
};

export function getAllowedTransitions(from: IssueStatus): readonly IssueStatus[] {
  return transitions[from];
}

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return transitions[from].includes(to);
}

export const REOPEN_CAP = 5;

export function isReopenEntry(from: IssueStatus, to: IssueStatus): boolean {
  return from === 'closed' && to === 'reopen';
}

// Forward chain used by the soft-skip resolver (ISS-110). Each skippable
// stage maps to its canonical next status in the pipeline DAG. Statuses not
// listed here are non-skippable (`approved` needs a human/autoCode,
// `in_progress` is mid-job, `closed` is terminal). The map is forward-only
// so the resolver is guaranteed to terminate.
export const STAGE_FORWARD: Partial<Record<IssueStatus, IssueStatus>> = {
  open: 'confirmed',
  confirmed: 'approved',
  developed: 'testing',
  testing: 'pass',
  tested: 'pass',
  pass: 'staging',
  staging: 'released',
  deploying: 'testing',
  reopen: 'developed',
  released: 'closed',
};

export const SKIPPABLE_STAGES: ReadonlySet<IssueStatus> = new Set(
  Object.keys(STAGE_FORWARD) as IssueStatus[],
);

export const MAX_SKIP_CHAIN = 5;

export interface StageConfig {
  enabled?: boolean;
  mode?: 'auto' | 'manual';
}

export type StagesConfig = Partial<Record<IssueStatus, StageConfig>>;

/**
 * Given the current status and the project's states config, return the next
 * status to transition to if the current one is disabled — or null if the
 * current stage is enabled / non-skippable / no forward exists.
 *
 * Walks STAGE_FORWARD transitively up to MAX_SKIP_CHAIN hops, stopping at
 * the first non-skippable stage or the first enabled skippable stage.
 */
export function resolveSkipTarget(
  from: IssueStatus,
  states: StagesConfig | undefined,
): { to: IssueStatus; chain: IssueStatus[] } | null {
  if (!states) return null;
  if (!SKIPPABLE_STAGES.has(from)) return null;
  if (states[from]?.enabled !== false) return null;

  const chain: IssueStatus[] = [];
  let cursor: IssueStatus | undefined = STAGE_FORWARD[from];
  for (let hop = 0; hop < MAX_SKIP_CHAIN && cursor; hop++) {
    chain.push(cursor);
    const isSkippable = SKIPPABLE_STAGES.has(cursor);
    const disabled = isSkippable && states[cursor]?.enabled === false;
    if (!disabled) return { to: cursor, chain };
    cursor = STAGE_FORWARD[cursor];
  }
  return null;
}

export interface StatesValidationError {
  code: 'DEAD_END_CONFIG';
  unreachable: IssueStatus[];
}

/**
 * Reject configs where disabling stages would strand issues. Run at save
 * time (PATCH /pipeline-config). A stage is unreachable when the transitive
 * close from it walks off the end of STAGE_FORWARD without hitting a
 * non-skippable / enabled stage within MAX_SKIP_CHAIN hops.
 */
export function validateStatesConfig(
  states: StagesConfig | undefined,
): StatesValidationError | null {
  if (!states) return null;
  const unreachable: IssueStatus[] = [];
  for (const stage of SKIPPABLE_STAGES) {
    if (states[stage]?.enabled === false) {
      const target = resolveSkipTarget(stage, states);
      if (!target) unreachable.push(stage);
    }
  }
  return unreachable.length > 0 ? { code: 'DEAD_END_CONFIG', unreachable } : null;
}
