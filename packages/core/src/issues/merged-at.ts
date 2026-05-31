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
 * injects a merge-required block when stage matches mergeStates (see
 * `prompt/merge-required.ts`).
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
   *  trunk-based v2 this equals `baseBranch`. The `decomposeChildrenPending`
   *  L2 gate shares this `merged_at` column with `blockedBy` (a decompose
   *  parent waits for its children's `merged_at`). Future v3 will split into
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
export function resolveMergeStates(
  pipelineConfigOrAgentConfig: unknown,
): MergeStatesConfig {
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
