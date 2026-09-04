/**
 * ISS-232 — git-aware Layer-2 dependency gate.
 *
 * The picker's L2 gate now asks "is the parent's `merged_at` NULL?" rather
 * than "is the parent's status in (released, closed)?" — status doesn't
 * carry merge state for trunk-based repos. The state-machine is the SSOT
 * writer: whenever an issue transitions OUT of
 * `pipelineConfig.mergeStates.baseBranch` (default `"released"`),
 * {@link markMergedIfLeavingBase} stamps `merged_at = now()`. Idempotent via
 * `WHERE merged_at IS NULL` so a crash + retry can't double-write.
 *
 * The writer lives here (not inside skill code) so a crash between
 * "skill pushed the merge" and "status transition committed" leaves
 * merged_at NULL — children stay blocked, which is correct (the merge may
 * not have made it to origin). Skill operators are responsible for
 * verifying the push BEFORE issuing the transition; the prompt builder
 * injects a merge-required block when stage matches mergeStates. That
 * injection was removed with the staged lane; the driver's own skill carries
 * the merge protocol now.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { type IssueStatus, issues, projects } from '../db/schema.js';

/** Drizzle transaction handle — same shape `withActorContext` accepts.
 *  `Parameters<…>` chains expand to the inner-callback argument type. */
type DrizzleTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Default merge state when `pipelineConfig.mergeStates.baseBranch` is unset. */
export const DEFAULT_BASE_MERGE_STATE: IssueStatus = 'released';
/** Default production-branch merge state — trunk-based projects keep this
 *  identical to {@link DEFAULT_BASE_MERGE_STATE}. */
export const DEFAULT_PRODUCTION_MERGE_STATE: IssueStatus = 'released';

export interface MergeStatesConfig {
  /** Transition out of this state stamps `issues.merged_at`. The L2 picker
   *  gate keys on this column to decide if `kind='blocks'` children can
   *  dispatch. */
  baseBranch: IssueStatus;
  /** Multi-branch projects use a distinct state for production merge; in
   *  trunk-based v2 this equals `baseBranch`. Future v3 will split into
   *  `merged_to_prod_at`. */
  productionBranch: IssueStatus;
}

/**
 * Pull `mergeStates` off a project's pipeline config. Accepts either the
 * `pipelineConfig` jsonb directly (orchestrator path — already has it
 * loaded) or the outer `agent_config` (state-machine path — only has the
 * project row). Probes one level deep for the `pipelineConfig` wrapper;
 * unknown shape falls back to defaults.
 */
export function resolveMergeStates(pipelineConfigOrAgentConfig: unknown): MergeStatesConfig {
  const obj = (pipelineConfigOrAgentConfig ?? {}) as Record<string, unknown>;
  const pipelineConfig =
    obj.pipelineConfig && typeof obj.pipelineConfig === 'object'
      ? (obj.pipelineConfig as Record<string, unknown>)
      : obj;
  const mergeStates =
    pipelineConfig.mergeStates && typeof pipelineConfig.mergeStates === 'object'
      ? (pipelineConfig.mergeStates as Record<string, unknown>)
      : {};
  const baseBranch =
    typeof mergeStates.baseBranch === 'string'
      ? (mergeStates.baseBranch as IssueStatus)
      : DEFAULT_BASE_MERGE_STATE;
  const productionBranch =
    typeof mergeStates.productionBranch === 'string'
      ? (mergeStates.productionBranch as IssueStatus)
      : DEFAULT_PRODUCTION_MERGE_STATE;
  return { baseBranch, productionBranch };
}

/**
 * Stamp `merged_at = now()` when an issue transitions OUT of its project's
 * merge state. No-op for every other transition. Idempotent via
 * `WHERE merged_at IS NULL` so the helper is safe to call on every
 * transition site (REST `/transition`, batch `/issues`, MCP-driven
 * `applyStatusTransition`, orchestrator soft-skip) without coordinating.
 *
 * Caller must invoke this inside the same transaction as the
 * `UPDATE issues.status` so a rollback drops both writes together.
 */
// cm:flow release/stamp — the hop OUT of the base branch stamps merged_at, and that stamp is what unblocks every kind='blocks' dependent; nothing here verifies a merge actually happened
export async function markMergedIfLeavingBase(
  tx: DrizzleTx,
  args: {
    issueId: string;
    projectId: string;
    fromStatus: IssueStatus;
    toStatus: IssueStatus;
  },
): Promise<{ stamped: boolean }> {
  // Real drizzle always returns an array; the `?? []` fallback keeps the
  // helper resilient under in-memory test mocks that don't stub a 2nd
  // select-chain call.
  const projectRows =
    (await tx
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, args.projectId))
      .limit(1)) ?? [];
  const { baseBranch } = resolveMergeStates(projectRows[0]?.agentConfig);
  if (args.fromStatus !== baseBranch || args.toStatus === baseBranch) {
    return { stamped: false };
  }
  const updated =
    (await tx
      .update(issues)
      .set({ mergedAt: sql`now()` })
      .where(and(eq(issues.id, args.issueId), isNull(issues.mergedAt)))
      .returning({ id: issues.id })) ?? [];
  return { stamped: updated.length > 0 };
}

