/**
 * ISS-571 / ISS-868 — `forge_issues` `data.relations`: the dependency edges a
 * caller declares relative to the issue being created or updated. Separate
 * from `forge-pm-set-dependency.ts` so both write surfaces share one mapping
 * from the caller's issue-relative shape to the graph's `from`/`to` shape.
 */

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
  for (const rel of relations ?? []) {
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
    );
    applied.push({
      edgeId: result.id,
      kind: rel.kind,
      fromIssueId,
      toIssueId,
      created: result.created,
      updated: result.updated ?? false,
    });
  }
  return applied;
}
