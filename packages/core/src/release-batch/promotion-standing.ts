// REQ-63 BC-9: what a promotion release waits on before its cut — a change request across the
// promotion, open or merged and not yet released — read off the projection, so a draft pairs with the
// request under review. No read here reaches the host.

import { and, desc, eq, or, sql } from 'drizzle-orm';
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
 * A promotion request merged into `to` that no release run has taken: one a finished release pinned
 * is spent, so nothing asks to promote it again (ISS-762, catalog-api 0.3.0: !1023 was already on
 * release/production and the release still asked to promote its commit).
 */
const unreleased = sql`not exists (
  select 1 from ${pipelineRuns}
   where ${pipelineRuns.metadata} -> 'promotion' ->> 'pullRequestId' = ${repoPullRequests.id}::text
     and ${pipelineRuns.status} in ('completed', 'failed'))`;

/**
 * The requests into the branch production deploys from that a release may be: open ones, and merged
 * ones no release has taken, as the projection holds them, open first then newest. A request's head may
 * be the promotion's source branch or one cut from it to pin a judged head (adminhub-fe !2055,
 * `promote/prod-2026-10-29`). Which roster issues it carries is the agent's statement at the cut, never
 * read here: nothing in this module asks the host (VISION: state-never-lies, owner ruling 2026-10-29).
 */
export async function requestsAcross(projectId: string, across: Across) {
  return db
    .select()
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.projectId, projectId),
        eq(repoPullRequests.baseRef, across.to),
        or(
          eq(repoPullRequests.state, 'open'),
          and(eq(repoPullRequests.state, 'merged'), unreleased),
        ),
      ),
    )
    .orderBy(sql`${repoPullRequests.state} = 'open' DESC`, desc(repoPullRequests.number))
    .limit(20);
}

/**
 * The readiness reason of a promotion release: no request across the promotion is open, or merged and
 * not yet released. A projection read; the roster the request carries is the agent's to state.
 */
export async function promotionBlockers(
  projectId: string,
  decl: PromotionDeclaration,
  roster: readonly string[],
  out: ReleaseBlocker[],
): Promise<void> {
  if (roster.length === 0) return;
  const [request] = await requestsAcross(projectId, decl.promotion);
  if (request) return;
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
