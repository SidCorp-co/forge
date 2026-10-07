/**
 * The repository reads Forge takes through a project's GitHub binding (ISS-1398 moved them here
 * from their callers, request for request): a commit by its sha, a branch's head, whether a branch
 * contains a commit, what a served commit carries of a judged one, what a landing changed, and the
 * commits between a branch and a commit. GitHub answers a pair with no common ancestor with a 404,
 * which arrives as a failed request and is unread like any other.
 */

import {
  type Carriage,
  type ChangedPaths,
  type CommitLookup,
  type Containment,
  RANGE_COMMIT_LIMIT,
  type RangeCommit,
  type RangeRead,
  type RepositoryReader,
} from '../../projects/repository-reader.js';
import { GitHubReadError, type GitHubRepoClient } from './client.js';

/** GitHub names at most this many files in one compare, and says nothing of the rest. */
export const COMPARE_FILE_CEILING = 300;

/** GitHub pages a compare's commits; past this many pages the range is too long to read whole. */
const PAGE_SIZE = 100;
const PAGE_LIMIT = RANGE_COMMIT_LIMIT / PAGE_SIZE;

/** Long enough to be a whole sha (SHA-1, or SHA-256 at 64), which GitHub cannot read as a prefix. */
const FULL_SHA_LENGTH = 40;

const TOO_MANY = `${COMPARE_FILE_CEILING} or more files differ, and the repository names no more than that in one compare`;

const DESCENDS = new Set(['ahead', 'identical']);

interface CommitRead {
  sha?: string;
  parents?: Array<{ sha?: string }>;
  commit?: { message?: string; committer?: { date?: string } };
}

interface CompareFile {
  filename?: string;
  previous_filename?: string;
}

interface CompareRead {
  status?: string;
  files?: CompareFile[];
}

