import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { declaredIssueSeqs, subjectOf } from '../projects/commit-owners.js';
import { issueRefPattern } from '../projects/live-reach.js';
import { chainLiveBranch } from '../projects/release-chain.js';
import {
  type RepositoryAccessDeps,
  readableThrough,
  withRepository,
} from '../projects/repository-access.js';
import type { RepositoryReader, RepositoryRoute } from '../projects/repository-reader.js';
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

export type CommitLandingDeps = Partial<RepositoryAccessDeps>;

function refuse(
  code: CommitLandingRefusalCode,
  detail: string,
  details: Record<string, unknown>,
): CommitLanding {
  return { ok: false, code, detail, details };
}

/**
 * An agent's mark on an issue holding no branch or handoff has the commit as its one route left, so
 * the refusal names what reopens it, never the branch the work was done on, which on the
 * base-branch lane is the base branch `collectWorkEvidence` discards.
 */
function unreadable(commit: string, why: string, clears: string): CommitLanding {
  return refuse(
    'COMMIT_UNVERIFIED',
    `commit ${commit} could not be checked against this project's repository, so it is not ` +
      `taken as evidence unchecked: ${why}. This issue records no branch or handoff, so the ` +
      `commit is the only evidence an agent's mark can carry here, and a branch recorded under ` +
      `the base branch's name is not evidence. Two routes clear it: mark again ${clears}; or ` +
      'have a person mark it merged naming no commit and move it through `developed` and ' +
      "`testing`, which hold an agent to this evidence and not a person; a person's mark naming " +
      'a commit is checked against the same repository',
    { commit },
  );
}

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
  if (!row) return unreadable(commit, 'the issue was not found', readableThrough('binding'));
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
  return withRepository(
    projectId,
    async (access) => {
      if (access.kind === 'refused') {
        return unreadable(commit, access.why, readableThrough(access.route));
      }
      return landingIn(access.reader, { projectId, issSeq, commit, baseBranch, branches });
    },
    deps,
  );
}

async function landingIn(
  reader: RepositoryReader,
  args: {
    projectId: string;
    issSeq: number;
    commit: string;
    baseBranch: string;
    branches: string[];
  },
): Promise<CommitLanding> {
  const { projectId, issSeq, commit, baseBranch, branches } = args;
  const repository = reader.name;
  const clears = readableThrough(reader.route);
  const looked = await reader.commit(commit);
  if (looked.kind === 'absent') {
    return refuse('COMMIT_NOT_IN_REPOSITORY', looked.detail, looked.details);
  }
  if (looked.kind === 'unreadable') return unreadable(commit, looked.why, clears);
  const { sha, message } = looked;

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
    const held = await reader.contains(sha, branch);
    if ('why' in held) return unreadable(commit, held.why, clears);
    if (held.contains) {
      const at = new Date(looked.committedAt ?? '');
      if (Number.isNaN(at.getTime())) {
        return unreadable(commit, `${repository} answered no committer date for ${sha}`, clears);
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

export type CommitResolution =
  | { ok: true; sha: string; repository: string }
  | {
      ok: false;
      code: 'COMMIT_NOT_IN_REPOSITORY' | 'COMMIT_UNVERIFIED';
      detail: string;
      details: Record<string, unknown>;
      /** The cause alone, for a reader that words its own sentence around it. */
      reason: string;
    };

/**
 * The commit a mark on a `git` project names, as the project's repository resolves it: the full sha
 * it holds under that name, or a refusal by name. Unlike `readCommitLanding` it does not ask whether
 * the commit is this issue's landing, so what it resolves stays the caller's claim.
 */
export async function resolveMarkCommit(
  args: { projectId: string; commit: string },
  deps: CommitLandingDeps = {},
): Promise<CommitResolution> {
  const { projectId, commit } = args;
  const unresolved = (why: string, route: RepositoryRoute): CommitResolution => ({
    ok: false,
    code: 'COMMIT_UNVERIFIED',
    detail:
      `commit ${commit} could not be checked against this project's repository, so the mark is ` +
      `not recorded naming it unchecked: ${why}. Mark again ${readableThrough(route)}, or mark it naming no ` +
      'commit, which records a claim that names none',
    details: { commit },
    reason: `the repository could not be read: ${why}`,
  });
  return withRepository(
    projectId,
    async (access) => {
      if (access.kind === 'refused') return unresolved(access.why, access.route);
      const { reader } = access;
      const looked = await reader.commit(commit);
      if (looked.kind === 'unreadable') return unresolved(looked.why, reader.route);
      if (looked.kind === 'absent') {
        return {
          ok: false,
          code: 'COMMIT_NOT_IN_REPOSITORY',
          detail: looked.detail,
          details: looked.details,
          reason: `${reader.name} does not resolve it`,
        };
      }
      return { ok: true, sha: looked.sha, repository: reader.name };
    },
    deps,
  );
}
