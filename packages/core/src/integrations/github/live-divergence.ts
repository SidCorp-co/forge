import { GitHubClientError, GitHubReadError, type GitHubRepoClient } from './client.js';

/** Commits per compare page, GitHub's own ceiling. */
export const COMPARE_PAGE_SIZE = 100;
/** Pages read per reading. A longer wait than this is reported as cut short, never as complete. */
export const COMPARE_MAX_PAGES = 3;

export interface WaitingCommit {
  sha: string;
  /** The whole message: a key named in a merge commit's body counts as much as one in its subject. */
  message: string;
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
  | { ok: false; reason: string };

interface BranchRead {
  commit?: { sha?: string };
}

interface CompareRead {
  ahead_by?: number;
  total_commits?: number;
  commits?: Array<{ sha?: string; commit?: { message?: string } }>;
}

async function headOf(client: GitHubRepoClient, branch: string): Promise<string> {
  const read = await client.get<BranchRead>(
    `/repos/${client.fullName}/branches/${encodeURIComponent(branch)}`,
  );
  const sha = read.commit?.sha;
  if (!sha) throw new GitHubReadError(200, `${client.fullName} answered no commit for ${branch}`);
  return sha;
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
  try {
    const [baseSha, liveSha] = await Promise.all([
      headOf(client, refs.baseRef),
      headOf(client, refs.liveRef),
    ]);
    const commits: WaitingCommit[] = [];
    let aheadBy = 0;
    for (let page = 1; page <= COMPARE_MAX_PAGES; page += 1) {
      const cmp = await client.get<CompareRead>(
        `/repos/${client.fullName}/compare/${encodeURIComponent(liveSha)}...${encodeURIComponent(baseSha)}?per_page=${COMPARE_PAGE_SIZE}&page=${page}`,
      );
      aheadBy = typeof cmp.ahead_by === 'number' ? cmp.ahead_by : (cmp.total_commits ?? 0);
      const got = cmp.commits ?? [];
      for (const c of got) {
        if (c.sha) commits.push({ sha: c.sha, message: c.commit?.message ?? '' });
      }
      if (got.length < COMPARE_PAGE_SIZE || commits.length >= aheadBy) break;
    }
    return { ok: true, baseSha, liveSha, aheadBy, commits, complete: commits.length >= aheadBy };
  } catch (err) {
    if (err instanceof GitHubReadError || err instanceof GitHubClientError) {
      return { ok: false, reason: err.message };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
