/**
 * Whether a merge a change request reports is THIS issue's landing, asked before any stamp is
 * written from it (adminhub-fe, 2026-10-26).
 *
 * GitLab marks a merge request merged once its commits land through another one, so a stale request
 * sharing a head with the one merged — opened under keys later renumbered — read as merged at the
 * other's commit and stamped every issue its links named, drafts among them, superseding marks they
 * held. A link is what a request SAYS it delivers; the commit is what landed. So the stamp is taken
 * only where the commit itself answers for the issue: its subject declares it by the rule the mark
 * route reads a landing with (`commit-landing.ts:readCommitLanding`, `declaredIssueSeqs`), or it
 * names the change request it merged (`See merge request …!12`, `Merge pull request #12`, `(#12)`)
 * and that request links the issue (REQ-63 BC-4: one request delivers every issue it names). The
 * request Forge merged itself is named by the merge, not by its message. Anything else is refused by
 * name, with the commit and the reason, and recorded on the issue (`recordRefusedStamp`).
 */

import type { CommitLandingRefusalCode } from '@forge/contracts/issues';
import type { OutboxActor } from '@forge/contracts/outbox-events';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { repoPullRequestIssues, repoPullRequests } from '../db/schema-repo-projection.js';
import { logger } from '../lib/logger.js';
import { insertActivityRow } from './activity-log.js';
import { heldIssuePrefixes, issueRefFormatter } from './issue-prefix-read.js';
import { observedMergesForIssue } from './merge-record.js';
import {
  declaredIssueSeqs,
  type HostCommit,
  isSourceHostUnavailable,
  issueRefPattern,
  readLandingBranches,
  resolveSourceHost,
  subjectOf,
} from './ports.js';

export type MergeIdentity =
  | { holds: true; by: 'subject' | 'change-request' }
  | { holds: false; code: CommitLandingRefusalCode; detail: string };

/** The activity a refused stamp writes on the issue it would have stamped. */
export const MERGE_STAMP_REFUSED = 'issue.mergeStampRefused';

