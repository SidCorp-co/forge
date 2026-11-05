// REQ-63 BC-9: what a promotion release waits on before its cut — a change request across the
// promotion, open or merged and not yet released — read off the projection, so a draft pairs with the
// request under review. No read here reaches the host.

import { and, desc, eq, not, or, sql } from 'drizzle-orm';
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
 * A merged request production already serves: a release of this project shipped to production at or
 * after its merge, whether or not that release's record pinned it (ISS-1001, adminhub-fe: !2070
 * merged 2026-10-31 and shipped in 0.55.0 that day, whose record named no request, and the draft 0.56.0
 * still showed it as its own). A landing recorded on another branch puts nothing in production.
 */
const shippedSince = (projectId: string, to: string) => sql`exists (
  select 1 from ${pipelineRuns}
   where ${pipelineRuns.projectId} = ${projectId}
     and ${pipelineRuns.releaseReleasedAt} >= ${repoPullRequests.mergedAt}
     and not (coalesce(${pipelineRuns.metadata} ->> 'verification', '') = 'landed'
              and coalesce(${pipelineRuns.metadata} ->> 'branch', '') <> ${to}))`;

/**
 * A request that carries the promotion's source into production: one from the source branch itself,
 * or from a branch cut to pin a head the source is recorded holding (adminhub-fe !2055,
 * `promote/prod-2026-10-29`) — the head of a request from the source, the merge of one into it, an
 * issue's landing on it, or a commit an issue landed on it was judged at. A request from any other
 * branch into production (adminhub-api !5066, `fix/shipresolve-webhook-auth`, open beside the
 * promotion) carries something else there, and is never the release's promotion (ISS-1001).
 */
const carriesSource = (projectId: string, from: string) => sql`(
  ${repoPullRequests.headRef} = ${from}
  or lower(${repoPullRequests.headSha}) in (
    select lower(s.head_sha) from repo_pull_requests s
     where s.project_id = ${projectId} and s.head_ref = ${from}
    union
    select lower(s.merge_commit_sha) from repo_pull_requests s
     where s.project_id = ${projectId} and s.base_ref = ${from} and s.merge_commit_sha is not null
    union
    select lower(i.merged_commit_sha) from issues i
     where i.project_id = ${projectId} and i.merged_target = ${from} and i.merged_commit_sha is not null
    union
    select lower(v.commit_sha) from criterion_verdicts v join issues i on i.id = v.issue_id
     where i.project_id = ${projectId} and i.merged_target = ${from} and v.commit_sha is not null))`;

/**
 * The requests into the branch production deploys from that a release may be: those carrying the
 * promotion's source there (`carriesSource`), open ones, and merged ones no release has taken and
 * production has not shipped since, as the projection holds them, open first then newest. Which
 * roster issues it carries is the agent's statement at the cut, never read here: nothing in this
 * module asks the host (VISION: state-never-lies, owner ruling 2026-10-29).
 */
export async function requestsAcross(projectId: string, across: Across) {
  return db
    .select()
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.projectId, projectId),
        eq(repoPullRequests.baseRef, across.to),
        carriesSource(projectId, across.from),
        or(
          eq(repoPullRequests.state, 'open'),
          and(
            eq(repoPullRequests.state, 'merged'),
            unreleased,
            not(shippedSince(projectId, across.to)),
          ),
        ),
      ),
    )
    .orderBy(sql`${repoPullRequests.state} = 'open' DESC`, desc(repoPullRequests.number))
    .limit(20);
}

/**
 * The branch request `number` goes into the promotion's target from, where it is one into that
 * target that does not carry the promotion's source (`carriesSource`); else null.
 */
export async function requestFromOtherBranch(
  projectId: string,
  across: Across,
  number: number,
): Promise<string | null> {
  const [row] = await db
    .select({ headRef: repoPullRequests.headRef })
    .from(repoPullRequests)
    .where(
      and(
        eq(repoPullRequests.projectId, projectId),
        eq(repoPullRequests.baseRef, across.to),
        eq(repoPullRequests.number, number),
        not(carriesSource(projectId, across.from)),
      ),
    )
    .limit(1);
  return row?.headRef ?? null;
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
