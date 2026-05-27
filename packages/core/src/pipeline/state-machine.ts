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
  on_hold: issueStatuses.filter((s) => s !== 'on_hold' && s !== 'draft'),
  needs_info: ['open', 'confirmed', 'on_hold'],
  // ISS-236 — drafts are AI-generated proposals; user either promotes them
  // into the normal pipeline or discards them. No other status maps INTO draft.
  draft: ['open', 'closed'],
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
  // deploying sits between developed and testing in the lifecycle
  // (developed → deploying → testing), so skipping it lands on testing.
  deploying: 'testing',
  reopen: 'developed',
  released: 'closed',
};

export const SKIPPABLE_STAGES: ReadonlySet<IssueStatus> = new Set(
  Object.keys(STAGE_FORWARD) as IssueStatus[],
);

export const MAX_SKIP_CHAIN = 5;

/**
 * Stages config shape used by the skip-chain resolver. Mirrors the
 * `enabled`/`mode` subset of `pipeline-config-schema.ts:StageConfig` —
 * resolveSkipTarget only consults `.enabled`, so the wider per-state config
 * shape (skillName, model, etc.) is assignable here without modification.
 *
 * Kept as a structural type (no name overlap with the schema's StageConfig
 * export) so downstream typecheck doesn't trip on identical-name-different-shape
 * collisions across modules.
 */
export type StagesConfig = Partial<
  Record<
    IssueStatus,
    {
      enabled?: boolean;
      mode?: 'auto' | 'manual';
      [extra: string]: unknown;
    }
  >
>;

/**
 * Why a stage was skipped. ISS-239 extends the soft-skip resolver from a
 * boolean ("is the stage disabled?") to a typed predicate so observability
 * (Sentry breadcrumbs, pipeline_runs.metadata.skipChain) can distinguish
 * operator-initiated config disablement from runtime "no skill registered"
 * gaps.
 */
export type SkipReason = 'stage_disabled' | 'missing_skill';

export interface SkipHop {
  /** The destination stage of this hop. */
  to: IssueStatus;
  /** Why we left the previous stage to land on `to`. */
  reason: SkipReason;
}

export interface ResolveSkipOpts {
  /**
   * Returns true if the project has an enabled skill registered for `stage`.
   * When provided, a stage without a skill is treated as skippable (ISS-239).
   * When omitted, only `states[stage].enabled === false` qualifies — preserves
   * the ISS-110 contract used by `validateStatesConfig`.
   */
  hasSkill?: (stage: IssueStatus) => boolean;
}

export interface SkipResolution {
  /** Anchor stage we land on. Null only when `capped` is true. */
  to: IssueStatus | null;
  /** Stages visited during the walk, in order. */
  chain: IssueStatus[];
  /** Per-hop transitions with the reason the prior stage was skipped. */
  hops: SkipHop[];
  /** True when the walk exhausted MAX_SKIP_CHAIN without finding an anchor. */
  capped?: boolean;
}

function classifySkippable(
  stage: IssueStatus,
  states: StagesConfig | undefined,
  hasSkill: ((s: IssueStatus) => boolean) | undefined,
): SkipReason | null {
  if (states?.[stage]?.enabled === false) return 'stage_disabled';
  if (hasSkill && !hasSkill(stage)) return 'missing_skill';
  return null;
}

/**
 * Given the current status, the project's states config, and an optional
 * `hasSkill` predicate, return the next status to transition to if the
 * current stage is skippable — or null if the source is enabled /
 * non-skippable / has no forward path.
 *
 * Walks STAGE_FORWARD transitively up to MAX_SKIP_CHAIN hops, stopping at
 * the first non-skippable anchor (e.g. `approved`, `closed`) or the first
 * skippable stage that is both enabled AND has a registered skill (when a
 * predicate is supplied).
 *
 * Backward compat: callers that pass only `(from, states)` get the same
 * behavior as the original ISS-110 implementation — only `enabled === false`
 * qualifies a stage as skippable, and the return contains the same
 * `to` / `chain` fields. The new `hops` array is a superset; `validateStatesConfig`
 * only checks truthiness of the return.
 */
export function resolveSkipTarget(
  from: IssueStatus,
  states: StagesConfig | undefined,
  opts?: ResolveSkipOpts,
): SkipResolution | null {
  if (!SKIPPABLE_STAGES.has(from)) return null;
  const hasSkill = opts?.hasSkill;
  const sourceReason = classifySkippable(from, states, hasSkill);
  if (!sourceReason) return null;

  const chain: IssueStatus[] = [];
  const hops: SkipHop[] = [];
  let cursor: IssueStatus | undefined = STAGE_FORWARD[from];
  let prevReason: SkipReason = sourceReason;

  for (let hop = 0; hop < MAX_SKIP_CHAIN && cursor; hop++) {
    chain.push(cursor);
    hops.push({ to: cursor, reason: prevReason });

    if (!SKIPPABLE_STAGES.has(cursor)) {
      // Anchor stage (e.g. `approved`, `closed`) — chain terminates here.
      return { to: cursor, chain, hops };
    }
    const cursorReason = classifySkippable(cursor, states, hasSkill);
    if (!cursorReason) {
      // Skippable stage that is enabled AND has a skill — chain anchors here.
      return { to: cursor, chain, hops };
    }
    prevReason = cursorReason;
    cursor = STAGE_FORWARD[cursor];
  }
  return { to: null, chain, hops, capped: true };
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