const GITLAB_REQUEST = /See merge request \S*?!(\d+)/g;
const GITHUB_MERGE = /^Merge pull request #(\d+)\b/;
const GITHUB_SQUASH_TAIL = /\(#(\d+)\)\s*$/;

/** The change requests a merge commit says it merged: GitLab's trailer, GitHub's merge or squash subject. */
export function changeRequestsNamed(message: string): number[] {
  const subject = subjectOf(message);
  const named = [
    ...[...message.matchAll(GITLAB_REQUEST)].map((m) => Number(m[1])),
    Number(GITHUB_MERGE.exec(subject)?.[1] ?? Number.NaN),
    Number(GITHUB_SQUASH_TAIL.exec(subject)?.[1] ?? Number.NaN),
  ];
  return [...new Set(named.filter((n) => Number.isInteger(n) && n > 0))];
}

type CommitRead = { read: HostCommit } | { refused: MergeIdentity & { holds: false } };

async function readCommitOnce(projectId: string, sha: string): Promise<CommitRead> {
  const unverified = (why: string): CommitRead => ({
    refused: {
      holds: false,
      code: 'COMMIT_UNVERIFIED',
      detail: `commit ${sha} could not be read from this project's repository, so whose landing it is was not checked and nothing is stamped from it: ${why}`,
    },
  });
  let host: Awaited<ReturnType<typeof resolveSourceHost>>;
  try {
    host = await resolveSourceHost(projectId, 'kernel');
  } catch (err) {
    if (isSourceHostUnavailable(err)) return unverified(err.message);
    throw err;
  }
  let read: HostCommit | null;
  try {
    read = await host.readCommit(sha);
  } catch (err) {
    return unverified(err instanceof Error ? err.message : String(err));
  }
  if (read) return { read };
  return {
    refused: {
      holds: false,
      code: 'COMMIT_NOT_IN_REPOSITORY',
      detail: `commit ${sha} is not an object in ${host.fullName}, so it is nobody's landing`,
    },
  };
}

/** Whether any of the project's requests numbered `numbers` (or the one Forge merged) links the issue. */
async function linkedThrough(
  issueId: string,
  where: { projectId: string; numbers: number[] } | { pullRequestId: string },
): Promise<boolean> {
  if ('numbers' in where && where.numbers.length === 0) return false;
  const [hit] = await db
    .select({ id: repoPullRequestIssues.issueId })
    .from(repoPullRequestIssues)
    .innerJoin(repoPullRequests, eq(repoPullRequests.id, repoPullRequestIssues.pullRequestId))
    .where(
      and(
        eq(repoPullRequestIssues.issueId, issueId),
        'pullRequestId' in where
          ? eq(repoPullRequests.id, where.pullRequestId)
          : and(
              eq(repoPullRequests.projectId, where.projectId),
              inArray(repoPullRequests.number, where.numbers),
            ),
      ),
    )
    .limit(1);
  return hit !== undefined;
}

/**
 * The judge of one merge commit for each issue a change request would stamp from it, reading the
 * commit from the host at most once. `mergedRequestId` is the stored request Forge merged itself.
 */
export function mergeIdentityOf(args: {
  projectId: string;
  commitSha: string;
  mergedRequestId?: string | null;
}): (issueId: string) => Promise<MergeIdentity> {
  let commit: Promise<CommitRead> | null = null;
  let context: Promise<{ base: string; pattern: RegExp; ref: (n: number) => string }> | null = null;
  return async (issueId) => {
    if (
      args.mergedRequestId &&
      (await linkedThrough(issueId, { pullRequestId: args.mergedRequestId }))
    ) {
      return { holds: true, by: 'change-request' };
    }
    commit ??= readCommitOnce(args.projectId, args.commitSha);
    const got = await commit;
    if ('refused' in got) return got.refused;
    context ??= (async () => ({
      base: (await readLandingBranches(args.projectId)).defaultBranch ?? '',
      pattern: issueRefPattern(await heldIssuePrefixes(args.projectId)),
      ref: await issueRefFormatter(args.projectId),
    }))();
    const { base, pattern, ref } = await context;
    const [row] = await db
      .select({ issSeq: issues.issSeq })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    const seq = row?.issSeq ?? null;
    if (seq !== null && declaredIssueSeqs(got.read.message, pattern, base).includes(seq)) {
      return { holds: true, by: 'subject' };
    }
    const named = changeRequestsNamed(got.read.message);
    if (await linkedThrough(issueId, { projectId: args.projectId, numbers: named })) {
      return { holds: true, by: 'change-request' };
    }
    const key = seq === null ? `issue ${issueId}` : ref(seq);
    const through =
      named.length === 0
        ? 'and it names no change request'
        : `and no change request it names (${named.map((n) => `#${n}`).join(', ')}) delivers ${key}`;
    return {
      holds: false,
      code: 'COMMIT_NOT_THIS_ISSUE',
      detail: `commit ${got.read.sha} is not ${key}'s landing: its subject "${subjectOf(got.read.message)}" does not declare ${key}, ${through}. A link to ${key} on a request that did not land this commit is not its merge`,
    };
  };
}

/**
 * Record on the issue that a merge was refused as its stamp, in the caller's transaction: the
 * commit, the branch, the route it came by and why. Never silent, and never a stamp.
 */
export async function recordRefusedStamp(
  tx: Tx,
  args: {
    issueId: string;
    actor: OutboxActor;
    commitSha: string;
    target: string | null;
    via: string;
    refusal: Extract<MergeIdentity, { holds: false }>;
  },
): Promise<void> {
  logger.warn(
    { issueId: args.issueId, commitSha: args.commitSha, code: args.refusal.code, via: args.via },
    'merge stamp refused: the commit is not this issue’s landing',
  );
  await insertActivityRow(
    {
      issueId: args.issueId,
      actorType: args.actor.type,
      actorId: args.actor.id,
      actorAgency: args.actor.agency,
      action: MERGE_STAMP_REFUSED,
      payload: {
        commitSha: args.commitSha,
        target: args.target,
        via: args.via,
        code: args.refusal.code,
        detail: args.refusal.detail,
      },
    },
    tx,
  );
}

/**
 * The latest host merge of a request linking the issue whose commit is the issue's landing, or null.
 * A sibling request the host marked merged at another request's commit is passed over, so a mark
 * resting on the issue's own merge is never put back to that commit.
 */
export async function identifiedMergeForIssue(
  issueId: string,
  base?: string,
): Promise<{ commitSha: string; mergedAt: Date; target: string } | null> {
  const merges = await observedMergesForIssue(db, issueId, base);
  if (merges.length === 0) return null;
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return null;
  for (const merge of merges) {
    const identity = await mergeIdentityOf({
      projectId: row.projectId,
      commitSha: merge.commitSha,
    })(issueId);
    if (identity.holds) return merge;
  }
  return null;
}
