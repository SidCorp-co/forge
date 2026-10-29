// REQ-63 BC-9: what a promotion release waits on before its cut, read from the projection alone —
// a change request across the promotion, open, or merged since the newest roster issue landed.
// Whether its head carries every issue is the cut's question (`promotion-release.ts`).

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { blocker } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';
import { shown } from './change-request-roster.js';
import type { ReleaseDeclaration } from './gate.js';

export type PromotionDeclaration = Extract<ReleaseDeclaration, { kind: 'promotion' }>;
export type Across = PromotionDeclaration['promotion'];

/**
 * The newest open request into the branch production deploys from, else the newest merged one, as the
 * projection holds them. Its head may be the promotion's source branch or one cut from it to pin a
 * judged head (adminhub-fe !2055, `promote/prod-2026-10-29`): whether that head carries the roster is
 * read on the host at the cut, never assumed from the branch's name.
 */
export async function requestsAcross(projectId: string, across: Across) {
  return db
    .select()
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.projectId, projectId),
        eq(repoPullRequests.baseRef, across.to),
        inArray(repoPullRequests.state, ['open', 'merged']),
      ),
    )
    .orderBy(sql`${repoPullRequests.state} = 'open' DESC`, desc(repoPullRequests.number))
    .limit(1);
}

/** The readiness reason of a promotion release: no request across the promotion is open, and none merged since the newest roster issue landed. */
export async function promotionBlockers(
  projectId: string,
  decl: PromotionDeclaration,
  roster: readonly string[],
  out: ReleaseBlocker[],
): Promise<void> {
  if (roster.length === 0) return;
  const [request] = await requestsAcross(projectId, decl.promotion);
  if (request?.state === 'open') return;
  const [newest] = await db
    .select({ at: sql<Date | null>`max(${issues.mergedAt})` })
    .from(issues)
    .where(inArray(issues.id, [...roster]));
  const landed = newest?.at ? new Date(newest.at) : null;
  if (request?.mergedAt && landed && request.mergedAt >= landed) return;
  out.push(
    blocker('RELEASE_PROMOTION_MISSING', {
      issueIds: [...roster],
      displayIds: await shown([...roster]),
      ...decl.promotion,
    }),
  );
}

/**
 * The promotion request numbered `number` that the running release holding this issue pinned, so a
 * merge named through any roster issue reaches it though its branch delivers no issue (REQ-63 BC-11).
 */
export async function promotionPinnedFor(issueId: string, number: number): Promise<string | null> {
  const [row] = await db
    .select({ id: repoPullRequests.id })
    .from(issues)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
    .innerJoin(
      repoPullRequests,
      sql`${repoPullRequests.id}::text = ${pipelineRuns.metadata} -> 'promotion' ->> 'pullRequestId'`,
    )
    .where(
      and(
        eq(issues.id, issueId),
        eq(pipelineRuns.status, 'running'),
        eq(repoPullRequests.number, number),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
