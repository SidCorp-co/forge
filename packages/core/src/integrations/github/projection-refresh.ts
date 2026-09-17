/**
 * The reads an event invalidated, and nothing else.
 *
 * Two of the things the projection holds cannot be taken from a payload. GitHub
 * computes mergeability lazily and sends `mergeable: null` with it, and no
 * payload carries how far a head is behind its base at all — a base push that
 * puts every open branch behind sends one `push` delivery and says nothing
 * about any pull request.
 *
 * So this reads. It is not a poll: nothing here runs on a timer, a tick or an
 * interval, and a read happens only because a delivery said the answer moved.
 * The rule ISS-1062 states is against a SECOND SOURCE OF TRUTH with a staleness
 * of its own, which is what a sweep would be; a read triggered by the event that
 * invalidated it has the event's own freshness.
 *
 * Everything written here is fenced on the head it answered for, and a failure
 * is recorded on the row rather than thrown.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import { logger } from '../../logger.js';
import { GitHubClientError, GitHubReadError, type GitHubRepoClient } from './client.js';

/**
 * How many open pull requests one base push refreshes.
 *
 * A base push invalidates the behind-by of every open branch on that base, and
 * a repository with hundreds would otherwise turn one delivery into hundreds of
 * API calls inside a webhook handler. The ones past the cap are not silently
 * skipped: they carry the cap as their `refresh_error`, so a reader meets the
 * truncation on the row rather than inferring it from a stale number.
 */
export const BASE_PUSH_REFRESH_CAP = 25;

export const CAP_REACHED_REASON = `not refreshed: this base push moved more than ${BASE_PUSH_REFRESH_CAP} open pull requests, and this one is past the cap — its behind-by is from before the push`;

interface PullRead {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  head?: { sha?: string };
}

interface CompareRead {
  ahead_by?: number;
  behind_by?: number;
  base_commit?: { sha?: string };
}

/** What the two reads answered, or why they could not. */
export type RefreshOutcome =
  | {
      ok: true;
      behindBy: number | null;
      aheadBy: number | null;
      mergeable: boolean | null;
      mergeableState: string | null;
      baseSha: string | null;
    }
  | { ok: false; reason: string };

/**
 * Ask GitHub the two questions a payload cannot answer, for one pull request at
 * one head.
 *
 * `mergeable_state` may come back `unknown`, and that is stored as it is rather
 * than retried for: asking again on a timer is the poll this design refuses, and
 * the next delivery about this pull request asks again anyway. `unknown` on the
 * row is the honest answer and reads as one.
 */
export async function readRefreshFacts(
  client: GitHubRepoClient,
  args: { number: number; baseRef: string; headSha: string },
): Promise<RefreshOutcome> {
  try {
    const pull = await client.get<PullRead>(`/repos/${client.fullName}/pulls/${args.number}`);
    // cm:why the compare is against the base REF and not the stored base sha: what "behind" means is how far this head trails the base branch as it is now, and the stored sha is the base as it was when a payload last mentioned it — which a base push does not update.
    const cmp = await client.get<CompareRead>(
      `/repos/${client.fullName}/compare/${encodeURIComponent(args.baseRef)}...${encodeURIComponent(args.headSha)}`,
    );
    return {
      ok: true,
      behindBy: typeof cmp.behind_by === 'number' ? cmp.behind_by : null,
      aheadBy: typeof cmp.ahead_by === 'number' ? cmp.ahead_by : null,
      mergeable: pull.mergeable ?? null,
      mergeableState: pull.mergeable_state ?? null,
      baseSha: cmp.base_commit?.sha ?? null,
    };
  } catch (err) {
    if (err instanceof GitHubReadError || err instanceof GitHubClientError) {
      return { ok: false, reason: err.message };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write a refresh onto the row it answered for, or do nothing.
 *
 * The `head_sha` in the WHERE is the whole of the fence and it covers the error
 * arm as well as the value arm: a slow read for a head the row has since left
 * knows nothing about the head it now carries, so neither its counts nor its
 * complaint belongs there. Nothing is a correct amount to write.
 */
export async function storeRefresh(
  rowId: string,
  headSha: string,
  outcome: RefreshOutcome,
): Promise<boolean> {
  const set = outcome.ok
    ? {
        behindBy: outcome.behindBy,
        aheadBy: outcome.aheadBy,
        mergeable: outcome.mergeable,
        mergeableState: outcome.mergeableState,
        ...(outcome.baseSha ? { baseSha: outcome.baseSha } : {}),
        refreshedForHead: headSha,
        refreshedAt: new Date(),
        refreshError: null,
        updatedAt: new Date(),
      }
    : {
        refreshedForHead: headSha,
        refreshedAt: new Date(),
        refreshError: outcome.reason,
        updatedAt: new Date(),
      };
  const rows = await db
    .update(repoPullRequests)
    .set(set)
    .where(and(eq(repoPullRequests.id, rowId), eq(repoPullRequests.headSha, headSha)))
    .returning({ id: repoPullRequests.id });
  return rows.length > 0;
}

/**
 * Refresh one stored pull request: capture its head, read, write under it.
 *
 * Never throws. The payload-derived write has already committed by the time this
 * runs, so an exception here would answer the delivery 500 and have GitHub
 * re-deliver a payload in order to retry a read — re-applying a fact to fix a
 * question about a different one.
 */
export async function refreshStoredPullRequest(
  client: GitHubRepoClient,
  rowId: string,
): Promise<boolean> {
  const [row] = await db
    .select({
      number: repoPullRequests.number,
      baseRef: repoPullRequests.baseRef,
      headSha: repoPullRequests.headSha,
    })
    .from(repoPullRequests)
    .where(eq(repoPullRequests.id, rowId))
    .limit(1);
  if (!row) return false;
  const outcome = await readRefreshFacts(client, {
    number: row.number,
    baseRef: row.baseRef,
    headSha: row.headSha,
  });
  if (!outcome.ok) {
    logger.info({ rowId, reason: outcome.reason }, 'repo projection: refresh could not answer');
  }
  return storeRefresh(rowId, row.headSha, outcome);
}

/** Mark the rows a base push could not reach, so the truncation is on the row. */
export async function markRefreshCapped(rowIds: string[]): Promise<number> {
  if (rowIds.length === 0) return 0;
  const rows = await db
    .update(repoPullRequests)
    .set({ refreshError: CAP_REACHED_REASON, refreshedAt: new Date(), updatedAt: new Date() })
    .where(sql`${repoPullRequests.id} = ANY(${rowIds})`)
    .returning({ id: repoPullRequests.id });
  return rows.length;
}
