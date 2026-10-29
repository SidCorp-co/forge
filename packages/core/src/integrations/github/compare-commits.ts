import type { WaitingCommit } from '../source-host/index.js';
import type { GitHubRepoClient } from './client.js';

/** Commits per compare page, GitHub's own ceiling. */
const COMPARE_PAGE_SIZE = 100;
/** Pages read per range. A longer range than this is reported as cut short, never as complete. */
const COMPARE_MAX_PAGES = 3;

interface CompareRead {
  ahead_by?: number;
  total_commits?: number;
  commits?: Array<{
    sha?: string;
    parents?: Array<{ sha?: string }>;
    commit?: { message?: string };
  }>;
}

/** Every commit `head` holds that `base` does not, as many pages as one range read may take. */
export async function readCompareCommits(
  client: GitHubRepoClient,
  base: string,
  head: string,
): Promise<{ commits: WaitingCommit[]; aheadBy: number }> {
  const commits: WaitingCommit[] = [];
  let aheadBy = 0;
  for (let page = 1; page <= COMPARE_MAX_PAGES; page += 1) {
    const cmp = await client.get<CompareRead>(
      `/repos/${client.fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${COMPARE_PAGE_SIZE}&page=${page}`,
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
  return { commits, aheadBy };
}
