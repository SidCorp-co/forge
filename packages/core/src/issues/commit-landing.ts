import type { CommitLandingRefusalCode } from '@forge/contracts/issues';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { mergeIdentityOf } from './merge-identity.js';
import {
  type CommitHost,
  type HostCommit,
  isSourceHostUnavailable,
  readLandingBranches,
  resolveSourceHost,
} from './ports.js';

export type CommitLanding =
  | {
      ok: true;
      sha: string;
      committedAt: Date;
      branch: string;
      repository: string;
      /** How the commit is this issue's: its subject, a change request it merged that links the
       *  issue, or the owed filing it answers (`merge-identity.ts:mergeIdentityOf`). */
      by: 'subject' | 'change-request' | 'filing';
      /** The change request whose owed filing this issue answers, where its subject declares none. */
      filing: number | null;
    }
  | {
      ok: false;
      code: CommitLandingRefusalCode;
      detail: string;
    };

interface CommitLandingDeps {
  host?: (projectId: string) => Promise<CommitHost>;
}

function refuse(code: CommitLandingRefusalCode, detail: string): CommitLanding {
  return { ok: false, code, detail };
}

function unreadable(commit: string, why: string): CommitLanding {
  return refuse(
    'COMMIT_UNVERIFIED',
    `commit ${commit} could not be read from this project's repository: ${why}`,
  );
}

/**
 * Whether `commit` is this issue's landing, read from the project's own repository: the repository
 * resolves it, it is the issue's by the rule every merge stamp is judged by
 * (`merge-identity.ts:mergeIdentityOf`: its subject declares the issue, it merged a change request
 * linking the issue, or it declares none and is the merge this project owes a filing for, which the
 * issue answers), and the base branch or the branch production deploys from contains it. Every other
 * answer names why, a read that could not be taken among them; the mark records it as a reading.
 */
export async function readCommitLanding(
  args: { issueId: string; commit: string },
  deps: CommitLandingDeps = {},
): Promise<CommitLanding> {
  const { issueId, commit } = args;
  const [row] = await db
    .select({
      projectId: issues.projectId,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return unreadable(commit, 'the issue was not found');
  const { projectId } = row;
  const { defaultBranch: baseBranch, promoted: live } = await readLandingBranches(projectId);
  if (!baseBranch) {
    return unreadable(
      commit,
      'the project document declares no `source.git.defaultBranch` to look for it on',
    );
  }
  const branches = live && live !== baseBranch ? [baseBranch, live] : [baseBranch];

  let host: CommitHost;
  try {
    host = await (deps.host ?? ((id: string) => resolveSourceHost(id, 'kernel')))(projectId);
  } catch (err) {
    if (isSourceHostUnavailable(err)) return unreadable(commit, err.message);
    throw err;
  }
  const repository = host.fullName;

  let read: HostCommit | null;
  try {
    read = await host.readCommit(commit);
  } catch (err) {
    return unreadable(commit, err instanceof Error ? err.message : String(err));
  }
  if (!read) {
    return refuse(
      'COMMIT_NOT_IN_REPOSITORY',
      `commit ${commit} is not an object in ${repository}: ${host.provider} resolves it to no single commit there`,
    );
  }
  const sha = read.sha.toLowerCase();

  // one rule with every stamp a merge writes (`merge-identity.ts`), read for a mark naming the commit
  const identity = await mergeIdentityOf({ projectId, commitSha: sha, markNamed: true, read })(
    issueId,
  );
  if (!identity.holds) {
    return refuse(identity.code, `${identity.detail}, in ${repository}`);
  }

  for (const branch of branches) {
    let contained: boolean;
    try {
      contained = await host.branchContains(branch, sha);
    } catch (err) {
      return unreadable(commit, err instanceof Error ? err.message : String(err));
    }
    if (contained) {
      const at = new Date(read.committedAt ?? '');
      if (Number.isNaN(at.getTime())) {
        return unreadable(commit, `${repository} answered no committer date for ${sha}`);
      }
      return {
        ok: true,
        sha,
        committedAt: at,
        branch,
        repository,
        by: identity.by,
        filing: identity.filing ?? null,
      };
    }
  }
  return refuse(
    'COMMIT_NOT_LANDED',
    `commit ${sha} is in ${repository} and ${branches.join(' and ')} ${branches.length > 1 ? 'do' : 'does'} not contain it`,
  );
}

/**
 * What the repository said of a commit a mark names, recorded on the mark as a reading and never as
 * its refusal (ISS-1017): `found` where it is this issue's landing on the base or live branch, else
 * why not, by the code the read gave. The mark stands either way; whether the work is done is the
 * agent's call.
 */
export type CommitReading =
  | {
      commit: string;
      outcome: 'found';
      branch: string;
      repository: string;
      by: 'subject' | 'change-request' | 'filing';
    }
  | {
      commit: string;
      outcome: 'not_found' | 'not_on_target' | 'not_this_issue' | 'unread';
      code: CommitLandingRefusalCode;
      detail: string;
    };

const OUTCOME_OF: Readonly<
  Record<CommitLandingRefusalCode, Exclude<CommitReading['outcome'], 'found'>>
> = {
  COMMIT_NOT_IN_REPOSITORY: 'not_found',
  COMMIT_NOT_LANDED: 'not_on_target',
  COMMIT_NOT_THIS_ISSUE: 'not_this_issue',
  COMMIT_UNVERIFIED: 'unread',
};

/** The reading a mark records of `commit`, from the repository's answer. */
export function commitReadingOf(commit: string, read: CommitLanding): CommitReading {
  if (read.ok) {
    return {
      commit,
      outcome: 'found',
      branch: read.branch,
      repository: read.repository,
      by: read.by,
    };
  }
  return { commit, outcome: OUTCOME_OF[read.code], code: read.code, detail: read.detail };
}

/**
 * A commit a mark names on a git project, read from the repository whoever marks it and whatever the
 * issue carries: where the repository vouches for it as this issue's landing it is a merge Forge
 * observed, stamped as one (forge dev 2026-10-30: ISS-562 at 61043f926, its run's branch recorded, and
 * ISS-783 at #1235's merge, a person's mark, read as claims while ISS-781's read observed). Where it
 * does not, the mark stays the caller's claim, and what the repository said is its reading.
 */
export async function vouchedCommit(args: {
  issueId: string;
  shape: string;
  commit?: string | undefined;
}): Promise<{
  fromRepository: Extract<CommitLanding, { ok: true }> | null;
  reading: CommitReading | null;
}> {
  if (args.shape !== 'git' || !args.commit) return { fromRepository: null, reading: null };
  const read = await readCommitLanding({ issueId: args.issueId, commit: args.commit });
  return { fromRepository: read.ok ? read : null, reading: commitReadingOf(args.commit, read) };
}