/**
 * Stamp `merged_at = now()` when an issue transitions to `closed` and the
 * column is still NULL. `closed` is the ONLY terminal-done status (there is
 * no `cancelled`/`wontfix`), so a close — from any surface: UI, MCP, REST —
 * means "done" and must satisfy the L2 `blocks` gate for dependents.
 *
 * Rationale (getcontent 2026-07-13 incident): the ISS-639 gate fix stopped
 * treating `closed`+`merged_at IS NULL` blockers as satisfied under a
 * stampable base, which was correct for abandoned code but silently wedged
 * every hand-closed issue — the dependents' queued jobs just vanished from
 * the picker with no event. Requiring callers to disambiguate at close time
 * (a `resolution` param) would drift across surfaces, so the kernel infers
 * instead: close ⇒ done ⇒ stamp. The trade-off is deliberate:
 *   - pipeline closes already stamped on leaving the base merge state, so
 *     this is a no-op there (`WHERE merged_at IS NULL`);
 *   - ONE system path auto-closes, and it is gated on a release note existing
 *     (`release-record-required.ts`): the orchestrator's auto-skip
 *     chain, which anchors on `closed` when the `released` stage has no
 *     registered skill and is NOT exempt — it catches the refusal and stops.
 *     Everything else routes elsewhere (cancel → on_hold, failures →
 *     waiting/reopen);
 *   - a close-as-abandon wrongly unblocks dependents, but visibly (audit
 *     comment in `apply-transition.ts`) and reversibly (`unmark`) — better
 *     than the old failure mode of an invisible, indefinite wedge.
 *
 * Idempotent via `WHERE merged_at IS NULL`; call inside the same tx as the
 * status UPDATE so a rollback drops both writes together.
 */
// cm:flow release/close after:stamp — closing stamps merged_at when it is still null, which is why closing an issue that was never work unblocks its dependents as if it had shipped; unmark is the only reversal
export async function markMergedOnClose(
  tx: DrizzleTx,
  args: { issueId: string; toStatus: IssueStatus },
): Promise<{ stamped: boolean }> {
  if (args.toStatus !== 'closed') return { stamped: false };
  const updated =
    (await tx
      .update(issues)
      .set({ mergedAt: sql`now()` })
      .where(and(eq(issues.id, args.issueId), isNull(issues.mergedAt)))
      .returning({ id: issues.id })) ?? [];
  return { stamped: updated.length > 0 };
}

/** First runner release whose `worktree::create` reuses an existing checkout. */
export const WORKTREE_LANE_MIN_RUNNER = '0.9.3';

/** First runner release holding the repo-root lock (`daemon/repo_lock.rs`). */
// cm:guard per-FEATURE floor, never a blanket "is the runner current" check. Core deploys in one step and the fleet updates on its own clock, so a box that has not restarted yet is normal, not broken — and a box below this floor runs `workspace::refresh` on the shared root with no lock at all. Trusting it with a cap above 1 lets two jobs `merge --ff-only` one index and rewrite files an agent is mid-read on.
// cm:edge lockstep -> packages/runner/Cargo.toml — this string names a runner release; it may only rise to a version that has actually been cut and published, or every box reads as too old and the whole fleet silently falls back to cap 1
export const REPO_LOCK_MIN_RUNNER = '0.10.5';

/**
 * How many jobs this box may carry, given the runner build that will take them.
 *
 * `configured` is `devices.max_concurrent`.
 */
// cm:guard an unknown or unparseable version resolves to 1, and that direction is the whole safety of it. A wrong answer that says "too old" costs throughput an operator can see; one that says "new enough" corrupts a working tree nobody is watching.
export function effectiveDeviceCap(
  configured: number | null | undefined,
  runnerVersion: string | null | undefined,
): number {
  const wanted = Math.trunc(configured ?? 1);
  if (!Number.isFinite(wanted) || wanted < 1) return 1;
  if (wanted === 1) return 1;
  return atLeast(runnerVersion, REPO_LOCK_MIN_RUNNER) ? wanted : 1;
}

function atLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const a = version.split('.').map(Number);
  const b = min.split('.').map(Number);
  if (a.length !== 3 || a.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if ((a[i] as number) !== (b[i] as number)) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

/**
 * The `worktreeBranch` payload fragment for a job, or nothing.
 *
 * Nothing has three causes and they are different facts: the job serves no
 * issue, the stage is where the project merges, or the runner about to take it
 * predates the lane being usable.
 */
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/workspace/worktree.rs — `create` is what this field switches on, and BEFORE 0.9.3 it could only ever create: `git worktree add` refuses an existing path with or without `-b`, so the second stage of an issue died with `fatal: '.worktrees/ISS-n' already exists`. The version floor is not caution, it is the difference between reuse and a failed job, and it may only be lowered if that arm is proven present.
// cm:guard resolved per RUNNER, at dispatch, never at job creation — core deploys in one step and the fleet updates on its own clock, so the only place the answer is knowable is where the box that will run it is already chosen. A retry that rotates onto an older box re-resolves and correctly sends nothing.
// cm:guard a merge stage gets NOTHING, because git REFUSES to check out a branch already checked out in the main worktree and the merge step's whole job is `git checkout <base>`. No DISPATCHED job takes this arm today — since ISS-897 the only job type is `drive`, stamped `stageStatus:'open'`, and the merge state is `released` — so it is currently unreachable, tested directly in `tests/integration/worktree-branch-stamp-e2e.test.ts`, and kept because it is what would stop a merge stage being handed a worktree the day one is dispatched again.
export function worktreeBranchPayload(args: {
  status: IssueStatus | null | undefined;
  agentConfig: unknown;
  featureBranch: string | null | undefined;
  runnerVersion: string | null | undefined;
}): { worktreeBranch?: string } {
  if (!args.featureBranch || !args.status) return {};
  if (!atLeast(args.runnerVersion, WORKTREE_LANE_MIN_RUNNER)) return {};
  const merge = resolveMergeStates(args.agentConfig);
  if (args.status === merge.baseBranch || args.status === merge.productionBranch) return {};
  return { worktreeBranch: args.featureBranch };
}
