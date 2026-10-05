import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { repoPullRequests } from '../../db/schema-repo-projection.js';
import { logger } from '../../lib/logger.js';
import { type RefreshOutcome, storeRefresh } from '../source-host/index.js';
import { GitHubClientError, GitHubReadError, type GitHubRepoClient } from './client.js';

interface PullRead {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  head?: { sha?: string };
  base?: { ref?: string; sha?: string };
}

interface CompareRead {
  ahead_by?: number;
  behind_by?: number;
  base_commit?: { sha?: string };
}

/** The row this refresh is an answer about — both halves, because either can move. */
interface RefreshTarget {
  number: number;
  baseRef: string;
  headSha: string;
}

/**
 * Ask GitHub the two questions a payload cannot answer, for one pull request at
 * one head.
 *
 * `mergeable_state` may come back `unknown`, and that is stored as it is rather
 * than retried for: asking again on a timer is the poll this design refuses, and
 * the next delivery about this pull request asks again anyway. `unknown` on the
 * row is the honest answer and reads as one.
 */
async function readRefreshFacts(
  client: GitHubRepoClient,
  args: RefreshTarget,
): Promise<RefreshOutcome> {
  try {
    const pull = await client.get<PullRead>(`/repos/${client.fullName}/pulls/${args.number}`);
    const mismatch = targetMismatch(args, pull);
    if (mismatch) return { ok: false, reason: mismatch };
    const cmp = await client.get<CompareRead>(
      `/repos/${client.fullName}/compare/${encodeURIComponent(args.baseRef)}...${encodeURIComponent(args.headSha)}`,
    );
    const moved = baseMoved(pull, cmp);
    if (moved) return { ok: false, reason: moved };
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

/** Whether the base moved between the two reads, and what to say if it did. */
function baseMoved(pull: PullRead, cmp: CompareRead): string | null {
  const before = pull.base?.sha;
  const after = cmp.base_commit?.sha;
  if (before && after && before !== after) {
    return `not refreshed: ${pull.base?.ref ?? 'the base'} moved from ${before} to ${after} between the two reads, so mergeability and behind-by would not describe one moment — the delivery for that push asks again`;
  }
  return null;
}

/** Whether GitHub's answer is about the target asked about, and why not if it is not. */
function targetMismatch(args: RefreshTarget, pull: PullRead): string | null {
  const head = pull.head?.sha;
  if (head && head !== args.headSha) {
    return `not refreshed: GitHub answered for head ${head} while this read was for ${args.headSha} — the delivery for that head asks again`;
  }
  const base = pull.base?.ref;
  if (base && base !== args.baseRef) {
    return `not refreshed: GitHub answered for base ${base} while this read was for ${args.baseRef} — the delivery for that base asks again`;
  }
  return null;
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
  const startedAt = new Date();
  const outcome = await readRefreshFacts(client, row);
  if (!outcome.ok) {
    logger.info({ rowId, reason: outcome.reason }, 'repo projection: refresh could not answer');
  }
  return storeRefresh(rowId, { ...row, startedAt }, outcome);
}
