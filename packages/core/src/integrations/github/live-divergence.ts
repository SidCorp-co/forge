import type { ReadFailure } from '../../projects/repository-reader.js';
import { GitHubReadError, type GitHubRepoClient } from './client.js';
import { headFailure } from './repository-reader.js';

/** Commits per compare page, GitHub's own ceiling. */
export const COMPARE_PAGE_SIZE = 100;
/** Pages read per reading. A longer wait than this is reported as cut short, never as complete. */
export const COMPARE_MAX_PAGES = 3;

export interface WaitingCommit {
  sha: string;
  /** The whole message. Only its subject line is read for keys, by `commitOwners`. */
  message: string;
  /** First parent first, as git records them: the merge walk in `commitOwners` reads the order. */
  parents: string[];
}

export type LiveDivergence =
  | {
      ok: true;
      baseSha: string;
      liveSha: string;
      /** GitHub's count of commits on base that live lacks. */
      aheadBy: number;
      commits: WaitingCommit[];
      /** False where `commits` holds fewer than `aheadBy`: an issue it does not name is unplaced. */
      complete: boolean;
    }
  | {
      ok: false;
      reason: string;
      /** A branch head GitHub would not give, told apart as the repository reader tells it: a
       *  branch the repository lacks, or the repository refusing the read (ISS-1300 r5). */
      failure?: ReadFailure & { repository: string };
    };

interface BranchRead {
  commit?: { sha?: string };
}

interface CompareRead {
  ahead_by?: number;
  total_commits?: number;
  commits?: Array<{
    sha?: string;
    parents?: Array<{ sha?: string }>;
    commit?: { message?: string };
  }>;
}

async function headOf(client: GitHubRepoClient, branch: string): Promise<string | ReadFailure> {
  let read: BranchRead;
  try {
    read = await client.get<BranchRead>(
      `/repos/${client.fullName}/branches/${encodeURIComponent(branch)}`,
    );
  } catch (err) {
    return headUnreadFor(client, branch, err);
  }
  return read.commit?.sha || { why: `${client.fullName} answered no commit for ${branch}` };
}

/** GitHub answers a branch read 404 both where a repository it shows lacks the branch and where it
 *  hides the repository; the commit lookup tells the two apart, 422 against 404 (ISS-1300 r5). */
async function headUnreadFor(
  client: GitHubRepoClient,
  branch: string,
  err: unknown,
): Promise<ReadFailure> {
  const said = headFailure(err, client.fullName, branch);
  if (!(err instanceof GitHubReadError) || err.phase !== 'request' || err.status !== 404) {
    return said;
  }
  try {
    await client.get(`/repos/${client.fullName}/commits/${encodeURIComponent(branch)}`);
    return { why: said.why };
  } catch (again) {
    const { missingBranch, refused } = headFailure(again, client.fullName, branch);
    return {
      why: said.why,
      ...(missingBranch ? { missingBranch } : {}),
      ...(refused ? { refused } : {}),
    };
  }
}

/** The reason keeps the reader's own line, the request included, for whoever opens the details. */
function headUnread(client: GitHubRepoClient, failed: ReadFailure): LiveDivergence {
  return { ok: false, reason: failed.why, failure: { ...failed, repository: client.fullName } };
}

/**
 * The commits on `baseRef` that `liveRef` does not contain.
 *
 * Both heads are read first and the compare runs between the two shas, so every page describes
 * the same pair even when a branch moves while the pages are being read.
 */
export async function readLiveDivergence(
  client: GitHubRepoClient,
  refs: { baseRef: string; liveRef: string },
): Promise<LiveDivergence> {
  const [baseSha, liveSha] = await Promise.all([
    headOf(client, refs.baseRef),
    headOf(client, refs.liveRef),
  ]);
  if (typeof baseSha !== 'string') return headUnread(client, baseSha);
  if (typeof liveSha !== 'string') return headUnread(client, liveSha);
  try {
    const commits: WaitingCommit[] = [];
    let aheadBy = 0;
    for (let page = 1; page <= COMPARE_MAX_PAGES; page += 1) {
      const cmp = await client.get<CompareRead>(
        `/repos/${client.fullName}/compare/${encodeURIComponent(liveSha)}...${encodeURIComponent(baseSha)}?per_page=${COMPARE_PAGE_SIZE}&page=${page}`,
      );
      aheadBy = typeof cmp.ahead_by === 'number' ? cmp.ahead_by : (cmp.total_commits ?? 0);
      const got = cmp.commits ?? [];
      for (const c of got) {
        if (!c.sha) continue;
        const parents = (c.parents ?? []).flatMap((p) => (p.sha ? [p.sha] : []));
        commits.push({ sha: c.sha, message: c.commit?.message ?? '', parents });
      }
      if (got.length < COMPARE_PAGE_SIZE || commits.length >= aheadBy) break;
    }
    return { ok: true, baseSha, liveSha, aheadBy, commits, complete: commits.length >= aheadBy };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason, failure: { why: reason, repository: client.fullName } };
  }
}
