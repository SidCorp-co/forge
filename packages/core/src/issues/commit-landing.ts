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
import {
  type RepositoryReader,
  type RepositoryRoute,
  saying,
} from '../projects/repository-reader.js';
import { heldIssuePrefixes, issueRefFormatter } from './issue-prefix-read.js';
import { absentCommit, checkStep, shortCommit, withReason } from './merge-record.js';

export type CommitLandingRefusalCode =
  | 'COMMIT_NOT_IN_REPOSITORY'
  | 'COMMIT_NOT_THIS_ISSUE'
  | 'COMMIT_NOT_LANDED'
  | 'COMMIT_UNVERIFIED';

export type CommitLanding =
  | {
      ok: true;
      sha: string;
      committedAt: Date;
      branch: string;
      repository: string;
    }
  | {
      ok: false;
      code: CommitLandingRefusalCode;
      detail: string;
      details: Record<string, unknown>;
      /**
       * Present wherever Forge could not tell whether the commit is this issue's landing: the
       * project declares no way to read its repository (`noReader`, ISS-1409), a reader is
       * configured and fails, or the project names no base branch to look on. Absent where the
       * repository was READ and says no, which stays a refusal by name. `why` is the cause in the
       * host's own words (for `noReader`, with the setting that clears it); `clears` finishes
       * "mark again ..." with what would let Forge verify it.
       */
      unreadable?: { why: string; clears: string; noReader: boolean };
    };

export type CommitLandingDeps = Partial<RepositoryAccessDeps>;

function refuse(
  code: CommitLandingRefusalCode,
  detail: string,
  details: Record<string, unknown>,
  unreadable?: { why: string; clears: string; noReader: boolean },
): CommitLanding {
  return unreadable
    ? { ok: false, code, detail, details, unreadable }
    : { ok: false, code, detail, details };
}

/** `claimable: false` leaves it a refusal: an issue that was not found has nothing to record a claim on. */
function unreadable(
  commit: string,
  why: string,
  clears: string,
  how: { noReader?: boolean; claimable?: boolean } = {},
): CommitLanding {
  const { noReader = false, claimable = true } = how;
  return refuse(
    'COMMIT_UNVERIFIED',
    uncheckedCommit(commit, why, { clears, noReader }),
    { commit },
    claimable ? { why, clears, noReader } : undefined,
  );
}

/** What was not checked and what checks it, the host's reason quoted beneath (ISS-1421: three short
 *  sentences). Only a refused mark, which a caller makes on an issue not yet marked, offers a mark
 *  naming no commit: on a marked issue that would change nothing. */
function uncheckedCommit(
  commit: string,
  why: string,
  how: { clears: string; noReader: boolean },
  refused = false,
): string {
  const named = shortCommit(commit);
  const said = refused
    ? `Nothing was marked, because Forge could not check commit ${named} against the repository. ${checkStep({ why, ...how })}. Or mark it naming no commit, which records a claim.`
    : `Forge could not check commit ${named} against the repository. ${checkStep({ why, ...how })}.`;
  return withReason(said, why);
}

/** A commit the repository does not hold, in our words, naming the repository and what was typed. */
function notInRepository(
  commit: string,
  looked: { detail: string; details: Record<string, unknown> },
) {
  const where =
    typeof looked.details.repository === 'string' ? ` ${looked.details.repository}` : '';
  const said = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)
    ? `The repository${where} holds no commit ${absentCommit(commit)}. Mark it with the commit the work landed at.`
    : `The repository${where} resolves no single commit from ${commit.length < 40 ? commit : shortCommit(commit)}. Mark it with the full sha the work landed at.`;
  // Only an overlong name's reason says more than the sentence above does.
  return {
    detail: withReason(said, /hex digits/.test(looked.detail) ? looked.detail : null),
    details: looked.details,
  };
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
  if (!row) {
    return unreadable(commit, 'the issue was not found', readableThrough('binding'), {
      claimable: false,
    });
  }
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
        return unreadable(commit, saying(access), readableThrough(access.route), {
          noReader: access.unbound,
        });
      }
      return landingIn(access.reader, {
        projectId,
        issSeq,
        commit,
        baseBranch,
        branches,
      });
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
    const { detail, details } = notInRepository(commit, looked);
    return refuse('COMMIT_NOT_IN_REPOSITORY', detail, details);
  }
  if (looked.kind === 'unreadable') return unreadable(commit, looked.why, clears);
  const { sha, message } = looked;

  const ref = (await issueRefFormatter(projectId))(issSeq);
  const pattern = issueRefPattern(await heldIssuePrefixes(projectId));
  if (!declaredIssueSeqs(message, pattern, baseBranch).includes(issSeq)) {
    const subject = subjectOf(message);
    return refuse(
      'COMMIT_NOT_THIS_ISSUE',
      // The subject is quoted as the commit holds it: never stopped, capitalised or respaced.
      `Commit ${shortCommit(sha)} is not ${ref}'s landing, because its subject does not name ${ref}. Mark the commit whose subject ends with (${ref}), opens with ${ref}, or merges its branch.\n> ${subject.trim()}`,
      { commit: sha, repository, subject, issue: ref },
    );
  }

  for (const branch of branches) {
    const held = await reader.contains(sha, branch);
    if ('why' in held) {
      const fix = held.missingBranch
        ? `once ${repository} has a branch ${held.missingBranch}, or the project's base branch and release chain name only branches it has`
        : clears;
      return unreadable(commit, held.why, fix);
    }
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
    `Commit ${shortCommit(sha)} is in ${repository}, but ${branches.join(' and ')} ${branches.length > 1 ? 'do' : 'does'} not contain it, so it has not landed. Mark it once it is merged there.`,
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
      /** Where Forge could not read the repository: the host's reason, which a marked issue
       *  answers with where its mark stays rather than with this refusal. */
      unread?: { why: string };
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
  const unresolved = (
    why: string,
    route: RepositoryRoute,
    noReader: boolean,
  ): CommitResolution => ({
    ok: false,
    code: 'COMMIT_UNVERIFIED',
    detail: uncheckedCommit(commit, why, { clears: readableThrough(route), noReader }, true),
    details: { commit },
    reason: `the repository could not be read: ${why}`,
    unread: { why },
  });
  return withRepository(
    projectId,
    async (access) => {
      if (access.kind === 'refused') {
        return unresolved(saying(access), access.route, access.unbound);
      }
      const { reader } = access;
      const looked = await reader.commit(commit);
      if (looked.kind === 'unreadable') return unresolved(looked.why, reader.route, false);
      if (looked.kind === 'absent') {
        return {
          ok: false,
          code: 'COMMIT_NOT_IN_REPOSITORY',
          ...notInRepository(commit, looked),
          reason: `${reader.name} does not resolve it`,
        };
      }
      return { ok: true, sha: looked.sha, repository: reader.name };
    },
    deps,
  );
}
