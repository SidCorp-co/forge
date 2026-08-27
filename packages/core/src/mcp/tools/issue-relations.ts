/**
 * ISS-571 / ISS-868 — `forge_issues` `data.relations`: the dependency edges a
 * caller declares relative to the issue being created or updated. Separate
 * from `forge-pm-set-dependency.ts` so both write surfaces share one mapping
 * from the caller's issue-relative shape to the graph's `from`/`to` shape.
 */

import { publishPipelineHealthChanged } from '../../issues/pipeline-health.js';
import { pmSetDependencyHandler } from './forge-pm-set-dependency.js';
import { type McpContext, principalHookActor } from './lib.js';

/**
 * One entry of `forge_issues` `data.relations`, expressed relative to the
 * issue being created or updated.
 */
export type IssueRelationInput = {
  kind: 'blocks' | 'relates';
  dependsOnId?: string | undefined;
  blocksId?: string | undefined;
  reason?: string | undefined;
  validUntil?: string | undefined;
};

export type AppliedIssueRelation = {
  edgeId: string;
  kind: 'blocks' | 'relates';
  fromIssueId: string;
  toIssueId: string;
  created: boolean;
  updated: boolean;
};

// cm:guard `dependsOnId` puts the OTHER issue on the `from` side and this one on `to` — the repo's convention is `from` BLOCKS `to`, so swapping the two silently inverts every edge an agent declares and the dispatcher gates the wrong side
// cm:edge contract -> packages/core/src/issues/dependency-routes.ts — same direction as POST /api/issues/:id/dependencies, whose `dependsOnId` also lands as (from=dependsOnId, to=:id)
export async function applyIssueRelations(
  ctx: McpContext,
  projectId: string,
  issueId: string,
  relations: readonly IssueRelationInput[] | undefined,
): Promise<AppliedIssueRelation[]> {
  const { device } = ctx;
  const actor = principalHookActor(ctx.principal, device);
  const applied: AppliedIssueRelation[] = [];
  const refreshHealthFor: string[] = [];
  // cm:guard keep this loop SEQUENTIAL — `pmSetDependencyHandler` runs `detectCycle` against edges already COMMITTED, so A→B and B→A sent in one `relations` array are each individually acyclic and only the serial order rejects the pair; `onConflictDoNothing` does not catch a cycle. A `Promise.all` here reads like an obvious win and admits the cycle the gate exists to refuse.
  for (const rel of relations ?? []) {
    // cm:guard enforce EXACTLY one side here, not just "at least one" — the zod `.refine` in forge-issues.ts is the only other check, so a second caller of this helper (or a widened schema) would otherwise get the `dependsOnId` branch silently and lose the `blocksId` edge it also asked for
    if ((rel.dependsOnId == null) === (rel.blocksId == null)) {
      throw new Error('BAD_REQUEST: relation needs exactly one of dependsOnId or blocksId');
    }
    const fromIssueId = rel.dependsOnId ?? issueId;
    const toIssueId = rel.dependsOnId != null ? issueId : rel.blocksId;
    if (!toIssueId) throw new Error('BAD_REQUEST: relation needs dependsOnId or blocksId');
    const result = await pmSetDependencyHandler(
      device,
      {
        projectId,
        fromIssueId,
        toIssueId,
        kind: rel.kind,
        reason: rel.reason,
        validUntil: rel.validUntil,
      },
      actor,
      { deferHealthPublish: true },
    );
    if (rel.kind === 'blocks' && (result.created || result.updated)) {
      refreshHealthFor.push(toIssueId);
    }
    applied.push({
      edgeId: result.id,
      kind: rel.kind,
      fromIssueId,
      toIssueId,
      created: result.created,
      updated: result.updated ?? false,
    });
  }
  // cm:guard ONE publish for the whole array, not one per edge — `publishPipelineHealthChanged` fans out to `hydratePipelineHealthForIssues`, which is ~9 sequential round trips, and it already batches by `inArray(ids)`; per-edge publishing cost 9N reads for the schema's 20-edge maximum. It must still run HERE, before the caller's `issueCreated` emit / status transition wakes the dispatcher.
  if (refreshHealthFor.length > 0) {
    await publishPipelineHealthChanged(projectId, refreshHealthFor);
  }
  return applied;
}
