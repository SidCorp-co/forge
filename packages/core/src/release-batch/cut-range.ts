/**
 * What a release batch carries to production, read from the project's repository (ISS-1386). On
 * a chain that promotes by `merge-branch`, the release merges the start branch into the live one,
 * so everything in `live...start` reaches production whether or not the batch names it. Read by
 * the caller and passed to the enumerator, which reaches no network of its own.
 */

import {
  GitHubClientError,
  type GitHubRepoClient,
  githubRepoClient,
} from '../integrations/github/client.js';
import {
  chainCrossesByCherryPick,
  chainLiveBranch,
  chainStartBranch,
  type ReleaseChain,
} from '../projects/release-chain.js';
import { readProjectBranches } from '../projects/service.js';

/** GitHub pages a compare's commits; past this many pages the range is too long to read whole. */
const PAGE_SIZE = 100;
const PAGE_LIMIT = 10;

export interface RangeCommit {
  sha: string;
  /** First parent first, as git records them. */
  parents: string[];
  message: string;
}

/** One read of `live...head`: every commit the head holds that the live branch does not. */
export interface ReadRange {
  live: string;
  start: string;
  /** The commit a release of this range promotes: the start branch's head, or a cut below it. */
  cut: string;
  commits: RangeCommit[];
}

export type CutRange =
  | ({ kind: 'read' } & ReadRange)
  /** The chain gives no branch range to read: a publish chain, or a cherry-pick crossing. */
  | { kind: 'not-read'; why: string }
  /** No route to read it was declared: the project binds no GitHub repository. */
  | { kind: 'unbound'; why: string }
  /** A declared route failed to answer. */
  | { kind: 'unread'; why: string };

export interface CutRangeDeps {
  client?: (projectId: string) => Promise<GitHubRepoClient>;
}

interface CompareCommit {
  sha?: string;
  parents?: Array<{ sha?: string }>;
  commit?: { message?: string };
}

interface ComparePage {
  total_commits?: number;
  commits?: CompareCommit[];
}

function commitOf(c: CompareCommit): RangeCommit | null {
  if (typeof c.sha !== 'string' || c.sha === '') return null;
  return {
    sha: c.sha.toLowerCase(),
    parents: (c.parents ?? []).flatMap((p) =>
      typeof p.sha === 'string' ? [p.sha.toLowerCase()] : [],
    ),
    message: c.commit?.message ?? '',
  };
}

async function readPages(
  client: GitHubRepoClient,
  base: string,
  head: string,
): Promise<{ commits: RangeCommit[] } | string> {
  const commits: RangeCommit[] = [];
  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const read = await client.get<ComparePage>(
      `/repos/${client.fullName}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (typeof read.total_commits !== 'number' || !Array.isArray(read.commits)) {
      return `${client.fullName} answered the compare of ${base}...${head} with no commit list`;
    }
    for (const c of read.commits) {
      const commit = commitOf(c);
      if (!commit) return `${client.fullName} answered a commit with no sha in ${base}...${head}`;
      commits.push(commit);
    }
    if (commits.length >= read.total_commits) return { commits };
    if (read.commits.length === 0) {
      return `${client.fullName} stopped answering ${base}...${head} at ${commits.length} of the ${read.total_commits} commits it reported`;
    }
  }
  return `${base}...${head} holds more than ${PAGE_SIZE * PAGE_LIMIT} commits, more than one release range is read for`;
}

async function headOf(client: GitHubRepoClient, branch: string): Promise<string | null> {
  const read = await client.get<{ sha?: string }>(
    `/repos/${client.fullName}/commits/${encodeURIComponent(branch)}`,
  );
  return typeof read.sha === 'string' && read.sha !== '' ? read.sha.toLowerCase() : null;
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The range a promotion of `head` onto the live branch carries; `head` defaults to the start branch. */
export async function readRangeTo(
  projectId: string,
  chain: ReleaseChain,
  head: string | null,
  deps: CutRangeDeps = {},
): Promise<CutRange> {
  const live = chainLiveBranch(chain);
  const start = chainStartBranch(chain);
  if (!live || !start) {
    return {
      kind: 'not-read',
      why: 'this project deploys the branch work merges to, so no branch range separates what a release carries',
    };
  }
  if (chainCrossesByCherryPick(chain)) {
    return {
      kind: 'not-read',
      why: 'this project crosses into production by cherry-pick, so a release carries only what it picks',
    };
  }
  let client: GitHubRepoClient;
  try {
    client = await (deps.client ?? githubRepoClient)(projectId);
  } catch (err) {
    if (err instanceof GitHubClientError && err.reason === 'no_binding') {
      return { kind: 'unbound', why: err.message };
    }
    return { kind: 'unread', why: why(err) };
  }
  try {
    // Pinned to a sha first, so the range read and the cut the release is told to promote are one.
    const cut = head ?? (await headOf(client, start));
    if (!cut)
      return { kind: 'unread', why: `${client.fullName} answered no head commit for ${start}` };
    const read = await readPages(client, live, cut);
    if (typeof read === 'string') return { kind: 'unread', why: read };
    return { kind: 'read', live, start, cut, commits: read.commits };
  } catch (err) {
    return {
      kind: 'unread',
      why: `${client.fullName} could not compare ${live} with ${head ?? start}: ${why(err)}`,
    };
  }
}

/** The project's own chain, and the range a release of its start branch carries. */
export async function readCutRange(projectId: string, deps: CutRangeDeps = {}): Promise<CutRange> {
  const project = await readProjectBranches(projectId);
  return readRangeTo(projectId, project?.releaseChain ?? [], null, deps);
}
