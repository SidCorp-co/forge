// REQ-63 BC-9: what a promotion release waits on before its cut — a change request across the
// promotion, open, or merged since the newest roster issue landed — and which roster issues an open
// one's head carries, read on the host, so a draft pairs with the request under review.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns } from '../db/schema.js';
import { repoPullRequests } from '../db/schema-repo-projection.js';
import { resolveSourceHost } from '../integrations/source-host/index.js';
import { blocker } from './blocker-kit.js';
import type { ReleaseBlocker } from './blocker-sentences.js';
import { label, shown } from './change-request-roster.js';
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

/** Whether one commit holds another, as the host answered: ancestry of two fixed commits never changes. */
const held = new Map<string, boolean>();
const HELD_KEPT = 5000;

async function holds(projectId: string, sha: string, head: string): Promise<boolean> {
  const key = `${projectId}:${sha}>${head}`;
  const known = held.get(key);
  if (known !== undefined) return known;
  const where = await resolveSourceHost(projectId, 'agent').then((h) => h.compare(sha, head));
  const answer = where === 'ahead' || where === 'identical';
  if (held.size >= HELD_KEPT) held.clear();
  held.set(key, answer);
  return answer;
}

/** Of the roster, the issues whose host merge `head` holds, in the roster's order. */
export async function carriedBy(projectId: string, head: string, roster: readonly string[]) {
  const rows = await db
    .select({ id: issues.id, sha: issues.mergedCommitSha })
    .from(issues)
    .where(inArray(issues.id, [...roster]));
  const shaOf = new Map(rows.map((r) => [r.id, r.sha]));
  const carries: string[] = [];
  const notCarried: string[] = [];
  for (const id of roster) {
    const sha = shaOf.get(id);
    (sha && (await holds(projectId, sha, head)) ? carries : notCarried).push(id);
  }
  return { carries, notCarried };
}

/** The open promotion request and which of the roster its head carries; null where none is open. */
export async function openPromotionFor(
  projectId: string,
  across: Across,
  roster: readonly string[],
) {
  const [request] = await requestsAcross(projectId, across);
  if (request?.state !== 'open') return null;
  return { request, ...(await carriedBy(projectId, request.headSha, roster)) };
}

/**
 * The readiness reason of a promotion release: no request across the promotion is open, and none
 * merged since the newest roster issue landed; or the open one's head carries only part of the
 * roster, and the release is cut with that part (adminhub-fe 0.54.0: work landed past !2055's head).
 */
export async function promotionBlockers(
  projectId: string,
  decl: PromotionDeclaration,
  roster: readonly string[],
  out: ReleaseBlocker[],
): Promise<void> {
  if (roster.length === 0) return;
  const open = await openPromotionFor(projectId, decl.promotion, roster);
  if (open && open.notCarried.length === 0) return;
  if (open && open.carries.length > 0) {
    out.push(
      blocker('RELEASE_PROMOTION_PARTIAL', {
        issueIds: open.notCarried,
        displayIds: await shown(open.notCarried),
        carried: open.carries,
        roster: roster.length,
        request: label(open.request),
        head: open.request.headSha,
        ...decl.promotion,
      }),
    );
    return;
  }
  if (!open) {
    // none open: a request merged since the newest roster issue landed already carried it across
    const [merged] = await requestsAcross(projectId, decl.promotion);
    const [newest] = await db
      .select({ at: sql<Date | null>`max(${issues.mergedAt})` })
      .from(issues)
      .where(inArray(issues.id, [...roster]));
    const landed = newest?.at ? new Date(newest.at) : null;
    if (merged?.mergedAt && landed && merged.mergedAt >= landed) return;
  }
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
