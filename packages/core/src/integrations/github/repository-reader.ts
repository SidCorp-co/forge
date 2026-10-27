/**
 * The repository reads Forge takes through a project's GitHub binding (ISS-1398 moved them here
 * from their callers, request for request): a commit by its sha, a branch's head, whether a branch
 * contains a commit, what a served commit carries of a judged one, what a landing changed, and the
 * commits between a branch and a commit, and which tags hold a commit (ISS-1391). GitHub answers a pair with no common ancestor with a 404,
 * which arrives as a failed request and is unread like any other.
 */

import {
  matchingTagsNewestFirst,
  RELEASE_TAG_COMPARE_BATCH,
  RELEASE_TAG_LIST_CEILING,
} from '../../projects/release-tag.js';
import {
  type Carriage,
  type ChangedPaths,
  type CommitLookup,
  type Containment,
  MARK_WITH_WHOLE_SHA,
  overlongCommitName,
  overlongLookup,
  RANGE_COMMIT_LIMIT,
  type RangeCommit,
  type RangeRead,
  type ReadFailure,
  type RepositoryReader,
  type TagContainment,
} from '../../projects/repository-reader.js';
import { GitHubReadError, type GitHubRepoClient } from './client.js';

/** GitHub names at most this many files in one compare, and says nothing of the rest. */
export const COMPARE_FILE_CEILING = 300;

/** GitHub pages a compare's commits; past this many pages the range is too long to read whole. */
const PAGE_SIZE = 100;
const PAGE_LIMIT = RANGE_COMMIT_LIMIT / PAGE_SIZE;

/** GitHub serves SHA-1 repositories, so a whole sha is 40 digits and a shorter name a prefix. */
const FULL_SHA_LENGTH = 40;
const FULL_SHA = /^[0-9a-f]{40}$/i;

const TOO_MANY = `${COMPARE_FILE_CEILING} or more files differ, and the repository names no more than that in one compare`;

const DESCENDS = new Set(['ahead', 'identical']);

/** A commit lookup's two refusals, as GitHub tells them apart (measured on api.github.com
 *  2026-10-25): a repository the caller cannot see, and a commit a readable repository lacks. */
const REPOSITORY_HIDDEN = 404;
const COMMIT_UNKNOWN = 422;

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