interface ComparePage {
  total_commits?: number;
  commits?: CommitRead[];
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Each file a compare names, a rename by both its names: the old path no longer holds it either.
 *  A reason where the list cannot be taken whole, since a missing list is not an empty one. */
function filesOf(read: CompareRead): string[] | string {
  if (!Array.isArray(read.files)) return 'the compare answered no file list';
  if (read.files.length >= COMPARE_FILE_CEILING) return TOO_MANY;
  const named = (p: unknown) => typeof p === 'string' && p !== '';
  const unnamed = read.files.some(
    (f) =>
      !named(f?.filename) || (f.previous_filename !== undefined && !named(f.previous_filename)),
  );
  if (unnamed) return 'the compare answered a file entry with no name';
  return read.files.flatMap((f) => [f.filename, f.previous_filename].filter(named) as string[]);
}

type Compared = { readonly status: string; readonly files: string[] } | { readonly why: string };

function rangeCommitOf(c: CommitRead): RangeCommit | null {
  if (typeof c.sha !== 'string' || c.sha === '') return null;
  return {
    sha: c.sha.toLowerCase(),
    parents: (c.parents ?? []).flatMap((p) =>
      typeof p.sha === 'string' ? [p.sha.toLowerCase()] : [],
    ),
    message: c.commit?.message ?? '',
  };
}

/** The reader over a GitHub binding's installation. */
export function githubRepositoryReader(client: GitHubRepoClient): RepositoryReader {
  const repository = client.fullName;
  const commitPath = (ref: string) => `/repos/${repository}/commits/${encodeURIComponent(ref)}`;

  /** One compare, taken only whole: a status and the full file list, or the reason it is not. */
  async function compare(base: string, head: string): Promise<Compared> {
    const read = await client.get<CompareRead>(
      `/repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    if (!read.status) return { why: `${repository} answered no compare status` };
    const files = filesOf(read);
    if (typeof files === 'string') return { why: files };
    return { status: read.status, files };
  }

  async function carriage(judged: string, served: string): Promise<Carriage> {
    const forward = await compare(judged, served);
    if ('why' in forward) return { kind: 'unread', why: forward.why };
    if (DESCENDS.has(forward.status)) return { kind: 'descends' };
    const back = await compare(served, judged);
    if ('why' in back) return { kind: 'unread', why: back.why };
    return { kind: 'differs', paths: [...new Set([...forward.files, ...back.files])].sort() };
  }

  async function changed(landing: string): Promise<ChangedPaths> {
    const commit = await client.get<CommitRead>(commitPath(landing));
    const parent = commit.parents?.[0]?.sha;
    if (!parent) return { kind: 'unread', why: `${landing} has no parent to diff it against` };
    const read = await compare(parent, landing);
    if ('why' in read) return { kind: 'unread', why: read.why };
    return { kind: 'read', paths: [...new Set(read.files)].sort() };
  }

  async function pages(base: string, head: string): Promise<RangeRead> {
    const commits: RangeCommit[] = [];
    for (let page = 1; page <= PAGE_LIMIT; page += 1) {
      const read = await client.get<ComparePage>(
        `/repos/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${PAGE_SIZE}&page=${page}`,
      );
      if (typeof read.total_commits !== 'number' || !Array.isArray(read.commits)) {
        return {
          why: `${repository} answered the compare of ${base}...${head} with no commit list`,
        };
      }
      for (const c of read.commits) {
        const commit = rangeCommitOf(c);
        if (!commit) {
          return { why: `${repository} answered a commit with no sha in ${base}...${head}` };
        }
        commits.push(commit);
      }
      if (commits.length >= read.total_commits) return { commits };
      if (read.commits.length === 0) {
        return {
          why: `${repository} stopped answering ${base}...${head} at ${commits.length} of the ${read.total_commits} commits it reported`,
        };
      }
    }
    return {
      why: `${base}...${head} holds more than ${RANGE_COMMIT_LIMIT} commits, more than one release range is read for`,
    };
  }

  return {
    name: repository,
    route: 'github',

    async commit(ref: string): Promise<CommitLookup> {
      let read: CommitRead;
      try {
        read = await client.get<CommitRead>(commitPath(ref));
      } catch (err) {
        const lookup =
          err instanceof GitHubReadError && err.phase === 'request' ? err.status : null;
        if (lookup === 404 || lookup === 422) {
          // GitHub answers a prefix nothing starts with and one several commits start with alike, so
          // an abbreviated sha it cannot resolve is not reported as absent.
          const detail =
            ref.length >= FULL_SHA_LENGTH
              ? `GitHub finds no commit ${ref} in ${repository} (HTTP ${lookup}). Mark with the sha the work landed at`
              : `GitHub resolves no single commit from ${ref} in ${repository} (HTTP ${lookup}): ` +
                'no commit there starts with it, or more than one does, and GitHub answers both ' +
                'alike. Mark with the full 40-character sha the work landed at';
          return { kind: 'absent', detail, details: { commit: ref, repository } };
        }
        return { kind: 'unreadable', why: why(err) };
      }
      const sha = read.sha?.toLowerCase();
      if (!sha) return { kind: 'unreadable', why: `${repository} answered no sha for it` };
      return {
        kind: 'found',
        sha,
        message: read.commit?.message ?? '',
        parents: (read.parents ?? []).flatMap((p) =>
          typeof p.sha === 'string' ? [p.sha.toLowerCase()] : [],
        ),
        committedAt: read.commit?.committer?.date ?? null,
      };
    },

    async branchHead(branch: string) {
      try {
        const read = await client.get<{ sha?: string }>(commitPath(branch));
        return typeof read.sha === 'string' && read.sha !== ''
          ? { sha: read.sha.toLowerCase() }
          : { why: `${repository} answered no head commit for ${branch}` };
      } catch (err) {
        return { why: `${repository} could not read the head of ${branch}: ${why(err)}` };
      }
    },

    async contains(sha: string, branch: string): Promise<Containment> {
      try {
        const cmp = await client.get<CompareRead>(
          `/repos/${repository}/compare/${sha}...${encodeURIComponent(branch)}`,
        );
        return { contains: !!cmp.status && DESCENDS.has(cmp.status) };
      } catch (err) {
        return { why: why(err) };
      }
    },

    async carriage(judged: string, served: string): Promise<Carriage> {
      try {
        return await carriage(judged, served);
      } catch (err) {
        return {
          kind: 'unread',
          why: `${repository} could not compare ${judged} with ${served}: ${why(err)}`,
        };
      }
    },

    async changedPaths(landing: string): Promise<ChangedPaths> {
      try {
        return await changed(landing);
      } catch (err) {
        return {
          kind: 'unread',
          why: `${repository} could not read what ${landing} changed: ${why(err)}`,
        };
      }
    },

    async range(base: string, head: string): Promise<RangeRead> {
      try {
        return await pages(base, head);
      } catch (err) {
        return { why: `${repository} could not compare ${base} with ${head}: ${why(err)}` };
      }
    },
  };
}
