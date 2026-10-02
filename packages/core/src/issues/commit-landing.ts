import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { SourceHostUnavailable } from '../integrations/source-host/errors.js';
import { resolveSourceHost } from '../integrations/source-host/resolve.js';
import type { HostCommit, SourceHost } from '../integrations/source-host/types.js';
import { readLandingBranches } from '../project-config/release-path.js';
import { declaredIssueSeqs, subjectOf } from '../projects/commit-owners.js';
import { issueRefPattern } from '../projects/live-reach.js';
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
  host?: (projectId: string) => Promise<SourceHost>;
}

function refuse(
  code: CommitLandingRefusalCode,
  detail: string,
  details: Record<string, unknown>,
): CommitLanding {
  return { ok: false, code, detail, details };
}

function unreadable(commit: string, why: string): CommitLanding {
  return refuse(
    'COMMIT_UNVERIFIED',
    `commit ${commit} could not be checked against this project's repository, so it is not taken as evidence unchecked: ${why}. Mark again once the repository can be read, or record the branch the work was done on`,
    { commit },
  );
}

/**
 * Whether `commit` is this issue's landing, read from the project's own repository: the repository
 * resolves it, its subject declares the issue by the rule `commitOwners` places commits with, and
 * the base branch or the branch production deploys from contains it. Every other answer is a refusal
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
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return unreadable(commit, 'the issue was not found');
  const { projectId, issSeq } = row;
  const { defaultBranch: baseBranch, promoted: live } = await readLandingBranches(projectId);
  if (!baseBranch) {
    return unreadable(
      commit,
      'the project document declares no `source.git.defaultBranch` to look for it on',
    );
  }
  const branches = live && live !== baseBranch ? [baseBranch, live] : [baseBranch];

  let host: SourceHost;
  try {
    host = await (deps.host ?? ((id: string) => resolveSourceHost(id, 'kernel')))(projectId);
  } catch (err) {
    if (err instanceof SourceHostUnavailable) return unreadable(commit, err.message);
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
      { commit, repository },
    );
  }
  const sha = read.sha.toLowerCase();

  const message = read.message;
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
      return { ok: true, sha, committedAt: at, branch, repository };
    }
  }
  return refuse(
    'COMMIT_NOT_LANDED',
    `commit ${sha} is in ${repository} and ${branches.join(' and ')} ${branches.length > 1 ? 'do' : 'does'} not contain it, so it has not landed. Mark once it is merged there`,
    { commit: sha, repository, branches },
  );
}