interface TagRead {
  name?: string;
  commit?: { sha?: string };
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** GitHub refusing the repository itself: no token, no permission, or a repository it hides. A 404
 *  says that only where the path names no branch or range that may be missing. */
function refusedBy(err: unknown, statuses: readonly number[]): { refused?: true } {
  const status = err instanceof GitHubReadError && err.phase === 'request' ? err.status : null;
  return status !== null && statuses.includes(status) ? { refused: true } : {};
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

/** Every tag and the commit it names, which the listing peels an annotated tag down to. */
async function listTags(client: GitHubRepoClient): Promise<Map<string, string> | string> {
  const repository = client.fullName;
  const tags = new Map<string, string>();
  // One page past the ceiling's worth, so a repository holding exactly the ceiling is read whole.
  for (let page = 1; page <= RELEASE_TAG_LIST_CEILING / PAGE_SIZE + 1; page += 1) {
    const read = await client.get<TagRead[]>(
      `/repos/${repository}/tags?per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(read)) return `${repository} answered its tag list with no array`;
    for (const t of read) {
      if (typeof t.name !== 'string' || typeof t.commit?.sha !== 'string') {
        return `${repository} answered a tag with no name or no commit`;
      }
      tags.set(t.name, t.commit.sha.toLowerCase());
    }
    if (tags.size > RELEASE_TAG_LIST_CEILING) break;
    if (read.length < PAGE_SIZE) return tags;
  }
  return `${repository} holds more than ${RELEASE_TAG_LIST_CEILING} tags, more than one reading lists whole, so whether a tag holds the commit cannot be read`;
}

/**
 * The matching tags, newest first, that contain `sha`: batches of compares until one holds it. A
 * compare that fails never hides a tag another one shows; it only makes "none hold it" unreadable.
 */
async function holding(
  client: GitHubRepoClient,
  sha: string,
  matching: string[],
  tags: Map<string, string>,
): Promise<string[]> {
  const repository = client.fullName;
  const containing: string[] = [];
  const failures: unknown[] = [];
  for (
    let at = 0;
    at < matching.length && containing.length === 0;
    at += RELEASE_TAG_COMPARE_BATCH
  ) {
    const batch = matching.slice(at, at + RELEASE_TAG_COMPARE_BATCH);
    const settled = await Promise.allSettled(
      batch.map((name) =>
        client.get<CompareRead>(
          `/repos/${repository}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(tags.get(name) as string)}?per_page=1`,
        ),
      ),
    );
    settled.forEach((result, i) => {
      if (result.status === 'rejected') failures.push(result.reason);
      else if (DESCENDS.has(result.value.status ?? '')) containing.push(batch[i] as string);
    });
  }
  if (containing.length === 0 && failures.length > 0) throw failures[0];
  return containing;
}

/** A request GitHub itself answered with `status`; a mint or a network failure answers null. */
const statusOf = (err: unknown): number | null =>
  err instanceof GitHubReadError && err.phase === 'request' ? err.status : null;

/** A branch head GitHub would not give: a branch a repository it shows lacks (422, as for a commit),
 *  or the repository refusing the read; anything else is unread for a reason of its own. */
export function headFailure(err: unknown, repository: string, branch: string): ReadFailure {
  const failed = `${repository} could not read the head of ${branch}: ${why(err)}`;
  if (statusOf(err) === COMMIT_UNKNOWN) return { why: failed, missingBranch: branch };
  return { why: failed, ...refusedBy(err, [401, 403, REPOSITORY_HIDDEN]) };
}

/** What a compare GitHub answered 404 for lacks, read one ref at a time: a branch or commit the
 *  repository was read and does not hold (422), or the repository itself hidden (404). Both found,
 *  the two share no history. A lookup that fails otherwise names nothing (ISS-1300 r4). */
async function compareMissing(
  client: GitHubRepoClient,
  base: string,
  head: string,
  failed: string,
): Promise<ReadFailure> {
  const repository = client.fullName;
  for (const ref of [base, head]) {
    try {
      await client.get<CommitRead>(`/repos/${repository}/commits/${encodeURIComponent(ref)}`);
    } catch (err) {
      const status = statusOf(err);
      if (status === REPOSITORY_HIDDEN || status === 401 || status === 403) {
        return { why: failed, refused: true };
      }
      if (status !== COMMIT_UNKNOWN) return { why: failed };
      return FULL_SHA.test(ref)
        ? { why: failed, missingCommit: ref }
        : { why: failed, missingBranch: ref };
    }
  }
  return {
    why: `${base} and ${head} share no history in ${repository}, so they cannot be compared`,
  };
}

/** The reader over a GitHub binding's installation. */
export function githubRepositoryReader(client: GitHubRepoClient): RepositoryReader {
  const repository = client.fullName;
  const commitPath = (ref: string) => `/repos/${repository}/commits/${encodeURIComponent(ref)}`;
  /** Why a commit name GitHub would answer by its first 40 digits names no commit, or null. */
  const overlong = (...names: string[]) =>
    names.map((n) => overlongCommitName(n, FULL_SHA_LENGTH, repository)).find((w) => w) ?? null;

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

  /** A 404 is GitHub refusing to show the repository, so it says nothing of the commit. */
  function hidden(ref: string): string {
    return (
      `${repository} answered HTTP 404, which GitHub gives for a repository this project's GitHub ` +
      `installation cannot see, so whether it holds ${ref} was not read. Restore ${repository} to ` +
      "the GitHub App installation's repositories, or connect the project to where it now lives"
    );
  }

  return {
    name: repository,
    route: 'binding',
    reach: client.reach,

    async commit(ref: string): Promise<CommitLookup> {
      const named = overlong(ref);
      if (named) return overlongLookup(ref, named, repository);
      let read: CommitRead;
      try {
        read = await client.get<CommitRead>(commitPath(ref));
      } catch (err) {
        const lookup =
          err instanceof GitHubReadError && err.phase === 'request' ? err.status : null;
        if (lookup === REPOSITORY_HIDDEN) return { kind: 'unreadable', why: hidden(ref) };
        if (lookup === COMMIT_UNKNOWN) {
          // GitHub answers a prefix nothing starts with and one several commits start with alike, so
          // an abbreviated sha it cannot resolve is not reported as absent.
          const detail =
            ref.length >= FULL_SHA_LENGTH
              ? `GitHub finds no commit ${ref} in ${repository} (HTTP ${lookup}). Mark with the sha the work landed at`
              : `GitHub resolves no single commit from ${ref} in ${repository} (HTTP ${lookup}): ` +
                'no commit there starts with it, or more than one does, and GitHub answers both ' +
                `alike. ${MARK_WITH_WHOLE_SHA}`;
          return { kind: 'absent', detail, details: { commit: ref, repository } };
        }
        // GitHub's own refusals name the repository or the installation token; a request that
        // never reached GitHub names neither.
        if (err instanceof GitHubReadError) return { kind: 'unreadable', why: why(err) };
        return { kind: 'unreadable', why: `${repository} could not be read: ${why(err)}` };
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
        return headFailure(err, repository, branch);
      }
    },

    async contains(sha: string, branch: string): Promise<Containment> {
      const named = overlong(sha);
      if (named) return { why: named };
      try {
        const cmp = await client.get<CompareRead>(
          `/repos/${repository}/compare/${encodeURIComponent(sha)}...${encodeURIComponent(branch)}`,
        );
        return { contains: !!cmp.status && DESCENDS.has(cmp.status) };
      } catch (err) {
        return { why: why(err) };
      }
    },

    async descends(ancestor: string, head: string): Promise<Containment> {
      const named = overlong(ancestor, head);
      if (named) return { why: named };
      try {
        // One commit per page: only the status is read, so a long range or a wide diff never
        // makes the answer unreadable the way a whole compare's file list does.
        const cmp = await client.get<CompareRead>(
          `/repos/${repository}/compare/${encodeURIComponent(ancestor)}...${encodeURIComponent(head)}?per_page=1`,
        );
        if (!cmp.status) return { why: `${repository} answered no compare status` };
        return { contains: DESCENDS.has(cmp.status) };
      } catch (err) {
        return { why: `${repository} could not compare ${ancestor} with ${head}: ${why(err)}` };
      }
    },

    async tagsContaining(commit: string, pattern: string): Promise<TagContainment> {
      const named = overlong(commit);
      if (named) return { why: named };
      try {
        const found = await client.get<CommitRead>(commitPath(commit));
        const sha = found.sha?.toLowerCase();
        if (!sha) return { why: `${repository} answered no sha for ${commit}` };
        const tags = await listTags(client);
        if (typeof tags === 'string') return { why: tags };
        const matching = matchingTagsNewestFirst(pattern, [...tags.keys()]);
        const containing = await holding(client, sha, matching, tags);
        return { commit: sha, matching, containing };
      } catch (err) {
        return { why: `${repository} could not read which tags hold ${commit}: ${why(err)}` };
      }
    },

    async carriage(judged: string, served: string): Promise<Carriage> {
      const named = overlong(judged, served);
      if (named) return { kind: 'unread', why: named };
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
      const named = overlong(landing);
      if (named) return { kind: 'unread', why: named };
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
      const named = overlong(head);
      if (named) return { why: named };
      try {
        return await pages(base, head);
      } catch (err) {
        const failed = `${repository} could not compare ${base} with ${head}: ${why(err)}`;
        if (statusOf(err) === REPOSITORY_HIDDEN) return compareMissing(client, base, head, failed);
        return { why: failed, ...refusedBy(err, [401, 403]) };
      }
    },
  };
}
