import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import {
  GitHubClientError,
  GitHubReadError,
  type GitHubRepoClient,
  githubRepoClient,
} from '../integrations/github/client.js';
import { declaredIssueSeqs, subjectOf } from '../projects/commit-owners.js';
import { issueRefPattern } from '../projects/live-reach.js';
import { chainLiveBranch } from '../projects/release-chain.js';
import { heldIssuePrefixes, issueRefFormatter } from './issue-prefix-read.js';

export type CommitLandingRefusalCode =
  | 'COMMIT_NOT_IN_REPOSITORY'
  | 'COMMIT_NOT_THIS_ISSUE'
  | 'COMMIT_NOT_LANDED'
  | 'COMMIT_UNVERIFIED';

export type CommitLanding =
  | { ok: true; sha: string; committedAt: Date; branch: string; repository: string }
  | {
      ok: false;
      code: CommitLandingRefusalCode;
      detail: string;
      details: Record<string, unknown>;
    };

export interface CommitLandingDeps {
  client?: (projectId: string) => Promise<GitHubRepoClient>;
}

interface CommitRead {
  sha?: string;
  commit?: { message?: string; committer?: { date?: string } };
}

interface CompareRead {
  status?: string;
}

const CONTAINED = new Set(['ahead', 'identical']);

function refuse(
  code: CommitLandingRefusalCode,
  detail: string,
  details: Record<string, unknown>,
): CommitLanding {
  return { ok: false, code, detail, details };
}

const READABLE =
  "once the tracker can read the project's repository — a GitHub binding whose installation can " +
  'read it';

/**
 * Only an agent's mark on an issue holding no branch or handoff reads the repository, so the
 * commit is the one route left: the refusal names what reopens it, never the branch the work was
 * done on, which on the base-branch lane is the base branch `collectWorkEvidence` discards.
 */
function unreadable(commit: string, why: string, clears: string = READABLE): CommitLanding {
  return refuse(
    'COMMIT_UNVERIFIED',
    `commit ${commit} could not be checked against this project's repository, so it is not ` +
      `taken as evidence unchecked: ${why}. This issue records no branch or handoff, so the ` +
      `commit is the only evidence an agent's mark can carry here, and a branch recorded under ` +
      `the base branch's name is not evidence. Mark again ${clears}, or have a person mark it merged`,
    { commit },
  );
}

/** Long enough to be a whole sha (SHA-1, or SHA-256 at 64), which GitHub cannot read as a prefix. */
const FULL_SHA_LENGTH = 40;

/**
 * Whether `commit` is this issue's landing, read from the project's own repository: the repository
 * resolves it, its subject declares the issue by the rule `commitOwners` places commits with, and
 * the base branch or the release chain's live branch contains it. Every other answer is a refusal
 * by name, and a read that could not be taken is one of them.
 */
export async function readCommitLanding(
  args: { issueId: string; commit: string },
  deps: CommitLandingDeps = {},
): Promise<CommitLanding> {
  const { issueId, commit } = args;
  const [row] = await db
    .select({
      projectId: issues.projectId,
      issSeq: issues.issSeq,
      baseBranch: projects.baseBranch,
      releaseChain: projects.releaseChain,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return unreadable(commit, 'the issue was not found');
  const { projectId, issSeq } = row;
  const baseBranch = row.baseBranch?.trim() || null;
  if (!baseBranch) {
    return unreadable(
      commit,
      'the project names no base branch to look for it on',
      'once the project names its base branch',
    );
  }
  const live = chainLiveBranch(row.releaseChain);
  const branches = live && live !== baseBranch ? [baseBranch, live] : [baseBranch];

  let client: GitHubRepoClient;
  try {
    client = await (deps.client ?? githubRepoClient)(projectId);
  } catch (err) {
    if (err instanceof GitHubClientError) return unreadable(commit, err.message);
    throw err;
  }
  const repository = client.fullName;

  let read: CommitRead;
  try {
    read = await client.get<CommitRead>(
      `/repos/${repository}/commits/${encodeURIComponent(commit)}`,
    );
  } catch (err) {
    const lookup = err instanceof GitHubReadError && err.phase === 'request' ? err.status : null;
    if (lookup === 404 || lookup === 422) {
      // GitHub answers a prefix nothing starts with and one several commits start with alike, so
      // an abbreviated sha it cannot resolve is not reported as absent.
      const detail =
        commit.length >= FULL_SHA_LENGTH
          ? `GitHub finds no commit ${commit} in ${repository} (HTTP ${lookup}). Mark with the sha the work landed at`
          : `GitHub resolves no single commit from ${commit} in ${repository} (HTTP ${lookup}): ` +
            'no commit there starts with it, or more than one does, and GitHub answers both ' +
            'alike. Mark with the full 40-character sha the work landed at';
      return refuse('COMMIT_NOT_IN_REPOSITORY', detail, { commit, repository });
    }
    return unreadable(commit, err instanceof Error ? err.message : String(err));
  }
  const sha = read.sha?.toLowerCase();
  if (!sha) return unreadable(commit, `${repository} answered no sha for it`);

  const message = read.commit?.message ?? '';
  const ref = (await issueRefFormatter(projectId))(issSeq);
  const pattern = issueRefPattern(await heldIssuePrefixes(projectId));
  if (!declaredIssueSeqs(message, pattern, baseBranch).includes(issSeq)) {
    const subject = subjectOf(message);
    return refuse(
      'COMMIT_NOT_THIS_ISSUE',
      `commit ${sha} in ${repository} is not ${ref}'s landing: its subject "${subject}" does not declare ${ref}. A commit is an issue's when its subject names the key in a closing (…) group, opens with it, or merges a branch named for it`,
      { commit: sha, repository, subject, issue: ref },
    );
  }

  for (const branch of branches) {
    let cmp: CompareRead;
    try {
      cmp = await client.get<CompareRead>(
        `/repos/${repository}/compare/${sha}...${encodeURIComponent(branch)}`,
      );
    } catch (err) {
      return unreadable(commit, err instanceof Error ? err.message : String(err));
    }
    if (cmp.status && CONTAINED.has(cmp.status)) {
      const at = new Date(read.commit?.committer?.date ?? '');
      if (Number.isNaN(at.getTime())) {
        return unreadable(commit, `${repository} answered no committer date for ${sha}`);
      }
      return { ok: true, sha, committedAt: at, branch, repository };
    }
  }
  return refuse(
    'COMMIT_NOT_LANDED',
    `commit ${sha} is in ${repository} and ${branches.join(' and ')} ${branches.length > 1 ? 'do' : 'does'} not contain it, so it has not landed. Mark once it is merged there`,
    { commit: sha, repository, branches },
  );
}
