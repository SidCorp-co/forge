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
    `commit ${commit} could not be checked against this project's repository, so it is not taken as evidence unchecked: ${why}. Mark again once the repository can be read, or record the work's branch in \`workState.branch\` (\`PATCH /api/issues/:id\`) and mark again with \`target\` and this commit, the whole 40-character sha, in \`commit\`: the mark is then an asserted claim of it, which a release places. A commit named only in \`note\` is no claim`,
  );
}

/**
 * Whether `commit` is this issue's landing, read from the project's own repository: the repository
 * resolves it, it is the issue's by the rule every merge stamp is judged by
 * (`merge-identity.ts:mergeIdentityOf`: its subject declares the issue, it merged a change request
 * linking the issue, or it declares none and is the merge this project owes a filing for, which the
 * issue answers), and the base branch or the branch production deploys from contains it. Every other answer is a refusal by name, and a read that could not be taken is one of them.
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
      `commit ${commit} is not an object in ${repository}: ${host.provider} resolves it to no single commit there. Mark with the sha the work landed at`,
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
    `commit ${sha} is in ${repository} and ${branches.join(' and ')} ${branches.length > 1 ? 'do' : 'does'} not contain it, so it has not landed. Mark once it is merged there`,
  );
}

/**
 * A commit a mark names on a git project, read from the repository whoever marks it and whatever work
 * evidence the issue carries: where the repository vouches for it as this issue's landing it is a
 * merge Forge observed, stamped as one (forge dev 2026-10-30: ISS-562 at 61043f926, its run's branch
 * recorded, and ISS-783 at #1235's merge, a person's mark, read as claims while ISS-781's read
 * observed). Where it does not, the mark stays the caller's claim, as it was, saying why.
 */
export async function vouchedCommit(args: {
  issueId: string;
  shape: string;
  commit?: string | undefined;
  landing?: string | undefined;
}): Promise<{
  fromRepository: Extract<CommitLanding, { ok: true }> | null;
  unvouched: string | null;
}> {
  if (args.shape !== 'git' || !args.commit || args.landing) {
    return { fromRepository: null, unvouched: null };
  }
  const read = await readCommitLanding({ issueId: args.issueId, commit: args.commit });
  return read.ok
    ? { fromRepository: read, unvouched: null }
    : { fromRepository: null, unvouched: `${read.code}: ${read.detail}` };
}
