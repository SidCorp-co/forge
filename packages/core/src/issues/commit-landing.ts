import type { CommitLandingRefusalCode } from '@forge/contracts/issues';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { heldIssuePrefixes, issueRefFormatter } from './issue-prefix-read.js';
import { owedFilingOfMark } from './owed-merges.js';
import {
  type CommitHost,
  declaredIssueSeqs,
  type HostCommit,
  isSourceHostUnavailable,
  issueRefPattern,
  readLandingBranches,
  resolveSourceHost,
  subjectOf,
} from './ports.js';

export type CommitLanding =
  | {
      ok: true;
      sha: string;
      committedAt: Date;
      branch: string;
      repository: string;
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
 * resolves it, its subject declares the issue by the rule `commitOwners` places commits with — or it
 * declares none and is the merge this project owes a filing for, which the issue answers
 * (`owedFilingOfMark`, ISS-774) — and the base branch or the branch production deploys from contains
 * it. Every other answer is a refusal by name, and a read that could not be taken is one of them.
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

  const message = read.message;
  const refOf = await issueRefFormatter(projectId);
  const ref = refOf(issSeq);
  const pattern = issueRefPattern(await heldIssuePrefixes(projectId));
  const declared = declaredIssueSeqs(message, pattern, baseBranch);
  const filing = declared.includes(issSeq)
    ? null
    : await owedFilingOfMark({ projectId, issueId, commit: sha, declared });
  if (!declared.includes(issSeq) && !filing) {
    const subject = subjectOf(message);
    return refuse(
      'COMMIT_NOT_THIS_ISSUE',
      `commit ${sha} in ${repository} is not ${ref}'s landing: its subject "${subject}" does not declare ${ref}${declared.length > 0 ? `; it declares ${declared.map(refOf).join(', ')}` : ', and it is the merge of no change request this project owes a filing for'}. A commit is an issue's when its subject names the key in a closing (…) group, opens with it, or merges a branch named for it; a commit naming no issue is the landing of an issue filed for it only while this project owes a filing for its merge (the master's owed filings), and only one issue answers each`,
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
      return { ok: true, sha, committedAt: at, branch, repository, filing: filing?.number ?? null };
    }
  }
  return refuse(
    'COMMIT_NOT_LANDED',
    `commit ${sha} is in ${repository} and ${branches.join(' and ')} ${branches.length > 1 ? 'do' : 'does'} not contain it, so it has not landed. Mark once it is merged there`,
  );
}
